import {
  coerceValue, FIELD_TYPE_LABELS, FIELD_TYPES, sanitizeFieldDef,
  type Entity, type FieldDef, type FieldType,
} from '../world/model.ts';
import type { WorldService } from '../world/WorldService.ts';
import { esc } from './worldEditor.ts';

export type ManagerTab = 'world' | 'stars' | 'tags' | 'fields' | 'worlds';
const TABS: Array<[ManagerTab, string]> = [
  ['world', 'Mundo'], ['stars', 'Estrelas'], ['tags', 'Etiquetas'], ['fields', 'Campos'], ['worlds', 'Mundos'],
];

/** Side-panel view to manage the active world and the list of worlds. */
export class WorldManager {
  tab: ManagerTab = 'world';
  private self = false;
  private armed: string | null = null; // two-step destructive actions: key of the armed button
  private pendingType: { id: string; type: FieldType; lost: number } | null = null;
  private starFilter = '';
  private svc: WorldService;
  private root: HTMLElement;
  visible = false;
  onClose: () => void = () => {};
  onExport: () => void = () => {};
  onImport: () => void = () => {};
  onOpenEntity: (e: Entity) => void = () => {};

  constructor(root: HTMLElement, svc: WorldService) {
    this.root = root;
    this.svc = svc;
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onChange(e));
    root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (e.key !== 'Enter') return;
      if (t.dataset.m === 'new-tag') this.click('add-tag');
      if (t.dataset.m === 'new-field') this.click('add-field');
      if (t.dataset.m === 'new-world') this.click('add-world');
      if (t.dataset.m === 'new-opt') this.addOption(t);
    });
    svc.on((ev) => {
      if (!this.visible || ev.type === 'saved') return;
      if (this.self && (ev.type === 'meta' || ev.type === 'entities' || ev.type === 'worlds')) return;
      this.render();
    });
  }

  show(tab?: ManagerTab): void {
    if (tab) this.tab = tab;
    this.visible = true;
    this.armed = null;
    this.pendingType = null;
    this.render();
  }

  hide(): void {
    this.visible = false;
  }

  private click(action: string): void {
    this.root.querySelector<HTMLElement>(`[data-m="${action}"]`)?.click();
  }

  private silent(fn: () => void): void {
    this.self = true;
    try {
      fn();
    } finally {
      this.self = false;
    }
  }

  render(): void {
    const w = this.svc.active;
    if (!w) return;
    let h = `<div class="m-head"><h2 class="w-title">${esc(w.name)}</h2><button class="icon" data-m="close" title="Fechar">✕</button></div>`;
    h += `<div class="m-tabs">${TABS.map(([k, l]) => `<button class="${this.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>`;
    h += `<div class="m-body">${this.body()}</div>`;
    this.root.innerHTML = h;
    if (this.tab === 'world') void this.fillStorage();
  }

  private body(): string {
    const w = this.svc.active!;
    switch (this.tab) {
      case 'world': {
        const n = this.svc.entities.size, orphans = this.svc.orphans.size;
        return `
          <label class="w-lbl">Nome<input class="w-in" data-m="name" value="${esc(w.name)}" maxlength="80"></label>
          <label class="w-lbl">Descrição<textarea class="w-in w-ta" data-m="description" rows="4" placeholder="Premissa, era, tom…">${esc(w.description)}</textarea></label>
          <h3>Resumo</h3><dl>
            <dt>Estrelas anotadas</dt><dd>${n}${orphans ? ` <span class="warn-t">(${orphans} órfã${orphans > 1 ? 's' : ''})</span>` : ''}</dd>
            <dt>Etiquetas</dt><dd>${w.tags.length}</dd><dt>Campos</dt><dd>${w.fields.length}</dd>
            <dt>Criado</dt><dd>${new Date(w.createdAt).toLocaleString('pt-BR')}</dd>
            <dt>Alterado</dt><dd>${new Date(w.updatedAt).toLocaleString('pt-BR')}</dd>
            <dt>Armazenamento</dt><dd class="m-storage">…</dd></dl>
          <div class="actions"><button class="primary" data-m="export">Exportar arquivo</button><button data-m="import">Importar…</button></div>
          <p class="note">Os dados do mundo ficam neste navegador (IndexedDB), separados do catálogo científico. Exporte periodicamente: limpar os dados do site apaga o mundo.</p>`;
      }
      case 'stars': {
        const q = this.starFilter.trim().toLowerCase();
        const tags = new Map(w.tags.map((t) => [t.id, t]));
        const list = [...this.svc.entities.values()]
          .filter((e) => !q || (e.name + ' ' + e.anchor?.label + ' ' + e.tags.map((t) => tags.get(t)?.name).join(' ')).toLowerCase().includes(q))
          .sort((a, b) => (a.name || a.anchor?.label || '').localeCompare(b.name || b.anchor?.label || '', 'pt-BR'));
        let h = `<input class="w-in" data-m="star-filter" placeholder="Filtrar por nome ou etiqueta" value="${esc(this.starFilter)}">`;
        if (!this.svc.entities.size) return h + '<p class="w-empty">Nenhuma estrela anotada. Selecione uma estrela e use “Anotar estrela”.</p>';
        h += `<ul class="m-list">${list.map((e) => {
          const orphan = this.svc.orphans.has(e.id);
          return `<li data-entity="${e.id}" class="${orphan ? 'orphan' : ''}" title="${orphan ? 'Estrela não encontrada no catálogo atual' : 'Ir para a estrela'}">
            <span class="m-dots">${e.tags.map((t) => tags.get(t)).filter(Boolean).map((t) => `<i style="background:${t!.color}" title="${esc(t!.name)}"></i>`).join('')}</span>
            <span class="m-name">${esc(e.name || '(sem nome)')}</span><span class="m-sub">${esc(e.anchor?.label ?? '')}${orphan ? ' · órfã' : ''}</span></li>`;
        }).join('')}</ul>`;
        return h + `<p class="u">${list.length} de ${this.svc.entities.size}</p>`;
      }
      case 'tags': {
        let h = '<ul class="m-rows">';
        for (const t of w.tags) {
          const n = this.svc.usage('tag', t.id);
          const k = `del-tag:${t.id}`;
          h += `<li><input type="color" value="${t.color}" data-tag-color="${t.id}" title="Cor">
            <input class="w-in" value="${esc(t.name)}" data-tag-name="${t.id}" maxlength="40">
            <span class="u">${n}×</span>
            <button class="w-danger${this.armed === k ? ' armed' : ''}" data-m="${k}">${this.armed === k ? (n ? `apagar de ${n}` : 'confirmar') : 'apagar'}</button></li>`;
        }
        h += '</ul>';
        if (!w.tags.length) h += '<p class="w-empty">Nenhuma etiqueta. Etiquetas classificam estrelas (ex.: colônia, ruínas, rota comercial) e dão cor aos marcadores.</p>';
        return h + `<div class="m-add"><input class="w-in" data-m="new-tag" placeholder="Nova etiqueta" maxlength="40"><button data-m="add-tag">Adicionar</button></div>`;
      }
      case 'fields': {
        let h = '<ul class="m-rows m-fields">';
        w.fields.forEach((f, i) => {
          const n = this.svc.usage('field', f.id);
          const k = `del-field:${f.id}`;
          const pt = this.pendingType?.id === f.id ? this.pendingType : null;
          h += `<li class="m-field">
            <div class="m-frow"><input class="w-in" value="${esc(f.label)}" data-field-label="${f.id}" maxlength="60">
              <select class="w-in" data-field-type="${f.id}">${FIELD_TYPES.map((t) => `<option value="${t}" ${t === (pt?.type ?? f.type) ? 'selected' : ''}>${FIELD_TYPE_LABELS[t]}</option>`).join('')}</select>
              <button class="icon" data-m="up:${f.id}" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
              <button class="icon" data-m="down:${f.id}" ${i === w.fields.length - 1 ? 'disabled' : ''} title="Descer">↓</button></div>
            ${pt ? `<div class="m-confirm">${pt.lost} valor${pt.lost > 1 ? 'es' : ''} não ${pt.lost > 1 ? 'cabem' : 'cabe'} no novo tipo e ${pt.lost > 1 ? 'serão perdidos' : 'será perdido'}.
              <button class="w-danger armed" data-m="type-ok">Converter</button><button data-m="type-cancel">Cancelar</button></div>` : ''}
            ${f.type === 'number' ? `<label class="m-unit">unidade <input class="w-in" value="${esc(f.unit)}" data-field-unit="${f.id}" maxlength="20" placeholder="ex.: bilhões, AU"></label>` : ''}
            ${f.type === 'select' || f.type === 'multiselect' ? this.optionsEditor(f) : ''}
            <div class="m-frow m-fmeta"><span class="u">${n} estrela${n === 1 ? '' : 's'} com valor</span>
              <button class="w-danger${this.armed === k ? ' armed' : ''}" data-m="${k}">${this.armed === k ? (n ? `apagar valores de ${n}` : 'confirmar') : 'apagar campo'}</button></div></li>`;
        });
        h += '</ul>';
        if (!w.fields.length) h += '<p class="w-empty">Nenhum campo. Campos são dados próprios do seu mundo para cada estrela (ex.: população, governo, classe do sistema).</p>';
        return h + `<div class="m-add"><input class="w-in" data-m="new-field" placeholder="Novo campo" maxlength="60">
          <select class="w-in" data-m="new-field-type">${FIELD_TYPES.map((t) => `<option value="${t}">${FIELD_TYPE_LABELS[t]}</option>`).join('')}</select>
          <button data-m="add-field">Adicionar</button></div>`;
      }
      case 'worlds': {
        let h = '<ul class="m-rows">';
        for (const x of this.svc.worlds) {
          const active = x.id === w.id;
          const k = `del-world:${x.id}`;
          h += `<li class="${active ? 'active' : ''}"><span class="m-name">${esc(x.name)}${active ? ' <span class="u">· ativo</span>' : ''}</span>
            ${active ? '' : `<button data-m="open:${x.id}">Abrir</button>`}
            <button data-m="dup:${x.id}">Duplicar</button>
            <button class="w-danger${this.armed === k ? ' armed' : ''}" data-m="${k}">${this.armed === k ? 'confirmar exclusão' : 'apagar'}</button></li>`;
        }
        h += '</ul>';
        return h + `<div class="m-add"><input class="w-in" data-m="new-world" placeholder="Nome do novo mundo" maxlength="80"><button data-m="add-world">Criar</button></div>
          <p class="note">Apagar um mundo remove todas as suas anotações deste navegador. Exporte antes se quiser guardar.</p>`;
      }
    }
  }

  private optionsEditor(f: FieldDef): string {
    return `<div class="m-opts">${f.options.map((o, i) => {
      const k = `del-opt:${f.id}:${i}`;
      const n = [...this.svc.entities.values()].filter((e) => {
        const v = e.fields[f.id];
        return Array.isArray(v) ? v.includes(o) : v === o;
      }).length;
      return `<span class="m-opt"><input class="w-in" value="${esc(o)}" data-opt-field="${f.id}" data-opt-i="${i}" maxlength="40">
        <button class="icon${this.armed === k ? ' armed' : ''}" data-m="${k}" title="${n ? `Remover (usada em ${n})` : 'Remover'}">${this.armed === k ? '!' : '×'}</button></span>`;
    }).join('')}
      <input class="w-in m-newopt" data-m="new-opt" data-field="${f.id}" placeholder="+ opção" maxlength="40"></div>`;
  }

  private async fillStorage(): Promise<void> {
    const el = this.root.querySelector('.m-storage');
    if (!el) return;
    if (!this.svc.repo.persistent) {
      el.innerHTML = '<span class="warn-t">indisponível — dados só nesta sessão</span>';
      return;
    }
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    el.textContent = `IndexedDB${persisted ? ' · persistente' : ' · pode ser limpo pelo navegador'}${est?.usage ? ` · ${(est.usage / 1048576).toFixed(1)} MB usados` : ''}`;
  }

  // ---------------------------------------------------------------- events

  private onInput(ev: Event): void {
    const t = ev.target as HTMLInputElement;
    if (t.tagName === 'TEXTAREA') {
      t.style.height = 'auto';
      t.style.height = `${Math.min(t.scrollHeight + 2, 320)}px`;
    }
    const m = t.dataset.m;
    if (m === 'name') this.silent(() => this.svc.updateWorld({ name: t.value }));
    else if (m === 'description') this.silent(() => this.svc.updateWorld({ description: t.value }));
    else if (m === 'star-filter') {
      this.starFilter = t.value;
      const pos = t.selectionStart;
      this.render();
      const n = this.root.querySelector<HTMLInputElement>('[data-m=star-filter]')!;
      n.focus();
      n.setSelectionRange(pos, pos);
    } else if (t.dataset.tagName) this.silent(() => this.svc.updateTag(t.dataset.tagName!, { name: t.value }));
    else if (t.dataset.fieldLabel) this.silent(() => this.svc.updateField(t.dataset.fieldLabel!, { label: t.value }));
    else if (t.dataset.fieldUnit) this.silent(() => this.svc.updateField(t.dataset.fieldUnit!, { unit: t.value }));
  }

  private onChange(ev: Event): void {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.tagColor) this.svc.updateTag(t.dataset.tagColor, { color: t.value });
    else if (t.dataset.fieldType) this.requestType(t.dataset.fieldType, t.value as FieldType);
    else if (t.dataset.optField) this.renameOption(t.dataset.optField, +t.dataset.optI!, t.value);
    else if (t.dataset.tagName || t.dataset.fieldLabel) this.render(); // normalise empty names
  }

  private requestType(id: string, type: FieldType): void {
    const def = this.svc.active?.fields.find((f) => f.id === id);
    if (!def || def.type === type) return;
    const next = sanitizeFieldDef({ ...def, type }, new Set());
    let lost = 0;
    for (const e of this.svc.entities.values()) if (id in e.fields && coerceValue(next, e.fields[id]) === undefined) lost++;
    if (lost) {
      this.pendingType = { id, type, lost };
      this.render();
    } else this.svc.updateField(id, { type });
  }

  private renameOption(fieldId: string, i: number, value: string): void {
    const def = this.svc.active?.fields.find((f) => f.id === fieldId);
    if (!def) return;
    const v = value.trim();
    const old = def.options[i];
    if (!v || v === old || def.options.includes(v)) return this.render();
    const options = def.options.map((o, k) => (k === i ? v : o));
    this.svc.updateField(fieldId, { options }, { [old]: v });
  }

  private addOption(input: HTMLInputElement): void {
    const def = this.svc.active?.fields.find((f) => f.id === input.dataset.field);
    const v = input.value.trim();
    if (!def || !v || def.options.includes(v)) return;
    this.svc.updateField(def.id, { options: [...def.options, v] });
    this.root.querySelector<HTMLInputElement>(`[data-m=new-opt][data-field="${def.id}"]`)?.focus();
  }

  private onClick(ev: Event): void {
    const el = ev.target as HTMLElement;
    const tab = el.closest<HTMLElement>('[data-tab]')?.dataset.tab as ManagerTab | undefined;
    if (tab) {
      this.tab = tab;
      this.armed = null;
      this.pendingType = null;
      return this.render();
    }
    const li = el.closest<HTMLElement>('[data-entity]');
    if (li) {
      const e = this.svc.entities.get(li.dataset.entity!);
      if (e) this.onOpenEntity(e);
      return;
    }
    const m = el.closest<HTMLElement>('[data-m]')?.dataset.m;
    if (!m || el.closest('input,select,textarea')) return;
    // "action:id" — ids themselves contain colons (t:…, f:…, world:…); options add ":index"
    const cut = m.indexOf(':');
    const action = cut < 0 ? m : m.slice(0, cut);
    let id = cut < 0 ? '' : m.slice(cut + 1), extra = '';
    if (action === 'del-opt') {
      extra = id.slice(id.lastIndexOf(':') + 1);
      id = id.slice(0, id.lastIndexOf(':'));
    }

    // two-step destructive actions
    if (action.startsWith('del-')) {
      if (this.armed !== m) {
        this.armed = m;
        return this.render();
      }
      this.armed = null;
      if (action === 'del-tag') this.svc.deleteTag(id);
      if (action === 'del-field') this.svc.deleteField(id);
      if (action === 'del-world') void this.svc.deleteWorld(id);
      if (action === 'del-opt') {
        const def = this.svc.active?.fields.find((f) => f.id === id);
        if (def) this.svc.updateField(id, { options: def.options.filter((_, k) => k !== +extra) });
      }
      return;
    }
    this.armed = null;
    switch (action) {
      case 'close': return this.onClose();
      case 'export': return this.onExport();
      case 'import': return this.onImport();
      case 'add-tag': {
        const inp = this.root.querySelector<HTMLInputElement>('[data-m=new-tag]')!;
        if (!inp.value.trim()) return inp.focus();
        this.svc.addTag(inp.value);
        this.root.querySelector<HTMLInputElement>('[data-m=new-tag]')?.focus();
        return;
      }
      case 'add-field': {
        const inp = this.root.querySelector<HTMLInputElement>('[data-m=new-field]')!;
        const type = this.root.querySelector<HTMLSelectElement>('[data-m=new-field-type]')!.value as FieldType;
        if (!inp.value.trim()) return inp.focus();
        this.svc.addField({ label: inp.value, type });
        return;
      }
      case 'add-world': {
        const inp = this.root.querySelector<HTMLInputElement>('[data-m=new-world]')!;
        if (!inp.value.trim()) return inp.focus();
        this.tab = 'world';
        void this.svc.createWorld(inp.value);
        return;
      }
      case 'open': return void this.svc.setActive(id);
      case 'dup': return void this.svc.duplicateWorld(id);
      case 'up': return this.svc.moveField(id, -1);
      case 'down': return this.svc.moveField(id, 1);
      case 'type-ok':
        if (this.pendingType) this.svc.updateField(this.pendingType.id, { type: this.pendingType.type });
        this.pendingType = null;
        return this.render();
      case 'type-cancel':
        this.pendingType = null;
        return this.render();
    }
  }
}

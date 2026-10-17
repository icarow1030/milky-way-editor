import type { StarMeta } from '../core/format.ts';
import { starIds } from '../core/format.ts';
import { AUTHORIAL_COLOR, type Entity, type FieldDef, type StarAnchor } from '../world/model.ts';
import type { WorldService } from '../world/WorldService.ts';

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface EditorTarget {
  index: number;
  meta: StarMeta;
  label: string; // catalogue designation shown for orphans and in lists
}

/**
 * "No seu mundo" section of the star panel. Owns its DOM; it re-renders only for changes that
 * did not originate from its own inputs, so typing never loses focus.
 */
export class WorldStarEditor {
  private target: EditorTarget | null = null;
  private self = false;
  private confirmRemove = false;
  private svc: WorldService;
  private root: HTMLElement;
  private catalogBuild: () => string;
  onManage: (tab: string) => void = () => {};
  onTitleChange: () => void = () => {};

  constructor(root: HTMLElement, svc: WorldService, catalogBuild: () => string) {
    this.root = root;
    this.svc = svc;
    this.catalogBuild = catalogBuild;
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onInput(e));
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.w === 'newtag' && e.key === 'Enter') this.addTag(t);
    });
    svc.on((ev) => {
      if (!this.target) return;
      if (ev.type === 'saved' || ev.type === 'error') return this.renderStatus(ev.type === 'error' ? ev.message : null);
      if (ev.type === 'entities' && this.self) return;
      if (ev.type === 'worlds') return;
      this.render();
    });
  }

  show(target: EditorTarget | null): void {
    this.target = target;
    this.confirmRemove = false;
    this.render();
  }

  private get entity(): Entity | undefined {
    return this.target ? this.svc.entityForStar(this.target.index) : undefined;
  }

  private render(): void {
    const w = this.svc.active;
    if (!this.target || !w) {
      this.root.innerHTML = '';
      return;
    }
    const e = this.entity;
    let h = `<h3 class="w-h">No seu mundo <span class="w-world" title="Mundo ativo">${esc(w.name)}</span></h3>`;
    if (!e) {
      h += `<p class="w-empty">Esta estrela ainda não tem dados neste mundo.</p>
        <button class="w-primary" data-w="annotate">Anotar estrela</button>`;
      this.root.innerHTML = h;
      return;
    }
    h += `<label class="w-lbl">Nome no universo<input class="w-in" data-w="name" value="${esc(e.name)}" placeholder="${esc(this.target.label)}" maxlength="120"></label>`;
    h += `<label class="w-lbl">Descrição<textarea class="w-in w-ta" data-w="description" rows="3" placeholder="Notas, história, contexto…">${esc(e.description)}</textarea></label>`;

    h += '<div class="w-lbl">Etiquetas</div><div class="w-tags">';
    for (const t of w.tags) {
      const on = e.tags.includes(t.id);
      h += `<button class="w-tag${on ? ' on' : ''}" data-tag="${t.id}" style="--c:${t.color}"><i></i>${esc(t.name)}</button>`;
    }
    h += `<input class="w-newtag" data-w="newtag" placeholder="+ nova etiqueta" maxlength="40"></div>`;

    const fields = w.fields.filter((f) => f.kinds.includes('star'));
    h += `<div class="w-lbl w-fh">Campos <button class="lnk" data-w="manage-fields">gerenciar</button></div>`;
    if (!fields.length) h += '<p class="w-empty">Nenhum campo definido neste mundo.</p>';
    else h += `<div class="w-fields">${fields.map((f) => fieldInput(f, e.fields[f.id])).join('')}</div>`;

    h += `<div class="w-foot"><span class="w-status"></span>
      <button class="w-danger${this.confirmRemove ? ' armed' : ''}" data-w="remove">${this.confirmRemove ? 'Confirmar remoção' : 'Remover anotação'}</button></div>`;
    this.root.innerHTML = h;
    this.renderStatus(null);
    for (const ta of this.root.querySelectorAll<HTMLTextAreaElement>('textarea')) autosize(ta);
  }

  private renderStatus(error: string | null): void {
    const s = this.root.querySelector('.w-status');
    if (!s) return;
    s.classList.toggle('err', !!error);
    s.textContent = error ?? (this.svc.dirty ? 'salvando…' : this.svc.repo.persistent ? 'salvo' : 'salvo só nesta sessão');
  }

  private edit(fn: (e: Entity) => void): void {
    const e = this.entity;
    if (!e) return;
    this.self = true;
    try {
      fn(e);
    } finally {
      this.self = false;
    }
    this.renderStatus(null);
  }

  private onInput(ev: Event): void {
    const t = ev.target as HTMLInputElement;
    if (t.tagName === 'TEXTAREA') autosize(t as unknown as HTMLTextAreaElement);
    const k = t.dataset.w;
    if (k === 'name' && ev.type === 'input') {
      this.edit((e) => this.svc.updateEntity(e.id, { name: t.value }));
      this.onTitleChange();
    } else if (k === 'description' && ev.type === 'input') {
      this.edit((e) => this.svc.updateEntity(e.id, { description: t.value }));
    } else if (t.dataset.field) {
      const def = this.svc.active?.fields.find((f) => f.id === t.dataset.field);
      if (!def) return;
      // text-like inputs save as you type; selects/checkbox-like on change
      const live = def.type === 'text' || def.type === 'longtext' || def.type === 'number';
      if (live !== (ev.type === 'input')) return;
      const v = def.type === 'bool' ? (t.value === '' ? undefined : t.value === 'true') : t.value;
      this.edit((e) => this.svc.updateEntity(e.id, { fields: { [def.id]: v } }));
    }
  }

  private onClick(ev: Event): void {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-w],[data-tag],[data-opt]');
    if (!b || !this.target) return;
    if (b.dataset.w === 'annotate') {
      const m = this.target.meta;
      const anchor: StarAnchor = {
        ids: starIds(m), catalogBuild: this.catalogBuild(), index: this.target.index,
        ra: m.ra, dec: m.dec, dist: m.dist, label: this.target.label,
      };
      this.svc.annotate(anchor);
      void navigator.storage?.persist?.();
      this.root.querySelector<HTMLInputElement>('[data-w=name]')?.focus();
      return;
    }
    if (b.dataset.w === 'remove') {
      if (!this.confirmRemove) {
        this.confirmRemove = true;
        b.classList.add('armed');
        b.textContent = 'Confirmar remoção';
        return;
      }
      const e = this.entity;
      this.confirmRemove = false;
      if (e) this.svc.removeEntity(e.id);
      this.onTitleChange();
      return;
    }
    if (b.dataset.w === 'manage-fields') return this.onManage('fields');
    if (b.dataset.tag) {
      const id = b.dataset.tag;
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      this.edit((e) => this.svc.updateEntity(e.id, { tags: on ? [...e.tags, id] : e.tags.filter((x) => x !== id) }));
      return;
    }
    if (b.dataset.opt !== undefined) {
      const def = this.svc.active?.fields.find((f) => f.id === b.dataset.field);
      if (!def) return;
      b.classList.toggle('on');
      const vals = [...this.root.querySelectorAll<HTMLElement>(`[data-field="${def.id}"][data-opt].on`)].map((x) => x.dataset.opt!);
      this.edit((e) => this.svc.updateEntity(e.id, { fields: { [def.id]: vals } }));
    }
  }

  private addTag(input: HTMLInputElement): void {
    const name = input.value.trim();
    const e = this.entity;
    if (!name || !e || !this.svc.active) return;
    const existing = this.svc.active.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const tag = existing ?? this.svc.addTag(name);
    if (!e.tags.includes(tag.id)) this.svc.updateEntity(e.id, { tags: [...e.tags, tag.id] });
    this.render();
    this.root.querySelector<HTMLInputElement>('[data-w=newtag]')?.focus();
  }
}

function fieldInput(f: FieldDef, v: unknown): string {
  const id = `data-field="${f.id}"`;
  const label = `<span>${esc(f.label)}${f.unit ? ` <span class="u">${esc(f.unit)}</span>` : ''}</span>`;
  switch (f.type) {
    case 'text':
      return `<label class="w-f">${label}<input class="w-in" ${id} value="${esc(String(v ?? ''))}"></label>`;
    case 'longtext':
      return `<label class="w-f w-f-wide">${label}<textarea class="w-in w-ta" ${id} rows="2">${esc(String(v ?? ''))}</textarea></label>`;
    case 'number':
      return `<label class="w-f">${label}<input class="w-in" type="number" step="any" ${id} value="${v ?? ''}"></label>`;
    case 'bool':
      return `<label class="w-f">${label}<select class="w-in" ${id}>
        <option value="" ${v === undefined ? 'selected' : ''}>—</option>
        <option value="true" ${v === true ? 'selected' : ''}>sim</option>
        <option value="false" ${v === false ? 'selected' : ''}>não</option></select></label>`;
    case 'select':
      return `<label class="w-f">${label}<select class="w-in" ${id}><option value="">—</option>${f.options
        .map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    case 'multiselect': {
      const vals = Array.isArray(v) ? v : [];
      return `<div class="w-f w-f-wide">${label}<div class="w-opts">${f.options
        .map((o) => `<button class="chip${vals.includes(o) ? ' on' : ''}" ${id} data-opt="${esc(o)}">${esc(o)}</button>`).join('')
        || '<span class="u">sem opções — edite o campo</span>'}</div></div>`;
    }
  }
}

function autosize(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`;
}

export { AUTHORIAL_COLOR };

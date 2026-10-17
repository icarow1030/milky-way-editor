import { parseWorldFile, WorldFileError, type Entity } from '../world/model.ts';
import type { WorldService } from '../world/WorldService.ts';
import { esc } from './worldEditor.ts';

/** Small transient message over the viewport. */
export class Toast {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private el: HTMLElement;
  constructor(el: HTMLElement) {
    this.el = el;
  }
  show(msg: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
    this.el.textContent = msg;
    this.el.className = kind;
    this.el.hidden = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.el.hidden = true), ms);
  }
}

/** Toolbar world selector + import/export plumbing shared with the manager. */
export class WorldMenu {
  private open = false;
  private svc: WorldService;
  private btn: HTMLElement;
  private drop: HTMLElement;
  private file: HTMLInputElement;
  private toast: Toast;
  private pendingImport: unknown = null;
  onManage: () => void = () => {};

  constructor(svc: WorldService, btn: HTMLElement, drop: HTMLElement, file: HTMLInputElement, toast: Toast) {
    this.svc = svc;
    this.btn = btn;
    this.drop = drop;
    this.file = file;
    this.toast = toast;
    btn.addEventListener('click', () => this.setOpen(!this.open));
    document.addEventListener('mousedown', (e) => {
      if (this.open && !(e.target as HTMLElement).closest('.world-menu')) this.setOpen(false);
    });
    drop.addEventListener('click', (e) => this.onClick(e));
    drop.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.d === 'new-name' && e.key === 'Enter') void this.create(t.value);
      if (e.key === 'Escape') this.setOpen(false);
    });
    file.addEventListener('change', () => void this.readFile());
    svc.on((e) => {
      if (e.type === 'worlds' || e.type === 'active' || e.type === 'meta') this.refresh();
      if (e.type === 'error') toast.show(e.message, 'error', 6000);
    });
  }

  refresh(): void {
    const name = this.svc.active?.name ?? '…';
    const label = this.btn.querySelector('#world-name');
    if (label && label.textContent !== name) label.textContent = name;
    if (this.open) this.render();
  }

  private setOpen(v: boolean): void {
    this.open = v;
    this.drop.hidden = !v;
    this.btn.classList.toggle('open', v);
    if (v) this.render();
    else this.pendingImport = null;
  }

  private render(): void {
    const a = this.svc.active;
    let h = '<div class="d-sec">Mundos</div><ul class="d-list">';
    for (const w of this.svc.worlds) {
      h += `<li data-world="${w.id}" class="${w.id === a?.id ? 'on' : ''}" title="${w.id === a?.id ? 'Abrir o gerenciador deste mundo' : 'Ativar este mundo'}"><span>${esc(w.name)}</span>${w.id === a?.id ? '<span class="u">ativo · abrir</span>' : ''}</li>`;
    }
    h += '</ul>';
    if (this.pendingImport) {
      const f = this.pendingImport as { world: { name: string } };
      h += `<div class="d-confirm">Já existe um mundo igual a “${esc(f.world.name)}”.
        <button class="w-danger armed" data-d="imp-replace">Substituir</button><button data-d="imp-copy">Importar como cópia</button><button data-d="imp-cancel">Cancelar</button></div>`;
    }
    h += `<div class="d-new"><input class="w-in" data-d="new-name" placeholder="Novo mundo…" maxlength="80"><button data-d="new">Criar</button></div>
      <div class="d-actions"><button data-d="manage">Gerenciar mundo <span class="kbd">M</span></button><button data-d="export">Exportar</button><button data-d="import">Importar…</button></div>`;
    this.drop.innerHTML = h;
  }

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const li = t.closest<HTMLElement>('[data-world]');
    if (li) {
      // the active world opens its manager; another world becomes active
      if (li.dataset.world === this.svc.active?.id) {
        this.setOpen(false);
        this.onManage();
      } else void this.svc.setActive(li.dataset.world!).then(() => this.setOpen(false));
      return;
    }
    const d = t.closest<HTMLElement>('[data-d]')?.dataset.d;
    if (!d || t.closest('input')) return;
    if (d === 'new') void this.create(this.drop.querySelector<HTMLInputElement>('[data-d=new-name]')!.value);
    if (d === 'manage') {
      this.setOpen(false);
      this.onManage();
    }
    if (d === 'export') void this.exportActive();
    if (d === 'import') this.pickFile();
    if (d === 'imp-replace' || d === 'imp-copy') void this.finishImport(d === 'imp-replace' ? 'replace' : 'copy');
    if (d === 'imp-cancel') {
      this.pendingImport = null;
      this.render();
    }
  }

  private async create(name: string): Promise<void> {
    if (!name.trim()) return;
    const w = await this.svc.createWorld(name);
    this.setOpen(false);
    this.toast.show(`Mundo “${w.name}” criado e ativado.`);
  }

  async exportActive(): Promise<void> {
    try {
      const file = await this.svc.exportWorld();
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug(file.world.name)}.atlas-world.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.toast.show(`Exportado: ${file.entities.length} estrela(s) anotada(s).`);
    } catch (err) {
      this.toast.show(`Falha ao exportar: ${(err as Error).message}`, 'error');
    }
  }

  pickFile(): void {
    this.file.value = '';
    this.file.click();
  }

  private async readFile(): Promise<void> {
    const f = this.file.files?.[0];
    if (!f) return;
    try {
      const parsed = parseWorldFile(JSON.parse(await f.text()));
      if (this.svc.hasWorld(parsed.world.id)) {
        this.pendingImport = parsed;
        this.setOpen(true);
        return;
      }
      this.pendingImport = parsed;
      await this.finishImport('replace');
    } catch (err) {
      const msg = err instanceof WorldFileError ? err.message : err instanceof SyntaxError ? 'O arquivo não é um JSON válido.' : String((err as Error).message);
      this.toast.show(`Importação falhou: ${msg}`, 'error', 6000);
    }
  }

  private async finishImport(mode: 'replace' | 'copy'): Promise<void> {
    const raw = this.pendingImport;
    this.pendingImport = null;
    if (!raw) return;
    try {
      const w = await this.svc.importWorld(raw, mode);
      this.setOpen(false);
      this.toast.show(`Mundo “${w.name}” importado (${this.svc.entities.size} estrela(s)).`);
    } catch (err) {
      this.toast.show(`Importação falhou: ${(err as Error).message}`, 'error', 6000);
    }
  }
}

/** World entities matching a search query (authorial names and tag names). */
export function searchWorld(svc: WorldService, q: string, limit = 8): Array<{ entity: Entity; label: string; key: string }> {
  const n = norm(q);
  if (!n || !svc.active) return [];
  const tags = new Map(svc.active.tags.map((t) => [t.id, t.name]));
  const out: Array<{ entity: Entity; label: string; key: string; s: number }> = [];
  for (const e of svc.entities.values()) {
    if (svc.orphans.has(e.id)) continue;
    const name = norm(e.name);
    const tagNames = e.tags.map((t) => tags.get(t) ?? '');
    let s = -1;
    if (name && name.startsWith(n)) s = 0;
    else if (name && name.includes(n)) s = 1;
    else if (tagNames.some((t) => norm(t).startsWith(n))) s = 2;
    if (s < 0) continue;
    out.push({ entity: e, label: e.name || e.anchor?.label || '(sem nome)', key: `mundo · ${tagNames.filter(Boolean).join(', ') || e.anchor?.label || ''}`, s });
  }
  return out.sort((a, b) => a.s - b.s || a.label.localeCompare(b.label, 'pt-BR')).slice(0, limit);
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_\-.]+/g, '');
const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '') || 'mundo';

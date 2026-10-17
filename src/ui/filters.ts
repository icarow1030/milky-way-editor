import { CLASS_LABELS, CLASS_TITLES, LUM_LABELS, LUM_TITLES, SpecClass as C, LumClass as L } from '../core/spectral.ts';
import { ABSMAG_RANGE, COLOR_RANGE, defaultFilter, filterActive, type FilterStats, type StarFilter } from '../render/StarLayer.ts';

/** Class chips in display order (SpecClass codes). */
const CLASS_ORDER = [C.O, C.B, C.A, C.F, C.G, C.K, C.M, C.LT, C.WD, C.Carbon, C.Unknown];
const LUM_ORDER = [L.I, L.II, L.III, L.IV, L.V, L.VI, L.WD, L.Unknown];

const bits = (...codes: number[]) => codes.reduce((m, c) => m | (1 << c), 0);
const ALL_CLASSES = 0x7ff, ALL_LUM = 0xff;

const PRESETS: Array<{ name: string; title: string; f: Partial<StarFilter> }> = [
  { name: 'OB jovens', title: 'Estrelas O e B: traçam associações jovens e braços espirais', f: { classMask: bits(C.O, C.B) } },
  { name: 'Tipo solar', title: 'Anãs G (sequência principal)', f: { classMask: bits(C.G), lumMask: bits(L.V) } },
  { name: 'Anãs M', title: 'Anãs vermelhas: a maioria das estrelas da vizinhança', f: { classMask: bits(C.M), lumMask: bits(L.V, L.VI) } },
  { name: 'Gigantes', title: 'Classes de luminosidade I, II e III', f: { lumMask: bits(L.I, L.II, L.III) } },
  { name: 'Anãs brancas', title: 'Remanescentes estelares (classe D)', f: { classMask: bits(C.WD), lumMask: bits(L.WD, L.Unknown) } },
  { name: 'Luminosas', title: 'M ≤ −3: visíveis a kpc de distância', f: { mMax: -3 } },
];

export class FilterPanel {
  private f: StarFilter;
  private el: HTMLElement;
  private stats: FilterStats | null = null;

  constructor(root: HTMLElement, initial: StarFilter, private onChange: (f: StarFilter) => void) {
    this.f = { ...defaultFilter(), ...initial };
    this.el = root;
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    this.render();
  }

  get value(): StarFilter {
    return { ...this.f };
  }

  private emit(rerender = true): void {
    this.onChange({ ...this.f });
    if (rerender) this.render();
  }

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-cls],[data-lum],[data-prov],[data-mode],[data-preset],[data-act]');
    if (!t) return;
    const d = t.dataset;
    if (d.cls !== undefined) this.f.classMask = toggle(this.f.classMask, +d.cls, (e as MouseEvent).altKey, ALL_CLASSES);
    else if (d.lum !== undefined) this.f.lumMask = toggle(this.f.lumMask, +d.lum, (e as MouseEvent).altKey, ALL_LUM);
    else if (d.prov === 'cat') this.f.catalogued = !this.f.catalogued;
    else if (d.prov === 'est') this.f.estimated = !this.f.estimated;
    else if (d.mode) this.f.mode = d.mode as StarFilter['mode'];
    else if (d.preset !== undefined) this.f = { ...defaultFilter(), mode: this.f.mode, ...PRESETS[+d.preset].f };
    else if (d.act === 'reset') this.f = { ...defaultFilter(), mode: this.f.mode };
    else if (d.act === 'cls-all') this.f.classMask = ALL_CLASSES;
    else if (d.act === 'lum-all') this.f.lumMask = ALL_LUM;
    else return;
    this.emit();
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    const k = t.dataset.range as 'mMin' | 'mMax' | 'cMin' | 'cMax' | undefined;
    if (!k) return;
    let v = +t.value;
    if (k === 'mMin') v = Math.min(v, this.f.mMax);
    if (k === 'mMax') v = Math.max(v, this.f.mMin);
    if (k === 'cMin') v = Math.min(v, this.f.cMax);
    if (k === 'cMax') v = Math.max(v, this.f.cMin);
    this.f[k] = v;
    t.value = String(v);
    this.updateReadouts();
    this.emit(false);
  }

  /** Called periodically with fresh counts over resident stars. */
  setStats(s: FilterStats): void {
    if (s === this.stats) return;
    this.stats = s;
    for (const el of this.el.querySelectorAll<HTMLElement>('[data-cls] .n')) el.textContent = fmtN(s.byClass[+el.parentElement!.dataset.cls!]);
    for (const el of this.el.querySelectorAll<HTMLElement>('[data-lum] .n')) el.textContent = fmtN(s.byLum[+el.parentElement!.dataset.lum!]);
    const sum = this.el.querySelector('.f-sum');
    if (sum) sum.innerHTML = `<b>${s.passing.toLocaleString('pt-BR')}</b> de ${s.total.toLocaleString('pt-BR')} estrelas residentes`;
  }

  private updateReadouts(): void {
    const set = (sel: string, v: string) => { const e = this.el.querySelector(sel); if (e) e.textContent = v; };
    set('[data-out=m]', `${sign(this.f.mMin)} … ${sign(this.f.mMax)}`);
    set('[data-out=c]', `${sign(this.f.cMin, 2)} … ${sign(this.f.cMax, 2)}`);
    this.el.querySelector('.f-reset')?.toggleAttribute('disabled', !filterActive(this.f));
  }

  private render(): void {
    const f = this.f;
    const chip = (attr: string, code: number, label: string, title: string, on: boolean) =>
      `<button class="chip${on ? ' on' : ''}" data-${attr}="${code}" title="${title} (Alt+clique: somente esta)"><span>${label}</span><span class="n"></span></button>`;
    let h = '<div class="f-head"><span class="f-title">Filtros</span><span class="f-sum"></span></div>';
    h += '<div class="f-presets">' + PRESETS.map((p, i) => `<button data-preset="${i}" title="${p.title}">${p.name}</button>`).join('') + '</div>';
    h += `<div class="f-row"><span class="f-lbl">Classe espectral <button class="lnk" data-act="cls-all">todas</button></span><div class="chips">`
      + CLASS_ORDER.map((c) => chip('cls', c, CLASS_LABELS[c], CLASS_TITLES[c], !!((f.classMask >> c) & 1))).join('') + '</div></div>';
    h += `<div class="f-row"><span class="f-lbl">Luminosidade <button class="lnk" data-act="lum-all">todas</button></span><div class="chips">`
      + LUM_ORDER.map((c) => chip('lum', c, LUM_LABELS[c], LUM_TITLES[c], !!((f.lumMask >> c) & 1))).join('') + '</div></div>';
    h += `<div class="f-row"><span class="f-lbl">Origem do tipo</span><div class="chips">
      <button class="chip${f.catalogued ? ' on' : ''}" data-prov="cat" title="Tipo espectral catalogado (HYG)">catalogado</button>
      <button class="chip${f.estimated ? ' on' : ''}" data-prov="est" title="Estimado da cor e do diagrama HR (Gaia)">estimado</button></div></div>`;
    h += rangeRow('Magnitude absoluta', 'M<sub>G</sub> / M<sub>V</sub>', 'm', 'mMin', 'mMax', f.mMin, f.mMax, ABSMAG_RANGE, 0.25);
    h += rangeRow('Cor', 'BP−RP', 'c', 'cMin', 'cMax', f.cMin, f.cMax, COLOR_RANGE, 0.05);
    h += `<div class="f-foot"><div class="seg"><button class="${f.mode === 'hide' ? 'on' : ''}" data-mode="hide">ocultar</button><button class="${f.mode === 'dim' ? 'on' : ''}" data-mode="dim">esmaecer</button></div>
      <button class="f-reset" data-act="reset">limpar</button></div>`;
    h += '<div class="f-note">Tipos estimados vêm da cor BP−RP e da posição no diagrama HR, sem correção de extinção; sem classe de luminosidade quando RUWE &gt; 1,4. Estrelas intrinsecamente fracas só aparecem de perto: aumente a exposição para vê-las de longe.</div>';
    this.el.innerHTML = h;
    this.updateReadouts();
    if (this.stats) { const s = this.stats; this.stats = null; this.setStats(s); }
  }
}

function rangeRow(label: string, unit: string, out: string, kMin: string, kMax: string, vMin: number, vMax: number,
  [lo, hi]: [number, number], step: number): string {
  return `<div class="f-row"><span class="f-lbl">${label} <span class="u">${unit}</span><output data-out="${out}"></output></span>
    <div class="dual">
      <input type="range" data-range="${kMin}" min="${lo}" max="${hi}" step="${step}" value="${vMin}" />
      <input type="range" data-range="${kMax}" min="${lo}" max="${hi}" step="${step}" value="${vMax}" />
    </div></div>`;
}

function toggle(mask: number, code: number, solo: boolean, all: number): number {
  if (solo) return mask === 1 << code ? all : 1 << code;
  return mask ^ (1 << code);
}
const sign = (v: number, d = 1) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

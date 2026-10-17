import * as THREE from 'three';
import { SUN_GC, formatDistance, worldToGalactic, radecToWorld, AU_PER_PC, LY_PER_PC, type Vec3 } from './core/coords.ts';
import { CatalogStore } from './catalog/CatalogStore.ts';
import { StarLayer, apparentDelta } from './render/StarLayer.ts';
import { GalaxyLayer } from './render/GalaxyLayer.ts';
import { Grids, LabelLayer } from './render/Overlays.ts';
import { CameraController, type ViewState } from './nav/CameraController.ts';
import { StarSearch } from './ui/search.ts';
import { overviewPanel, starPanel, displayName } from './ui/panel.ts';
import { packAbsMag, rgbFromTemp, tempFromBV } from './core/photometry.ts';
import type { StarMeta } from './core/format.ts';
import { FilterPanel } from './ui/filters.ts';
import { defaultFilter, filterActive, type StarFilter } from './render/StarLayer.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ------------------------------------------------------------------ setup
const canvas = $<HTMLCanvasElement>('#gl');
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setClearColor(0x050608, 1);
const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(pixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1e-6, 1e7);

const MEMORY_BUDGET = 100 * 1024 * 1024; // all resident star data (CPU + GPU)
const store = new CatalogStore(40 * 1024 * 1024); // node payload cache; GPU mirrors it 1:1
const stars = new StarLayer(store);
const galaxy = new GalaxyLayer(400_000);
const grids = new Grids();
scene.add(galaxy.group, grids.group, stars.group);
const labels = new LabelLayer($('#labels'));
const ctl = new CameraController(camera, canvas);

const STORAGE_KEY = 'galactic-atlas:v1';
const DEFAULT_VIEW: ViewState = { target: [0, 0, 0], distance: 42000, yaw: Math.PI + 0.35, pitch: 0.95 };
const settings = {
  exposure: 0,
  layers: { catalog: true, procedural: true, grid: true, labels: true },
  filter: defaultFilter() as StarFilter,
  filterOpen: false,
};

function loadSaved(): void {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (s?.view?.target?.length === 3 && isFinite(s.view.distance)) ctl.setState(s.view);
    else ctl.setState(DEFAULT_VIEW);
    if (s?.settings) {
      Object.assign(settings.layers, s.settings.layers);
      settings.exposure = +s.settings.exposure || 0;
      if (s.settings.filter) settings.filter = { ...defaultFilter(), ...s.settings.filter };
      settings.filterOpen = !!s.settings.filterOpen;
    }
  } catch {
    ctl.setState(DEFAULT_VIEW);
  }
}
function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ view: ctl.getState(), settings }));
  } catch { /* storage unavailable */ }
}
loadSaved();

// ------------------------------------------------------------------ selection
let search: StarSearch | null = null;
let searchReady: Promise<StarSearch> | null = null;
function ensureSearch(): Promise<StarSearch> {
  if (!searchReady) searchReady = store.loadNames().then((rows) => (search = new StarSearch(rows)));
  return searchReady;
}

interface Selection { index: number; meta: StarMeta; world: Vec3; title: string; props: [number, number, number, number] | null }
let selected: Selection | null = null;
const panel = $('#panel');

function worldOf(meta: StarMeta, isSun: boolean): Vec3 {
  return isSun ? ([...SUN_GC] as Vec3) : radecToWorld(meta.ra, meta.dec, meta.dist);
}

async function select(index: number | null, fly: 'none' | 'center' | 'approach' = 'none'): Promise<void> {
  if (index === null) {
    selected = null;
    stars.setFocus(null, null, null);
    renderPanel();
    return;
  }
  const [meta, s, props] = await Promise.all([store.meta(index), ensureSearch(), store.propsOf(index)]);
  if (!meta) return;
  const name = s.byIndex.get(index);
  const isSun = name?.[1] === 'Sol';
  const world = worldOf(meta, isSun);
  selected = { index, meta, world, title: displayName(meta, name).title, props };
  const rgbm = stars.rgbmOf(index) ?? fallbackRgbm(meta);
  stars.setFocus(index, world, rgbm);
  renderPanel();
  if (fly === 'center') ctl.flyTo(world, Math.min(ctl.distance, 50));
  if (fly === 'approach') ctl.flyTo(world, isSun ? 2e-4 : 1e-3);
}

function fallbackRgbm(meta: StarMeta): [number, number, number, number] {
  const c = rgbFromTemp(tempFromBV(isFinite(meta.color) ? meta.color : 0.6));
  const M = meta.dist > 0 ? meta.mag - 5 * Math.log10(meta.dist / 10) : 4.83;
  return [c[0] * 255, c[1] * 255, c[2] * 255, packAbsMag(M)];
}

function renderPanel(): void {
  if (selected) {
    panel.innerHTML = starPanel(selected.meta, search?.byIndex.get(selected.index), ctl.position, selected.props);
  } else {
    panel.innerHTML = overviewPanel(store.index ?? null, galaxy.count);
  }
}
panel.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
  if (!act || !selected) return;
  if (act === 'center') ctl.flyTo(selected.world, Math.min(ctl.distance, 50));
  if (act === 'zoom') ctl.flyTo(selected.world, selected.title === 'Sol' ? 2e-4 : 1e-3);
  if (act === 'clear') void select(null);
});

ctl.onClick = (x, y) => {
  if (!settings.layers.catalog) return;
  const i = stars.pick(x, y, ctl.position, camera, viewport.clientWidth, viewport.clientHeight, pixelRatio);
  if (i !== null) void select(i);
};
ctl.onDoubleClick = (x, y) => {
  const i = settings.layers.catalog ? stars.pick(x, y, ctl.position, camera, viewport.clientWidth, viewport.clientHeight, pixelRatio) : null;
  if (i !== null) void select(i, 'center');
};

// ------------------------------------------------------------------ toolbar
const go = {
  sun: () => ctl.flyTo([...SUN_GC] as Vec3, 3),
  local: () => ctl.flyTo([...SUN_GC] as Vec3, 150, 0.5),
  gc: () => ctl.flyTo([0, 0, 0], 3500, 0.5),
  galaxy: () => ctl.flyTo([0, 0, 0], 42000, 0.95),
};
document.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) =>
  b.addEventListener('click', () => go[b.dataset.go as keyof typeof go]()));

document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((el) => {
  const k = el.dataset.layer as keyof typeof settings.layers;
  el.checked = settings.layers[k];
  el.addEventListener('change', () => {
    settings.layers[k] = el.checked;
    applyLayers();
    save();
  });
});
function applyLayers(): void {
  stars.setVisible(settings.layers.catalog);
  galaxy.setVisible(settings.layers.procedural);
  grids.setVisible(settings.layers.grid);
  $('#labels').style.display = settings.layers.labels ? '' : 'none';
}
applyLayers();

const exposure = $<HTMLInputElement>('#exposure');
const expval = $<HTMLOutputElement>('#expval');
exposure.value = String(settings.exposure);
const showExp = () => (expval.textContent = `${settings.exposure >= 0 ? '+' : '−'}${Math.abs(settings.exposure).toFixed(1)}`);
showExp();
exposure.addEventListener('input', () => {
  settings.exposure = +exposure.value;
  showExp();
  save();
});

$('#help-btn').addEventListener('click', () => ($('#help').hidden = !$('#help').hidden));

// star filters
const filterBox = $('#filters');
const filterBtn = $('#filter-btn');
const filterPanel = new FilterPanel(filterBox, settings.filter, (f) => {
  settings.filter = f;
  stars.setFilter(f);
  filterBtn.classList.toggle('active', filterActive(f));
  save();
});
stars.setFilter(settings.filter);
filterBtn.classList.toggle('active', filterActive(settings.filter));
function setFilterOpen(open: boolean): void {
  settings.filterOpen = open;
  filterBox.hidden = !open;
  filterBtn.classList.toggle('open', open);
  if (open) filterPanel.setStats(stars.filterStats());
  save();
}
setFilterOpen(settings.filterOpen);
filterBtn.addEventListener('click', () => setFilterOpen(!settings.filterOpen));

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') void select(null);
  if (k === 'c' && selected) ctl.flyTo(selected.world, Math.min(ctl.distance, 50));
  if (k === 'z' && selected) ctl.flyTo(selected.world, selected.title === 'Sol' ? 2e-4 : 1e-3);
  if (k === 'h') go.sun();
  if (k === 'g') go.galaxy();
  if (k === 't' && !e.ctrlKey && !e.metaKey) setFilterOpen(!settings.filterOpen);
});

// search
const input = $<HTMLInputElement>('#search');
const results = $<HTMLUListElement>('#results');
let hits: ReturnType<StarSearch['query']> = [];
let active = 0;
function renderHits(): void {
  results.hidden = false;
  if (!hits.length) {
    results.innerHTML = `<li class="empty">${input.value.trim() ? 'nenhum resultado' : ''}</li>`;
    return;
  }
  results.innerHTML = hits
    .map((h, i) => `<li data-i="${i}" class="${i === active ? 'active' : ''}"><span>${h.label}</span><span class="k">${h.key !== h.label ? h.key : h.row[2] || (h.row[4] ? 'HIP ' + h.row[4] : '')}</span></li>`)
    .join('');
}
input.addEventListener('input', async () => {
  if (!search) results.innerHTML = '<li class="empty">carregando índice de nomes…</li>', (results.hidden = false);
  const s = await ensureSearch();
  hits = s.query(input.value);
  active = 0;
  renderHits();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') active = Math.min(active + 1, hits.length - 1), renderHits(), e.preventDefault();
  if (e.key === 'ArrowUp') active = Math.max(active - 1, 0), renderHits(), e.preventDefault();
  if (e.key === 'Enter' && hits[active]) choose(hits[active].index);
  if (e.key === 'Escape') results.hidden = true, input.blur();
});
input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
results.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest('li[data-i]');
  if (li) choose(hits[+li.getAttribute('data-i')!].index);
});
async function choose(index: number): Promise<void> {
  results.hidden = true;
  input.blur();
  await select(index);
  if (selected) ctl.flyTo(selected.world, selected.title === 'Sol' ? 3 : 2);
}

// ------------------------------------------------------------------ status bar
const el = {
  pos: $('#st-pos'), helio: $('#st-helio'), bar: $('#scalebar'), scale: $('#scaletext'),
  stars: $('#st-stars'), mem: $('#st-mem'), perf: $('#st-perf'), loading: $('#loading'), loadingText: $('#loading-text'),
  ring: $('#sel-ring'),
};
const mb = (b: number) => (b / 1048576).toFixed(1);

function niceScale(pxPerPc: number): [number, number] {
  const target = 110 / pxPerPc;
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [5, 2, 1]) if (m * p <= target) return [m * p, m * p * pxPerPc];
  return [p, p * pxPerPc];
}
function scaleText(pc: number): string {
  if (pc < 0.05) return `${+(pc * AU_PER_PC).toPrecision(2)} AU`;
  if (pc >= 1000) return `${+(pc / 1000).toPrecision(2)} kpc · ${+(pc * LY_PER_PC / 1000).toPrecision(2)} kly`;
  return `${+pc.toPrecision(2)} pc · ${+(pc * LY_PER_PC).toPrecision(2)} ly`;
}

let frames = 0, fps = 0, frameMs = 0, lastStat = performance.now();
function updateStatus(wantedCount: number): void {
  const p = ctl.position;
  if (selected) {
    const dd = panel.querySelector('dd[data-k="camdist"]');
    if (dd) dd.textContent = formatDistance(Math.hypot(...(selected.world.map((v, i) => v - p[i]) as Vec3)));
  }
  el.pos.innerHTML = `xyz <b>${(p[0] / 1000).toFixed(3)} ${(p[1] / 1000).toFixed(3)} ${(p[2] / 1000).toFixed(3)}</b> kpc`;
  const g = worldToGalactic(p);
  el.helio.innerHTML = `☉ l <b>${g.l.toFixed(2)}°</b> b <b>${g.b >= 0 ? '+' : ''}${g.b.toFixed(2)}°</b> d <b>${formatDistance(g.dist)}</b>`;
  const pxPerPc = viewport.clientHeight / (2 * ctl.distance * Math.tan((camera.fov * Math.PI) / 360));
  const [len, px] = niceScale(pxPerPc);
  el.bar.style.width = `${px.toFixed(0)}px`;
  el.scale.textContent = scaleText(len);
  el.stars.innerHTML = `★ <b>${stars.drawnStars.toLocaleString('pt-BR')}</b> · nós <b>${store.loaded.size}</b>/${wantedCount} · lim <b>${stars.magLimit.toFixed(1)}</b>`;
  const cpu = store.residentBytes + store.metaCacheBytes;
  const gpu = stars.gpuBytes + galaxy.gpuBytes;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  el.mem.innerHTML = `dados <b>${mb(cpu)}</b> CPU + <b>${mb(gpu)}</b> GPU / ${mb(MEMORY_BUDGET)} MB${heap ? ` · heap <b>${mb(heap)}</b>` : ''}`;
  if (!filterBox.hidden) filterPanel.setStats(stars.filterStats());
  el.perf.innerHTML = `<b>${fps.toFixed(0)}</b> fps · <b>${frameMs.toFixed(1)}</b> ms · ${renderer.info.render.calls} draws`;
  const busy = store.loading > 0 || galaxy.count === 0;
  el.loading.hidden = !busy;
  if (busy) el.loadingText.textContent = galaxy.count === 0 ? 'gerando galáxia procedural' : `carregando ${store.loading} nó(s)`;
}

// ------------------------------------------------------------------ labels
function drawLabels(): void {
  labels.begin();
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const cam = ctl.position;
  const proj = (world: Vec3) => stars.project([world[0] - cam[0], world[1] - cam[1], world[2] - cam[2]], camera, w, h);
  const onScreen = (s: [number, number] | null): s is [number, number] => !!s && s[0] > -50 && s[0] < w + 50 && s[1] > -20 && s[1] < h + 20;

  const sun = proj(SUN_GC);
  if (onScreen(sun) && !(selected?.title === 'Sol')) labels.add(sun[0], sun[1], 'Sol', 'sun');
  if (ctl.distance > 300) {
    const gc = proj([0, 0, 0]);
    if (onScreen(gc)) labels.add(gc[0], gc[1], 'Sgr A*', 'gc');
  }
  if (settings.layers.grid) {
    for (const [r] of grids.ringLabels(ctl.distance)) {
      const right = [-Math.sin(ctl.yaw), Math.cos(ctl.yaw)];
      const s = proj([SUN_GC[0] + right[0] * r, SUN_GC[1] + right[1] * r, SUN_GC[2]]);
      if (onScreen(s)) labels.add(s[0], s[1], r >= 1000 ? `${r / 1000} kpc` : `${r} pc`, 'ring');
    }
  }
  // named stars that are currently bright enough to be seen
  if (search && settings.layers.catalog && ctl.distance < 3000) {
    const cands: Array<{ s: [number, number]; dm: number; t: string }> = [];
    for (const row of namedRows ?? (namedRows = search.named())) {
      if (row[1] === 'Sol' || row[0] === selected?.index) continue;
      const loc = store.locate(row[0]);
      const l = loc && store.loaded.get(loc.node);
      if (!loc || !l) continue;
      const c = l.node.c, k = loc.local * 3;
      const wp: Vec3 = [c[0] + l.positions[k], c[1] + l.positions[k + 1], c[2] + l.positions[k + 2]];
      const d = Math.hypot(wp[0] - cam[0], wp[1] - cam[1], wp[2] - cam[2]);
      if (!stars.passes(loc.node, loc.local)) continue;
      const dm = apparentDelta(stars.magLimit, l.rgbm[loc.local * 4 + 3], d);
      if (dm < 4.5) continue;
      const s = proj(wp);
      if (onScreen(s)) cands.push({ s, dm, t: row[1] });
    }
    cands.sort((a, b) => b.dm - a.dm);
    // greedy de-cluttering on a coarse screen grid
    const taken = new Set<string>();
    let n = 0;
    for (const c of cands) {
      const gx = Math.floor(c.s[0] / 90), gy = Math.floor(c.s[1] / 18);
      const key = `${gx},${gy}`;
      if (taken.has(key) || taken.has(`${gx - 1},${gy}`)) continue;
      taken.add(key);
      labels.add(c.s[0], c.s[1], c.t, 'named');
      if (++n >= 16) break;
    }
  }
  if (selected) {
    const s = proj(selected.world);
    if (s && onScreen(s)) {
      labels.add(s[0] + 6, s[1], selected.title, 'sel');
      el.ring.hidden = false;
      el.ring.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px)`;
    } else el.ring.hidden = true;
  } else el.ring.hidden = true;
  labels.end();
}
let namedRows: ReturnType<StarSearch['named']> | null = null;

// ------------------------------------------------------------------ loop
function resize(): void {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
let last = performance.now();
let wanted: number[] = [];
let lastSave = 0;

function magLimitFor(distance: number): number {
  // Binocular-like limit (8) at small scales; deeper as the view widens, so structure stays legible.
  return 8 + settings.exposure + 2 * Math.log10(Math.min(Math.max(distance / 5, 1), 1e4));
}

function tick(dt: number, render = true): void {
  ctl.update(dt);
  const cam = ctl.position;
  const magLimit = magLimitFor(ctl.distance);

  if (store.index) {
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    wanted = settings.layers.catalog ? stars.wantedNodes(cam, frustum, magLimit, store.budgetBytes * 0.9) : [0];
    store.update(wanted);
  }
  stars.update(cam, magLimit, pixelRatio);
  galaxy.update(cam, pixelRatio, ctl.distance);
  grids.update(cam, ctl.distance);
  if (!render) return;
  renderer.render(scene, camera);
  if (settings.layers.labels) drawLabels();
}

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  tick(dt);

  frames++;
  frameMs += (performance.now() - now - frameMs) * 0.1;
  if (now - lastStat > 500) {
    fps = (frames * 1000) / (now - lastStat);
    frames = 0;
    lastStat = now;
    updateStatus(wanted.length);
  }
  if (now - lastSave > 1000) {
    lastSave = now;
    save();
  }
  requestAnimationFrame(frame);
}

async function start(): Promise<void> {
  try {
    await store.init();
  } catch (e) {
    panel.innerHTML = `<h2>Catálogo indisponível</h2><p class="note warn">${String((e as Error).message)}</p>`;
  }
  renderPanel();
  galaxy.ready.then(() => !selected && renderPanel());
  // designations are only needed for labels/search: fetch them once the scene is up
  setTimeout(() => void ensureSearch(), 1500);
  requestAnimationFrame(frame);
}
void start();

// Debug handle for the browser console (no app logic depends on it).
(window as unknown as { atlas: unknown }).atlas = {
  store, stars, galaxy, ctl, renderer, select, go,
  /** Advances the simulation synchronously (for automated checks when rAF is throttled). */
  step(seconds: number) {
    const n = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < n; i++) tick(1 / 60, i === n - 1);
    updateStatus(wanted.length);
  },
};

import {
  formatDec, formatDistance, formatRA, radecToWorld, worldToGalactic, LY_PER_PC, type Vec3,
} from '../core/coords.ts';
import { MetaFlag, Source, persistentId, type CatalogIndex, type NameRow, type StarMeta } from '../core/format.ts';
import { absoluteMagnitude, tempFromBV } from '../core/photometry.ts';
import { bpRpFromTemp, describeType, PropFlag } from '../core/spectral.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const row = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
const f = (v: number, d: number) => (isFinite(v) ? v.toFixed(d) : '—');

export function displayName(meta: StarMeta, name: NameRow | undefined): { title: string; subtitle: string } {
  const alt: string[] = [];
  if (name?.[2]) alt.push(name[2]);
  if (meta.hip) alt.push(`HIP ${meta.hip}`);
  if (name?.[5]) alt.push(`HD ${name[5]}`);
  if (name?.[7]) alt.push(name[7]);
  const gaia = meta.gaiaSourceId !== null ? `Gaia DR3 ${meta.gaiaSourceId}` : '';
  const title = name?.[1] || alt[0] || gaia || `HYG ${meta.hygId}`;
  const subtitle = [...alt.filter((a) => a !== title), gaia && gaia !== title ? gaia : ''].filter(Boolean).slice(0, 3).join(' · ');
  return { title, subtitle };
}

export function starPanel(meta: StarMeta, name: NameRow | undefined, cam: Vec3,
  props: [number, number, number, number] | null, worldName?: string): string {
  const isSun = name?.[1] === 'Sol';
  const { title, subtitle } = displayName(meta, name);
  const world = isSun ? null : radecToWorld(meta.ra, meta.dec, meta.dist);
  const gal = world ? worldToGalactic(world) : null;
  const src = meta.source === Source.GaiaDR3
    ? 'Gaia DR3 (ESA)'
    : 'HYG v4.1 · Hipparcos / Yale BSC / Gliese';
  const epoch = meta.source === Source.GaiaDR3 ? 'ICRS, época J2016.0' : 'ICRS, época J2000.0';
  const distMethod = meta.flags & MetaFlag.BailerJonesDistance
    ? 'Bailer-Jones 2021 (geométrica)'
    : meta.source === Source.GaiaDR3 ? '1/paralaxe' : '1/paralaxe (Hipparcos, via HYG)';
  const interval = isFinite(meta.distLo) && isFinite(meta.distHi)
    ? ` <span class="u">[${f(meta.distLo, meta.distLo < 100 ? 2 : 0)} – ${f(meta.distHi, meta.distHi < 100 ? 2 : 0)}]</span>` : '';
  const band = meta.source === Source.GaiaDR3 ? 'G' : 'V';
  const colorName = meta.source === Source.GaiaDR3 ? 'BP−RP' : 'B−V';
  const camDist = world ? Math.hypot(world[0] - cam[0], world[1] - cam[1], world[2] - cam[2]) : NaN;

  let h: string;
  if (worldName) {
    // authorial name first; the catalogue designation stays visible right below
    h = `<h2 class="auth-name">${esc(worldName)}</h2><div class="sub">${esc([title, subtitle].filter(Boolean).join(' · '))}</div>`;
  } else {
    h = `<h2>${esc(title)}</h2>`;
    if (subtitle) h += `<div class="sub">${esc(subtitle)}</div>`;
  }
  h += `<div class="badge real"><i class="sw real"></i>Observacional · ${meta.source === Source.GaiaDR3 ? 'Gaia DR3' : 'Hipparcos/HYG'}</div>`;

  h += '<h3>Identificação</h3><dl>';
  h += row('ID persistente', esc(persistentId(meta)));
  if (meta.gaiaSourceId !== null) h += row('Gaia DR3', String(meta.gaiaSourceId));
  if (meta.hip) h += row('HIP', String(meta.hip));
  if (name?.[5]) h += row('HD', String(name[5]));
  if (name?.[6]) h += row('HR', String(name[6]));
  if (name?.[7]) h += row('Gliese', esc(name[7]));
  if (name?.[8]) h += row('Tipo espectral', esc(name[8]));
  // the catalogue's filter props, so the panel shows exactly what the filters use
  const isGaia = meta.source === Source.GaiaDR3;
  const bpRp = isGaia ? meta.color : isFinite(meta.color) ? bpRpFromTemp(tempFromBV(meta.color)) : NaN;
  const [cls, lum, , pf] = props ?? [0, 0, 0, 0];
  if (cls || lum) {
    const est = pf & (PropFlag.ClassEstimated | PropFlag.LumEstimated);
    const how = (pf & PropFlag.ClassEstimated) ? 'estimada (cor + diagrama HR)' : (pf & PropFlag.LumEstimated) ? 'luminosidade estimada' : 'catalogada';
    h += row('Classe', `${esc(describeType(cls, lum))} <span class="u">${est ? how : 'catalogada'}</span>`);
  }
  if (isFinite(bpRp) && !isGaia) h += row('BP−RP', `${bpRp.toFixed(2)} <span class="u">convertido de B−V</span>`);
  h += row('Fonte', esc(src));
  h += '</dl>';

  if (!isSun) {
    h += '<h3>Posição</h3><dl>';
    h += row('AR', formatRA(meta.ra));
    h += row('Dec', formatDec(meta.dec));
    h += row('Referencial', epoch);
    if (gal) h += row('l, b', `${gal.l.toFixed(4)}°, ${gal.b >= 0 ? '+' : ''}${gal.b.toFixed(4)}°`);
    h += row('Distância', `${formatDistance(meta.dist)}${interval}`);
    h += row('Método', distMethod);
    if (isFinite(meta.parallaxErr)) h += row('Paralaxe', `${f(meta.parallax, 4)} ± ${f(meta.parallaxErr, 4)} <span class="u">mas</span>`);
    else if (isFinite(meta.parallax)) h += row('Paralaxe', `${f(meta.parallax, 3)} <span class="u">mas (derivada)</span>`);
    if (world) h += row('Galactocêntr.', `${(world[0] / 1000).toFixed(4)}, ${(world[1] / 1000).toFixed(4)}, ${(world[2] / 1000).toFixed(4)} <span class="u">kpc</span>`);
    h += `<dt>Da câmera</dt><dd data-k="camdist">${formatDistance(camDist)}</dd>`;
    h += '</dl>';
  }

  h += '<h3>Fotometria</h3><dl>';
  if (isFinite(meta.mag)) h += row(`${band} aparente`, f(meta.mag, 3));
  if (isFinite(meta.color)) h += row(colorName, f(meta.color, 3));
  if (isFinite(meta.mag) && meta.dist > 0) h += row(`M<sub>${band}</sub>`, `${f(absoluteMagnitude(meta.mag, meta.dist), 2)} <span class="u">sem extinção</span>`);
  h += '</dl>';

  if (meta.flags & MetaFlag.DistanceUncertain) {
    h += `<div class="note warn">Incerteza de distância &gt; 20%${meta.source === Source.Hipparcos ? ' (estimada: o HYG não traz o erro da paralaxe)' : ''}. A posição 3D é aproximada.</div>`;
  }
  if (meta.flags & MetaFlag.HipparcosMatch) h += '<div class="note">Astrometria Gaia; designações do HYG via cruzamento Hipparcos-2.</div>';
  h += `<div class="actions"><button class="primary" data-act="center">Centralizar <span class="kbd">C</span></button><button data-act="zoom">Aproximar <span class="kbd">Z</span></button><button data-act="clear">Limpar</button></div>`;
  return h;
}

export function overviewPanel(index: CatalogIndex | null, galaxyCount: number): string {
  let h = '<h2>Via Láctea</h2><div class="sub">Atlas galáctico · protótipo</div>';
  h += '<h3>Camadas</h3><div class="legend">';
  h += `<i class="sw real"></i><div><b>Estrelas observacionais</b><br>${index ? index.total.toLocaleString('pt-BR') : '—'} estrelas com posição derivada de astrometria real (Gaia DR3, Hipparcos). Clicáveis.</div>`;
  h += `<i class="sw proc"></i><div><b>Galáxia procedural</b><br>${galaxyCount.toLocaleString('pt-BR')} pontos agregados, gerados deterministicamente — apenas visual, não são estrelas reais e não são selecionáveis.</div>`;
  h += `<i class="sw auth"></i><div><b>Seu mundo</b><br>Dados autorais (nomes, descrições, etiquetas, campos) sobre estrelas reais, guardados à parte do catálogo. Marcados com anéis.</div>`;
  h += '</div>';
  if (index) {
    h += '<h3>Catálogo</h3><dl>';
    h += row('Gaia DR3', index.counts.gaiaDR3?.toLocaleString('pt-BR') ?? '0');
    h += row('Hipparcos/HYG', index.counts.hipparcos?.toLocaleString('pt-BR') ?? '0');
    h += row('Nós octree', String(index.nodes.length));
    h += row('Gerado', index.built.slice(0, 10));
    h += '</dl>';
    if (index.sample) h += '<div class="note warn">Conjunto de EXEMPLO: pequeno recorte real do HYG, usado quando o catálogo completo não foi importado.</div>';
    h += '<h3>Fontes</h3>';
    for (const s of index.sources) h += `<p><b>${esc(s.name)}</b><br>${esc(s.citation)}<br><span class="kbd" style="font-size:10px">${esc(s.selection)}</span></p>`;
  }
  h += '<h3>Referencial</h3><dl>';
  h += row('Mundo', 'galactocêntrico (astropy v4.0)');
  h += row('R₀', `8.122 kpc <span class="u">(${(8122 * LY_PER_PC / 1000).toFixed(1)} kly)</span>`);
  h += row('z☉', '20.8 pc');
  h += '</dl>';
  h += '<p class="note">O catálogo observacional cobre a vizinhança solar (até alguns kpc) e é limitado por magnitude: sua distribuição <b>não</b> representa a distribuição completa de estrelas da Galáxia.</p>';
  return h;
}

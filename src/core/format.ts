/**
 * Binary catalog format shared by the pipeline (writer) and the app (reader).
 *
 * public/data/catalog/
 *   index.json           CatalogIndex: octree nodes, provenance, totals
 *   nodes/<id>.bin       render payload of one node:
 *                          Float32[n*3]  position relative to node centre (pc, world axes)
 *                          Uint8[n*4]    r, g, b, packed absolute magnitude
 *                          Uint8[n*4]    spectral class, luminosity class, packed BP−RP, flags
 *                                        (see core/spectral.ts; used by the filters)
 *   nodes/<id>.meta.bin  per-star metadata, fixed META_RECORD_BYTES records (loaded on demand)
 *   names.json           designations for stars that have them (loaded on first search/select)
 *
 * Star identity:
 *   - `index` (uint32) is a catalog-build-local index: node.offset + position in node.
 *     Fast, compact, used for rendering/picking. NOT stable across catalog rebuilds.
 *   - `persistentId` (string) is the stable key for user data: "gaia-dr3:<source_id>",
 *     "hip:<n>" or "hyg:<id>" (Sun / non-Hipparcos HYG rows). User/world-building data must
 *     reference persistentId and lives outside the scientific catalog.
 */

export const CATALOG_FORMAT_VERSION = 2;
export const RENDER_BYTES_PER_STAR = 20;

export const Source = {
  GaiaDR3: 1,
  Hipparcos: 2, // HYG v4.1 row (Hipparcos / Yale BSC / Gliese) without a Gaia counterpart in our subset
  Procedural: 100, // never stored in the catalog; used for labels
  User: 200, // reserved for future user-authored stars
} as const;
export type SourceCode = (typeof Source)[keyof typeof Source];

export const MetaFlag = {
  BailerJonesDistance: 1, // distance = Bailer-Jones (2021) r_med_geo
  InverseParallax: 2, // distance = 1000 / parallax
  DistanceUncertain: 4, // fractional distance uncertainty > 20% (or unknown)
  HasDesignation: 8, // has an entry in names.json
  HipparcosMatch: 16, // Gaia star with a Hipparcos-2 best neighbour (HYG names merged)
} as const;

/** Little-endian fixed record. */
export const META_RECORD_BYTES = 64;
export const MetaOffset = {
  source: 0, // u8
  flags: 1, // u8
  hip: 4, // u32 (0 = none)
  gaiaLo: 8, // u32 low 32 bits of Gaia source_id
  gaiaHi: 12, // u32 high 32 bits
  hygId: 16, // u32 HYG row id + 1 (0 = none)
  ra: 20, // f64 deg (ICRS; Gaia epoch J2016.0, HYG epoch J2000.0)
  dec: 28, // f64 deg
  dist: 36, // f32 pc
  distLo: 40, // f32 pc (NaN if unknown)
  distHi: 44, // f32 pc
  parallax: 48, // f32 mas (NaN if unknown)
  parallaxErr: 52, // f32 mas
  mag: 56, // f32 apparent magnitude (Gaia G or Johnson V)
  color: 60, // f32 BP-RP (Gaia) or B-V (HYG)
} as const;

export interface StarMeta {
  index: number;
  source: SourceCode;
  flags: number;
  hip: number;
  gaiaSourceId: bigint | null;
  hygId: number | null;
  ra: number;
  dec: number;
  dist: number;
  distLo: number;
  distHi: number;
  parallax: number;
  parallaxErr: number;
  mag: number;
  color: number;
}

export function readMetaRecord(view: DataView, i: number, index: number): StarMeta {
  const o = i * META_RECORD_BYTES;
  const lo = view.getUint32(o + MetaOffset.gaiaLo, true);
  const hi = view.getUint32(o + MetaOffset.gaiaHi, true);
  const hyg = view.getUint32(o + MetaOffset.hygId, true);
  return {
    index,
    source: view.getUint8(o + MetaOffset.source) as SourceCode,
    flags: view.getUint8(o + MetaOffset.flags),
    hip: view.getUint32(o + MetaOffset.hip, true),
    gaiaSourceId: lo || hi ? (BigInt(hi) << 32n) | BigInt(lo) : null,
    hygId: hyg ? hyg - 1 : null,
    ra: view.getFloat64(o + MetaOffset.ra, true),
    dec: view.getFloat64(o + MetaOffset.dec, true),
    dist: view.getFloat32(o + MetaOffset.dist, true),
    distLo: view.getFloat32(o + MetaOffset.distLo, true),
    distHi: view.getFloat32(o + MetaOffset.distHi, true),
    parallax: view.getFloat32(o + MetaOffset.parallax, true),
    parallaxErr: view.getFloat32(o + MetaOffset.parallaxErr, true),
    mag: view.getFloat32(o + MetaOffset.mag, true),
    color: view.getFloat32(o + MetaOffset.color, true),
  };
}

export function persistentId(m: Pick<StarMeta, 'source' | 'gaiaSourceId' | 'hip' | 'hygId'>): string {
  if (m.gaiaSourceId !== null) return `gaia-dr3:${m.gaiaSourceId}`;
  if (m.hip) return `hip:${m.hip}`;
  return `hyg:${m.hygId ?? 'unknown'}`;
}

export interface CatalogNode {
  id: string; // octree path: "r", "r3", "r37", ...
  c: [number, number, number]; // centre, world frame (pc), float64
  h: number; // half size (pc)
  n: number; // star count
  off: number; // global index of the first star
  mMin: number; // brightest absolute magnitude in node
  mMax: number; // faintest absolute magnitude in node
  ch: number[]; // child node indices into CatalogIndex.nodes
  depth: number;
}

export interface CatalogIndex {
  version: number;
  frame: string;
  units: string;
  built: string;
  sample: boolean;
  total: number;
  counts: Record<string, number>;
  sources: Array<{ code: number; name: string; citation: string; license: string; selection: string }>;
  nodeCapacity: number;
  nodes: CatalogNode[];
}

/** names.json row: [index, proper, bayerFlamsteed, constellation, hip, hd, hr, gliese, spectralType] */
export type NameRow = [number, string, string, string, number, number, number, string, string];

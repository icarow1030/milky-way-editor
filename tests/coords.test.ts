import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GALCEN, SUN_GC, equatorialToCartesian, cartesianToEquatorial, equatorialToGalacticCartesian,
  cartesianToGalactic, galacticCartesianToEquatorial, galacticToCartesian, radecToWorld, worldToEquatorial, galactocentricToEquatorial,
  equatorialToGalactocentric, toRender, type Vec3,
} from '../src/core/coords.ts';

const near = (a: number, b: number, tol: number, msg = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a} (tol ${tol})`);
const angNear = (a: number, b: number, tol: number, msg = '') => {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  assert.ok(d <= tol, `${msg} expected ${b}, got ${a}`);
};

function galOf(ra: number, dec: number) {
  return cartesianToGalactic(equatorialToGalacticCartesian(equatorialToCartesian(ra, dec, 1)));
}

// Reference galactic coordinates from SIMBAD (ICRS J2000 -> Galactic).
const KNOWN: Array<[string, number, number, number, number]> = [
  ['Sirius', 101.28715533, -16.71611586, 227.2303, -8.8903],
  ['Vega', 279.23473479, 38.78368896, 67.4482, 19.2373],
  ['Betelgeuse', 88.79293899, 7.407064, 199.7873, -8.9586],
  ['Polaris', 37.95456067, 89.26410897, 123.2805, 26.4614],
  ['Sgr A*', 266.41683708, -29.00781056, 359.9442, -0.0462],
  ['Alpha Centauri A', 219.90205833, -60.83399269, 315.7330, -0.6809],
];

test('ICRS -> Galactic matches SIMBAD for known objects', () => {
  for (const [name, ra, dec, l, b] of KNOWN) {
    const g = galOf(ra, dec);
    angNear(g.l, l, 0.002, `${name} l`);
    near(g.b, b, 0.002, `${name} b`);
  }
});

test('North galactic pole and galactic centre directions', () => {
  near(galOf(192.85948, 27.12825).b, 90, 1e-4, 'NGP b');
  const ncp = galOf(0, 90);
  angNear(ncp.l, 122.93192, 1e-4, 'NCP l');
  near(ncp.b, 27.12825, 1e-4, 'NCP b');
});

test('equatorial spherical <-> cartesian round trip', () => {
  for (const [ra, dec, d] of [[0, 0, 1], [123.4, -56.7, 812.3], [359.99, 89.9, 0.001], [180, -89.9, 9000]]) {
    const s = cartesianToEquatorial(equatorialToCartesian(ra, dec, d));
    angNear(s.ra, ra, 1e-9);
    near(s.dec, dec, 1e-9);
    near(s.dist, d, d * 1e-12);
  }
});

test('Galactocentric frame: Sun and Sgr A* positions (astropy v4.0 convention)', () => {
  const R0cos = Math.sqrt(GALCEN.distance ** 2 - GALCEN.zSun ** 2);
  near(SUN_GC[0], -R0cos, 1e-6, 'sun x');
  near(SUN_GC[1], 0, 1e-9, 'sun y');
  near(SUN_GC[2], GALCEN.zSun, 1e-9, 'sun z');
  const gc = radecToWorld(GALCEN.ra, GALCEN.dec, GALCEN.distance);
  for (const c of gc) near(c, 0, 1e-6, 'GC at origin');
});

test('Galactocentric axes: +y towards l=90, +z towards NGP', () => {
  const toWorldFromGal = (l: number, b: number, d: number): Vec3 =>
    equatorialToGalactocentric(galacticCartesianToEquatorial(galacticToCartesian(l, b, d)));
  const y = toWorldFromGal(90, 0, 1000);
  near(y[1] - SUN_GC[1], 1000, 0.01, 'l=90 -> +y');
  const z = toWorldFromGal(0, 90, 1000);
  near(z[2] - SUN_GC[2], 1000, 3, 'b=90 -> +z (frame tilted by asin(zsun/R0))');
  const x = toWorldFromGal(0, 0, 1000);
  near(x[0] - SUN_GC[0], 1000, 3, 'l=0 -> +x');
});

test('world <-> equatorial round trip preserves positions at galactic scales', () => {
  for (const [ra, dec, d] of [[10, 20, 1.3], [250, -40, 4500], [83.8, -5.39, 412]]) {
    const w = radecToWorld(ra, dec, d);
    const back = worldToEquatorial(w);
    angNear(back.ra, ra, 1e-8);
    near(back.dec, dec, 1e-8);
    near(back.dist, d, 1e-7);
    const e = galactocentricToEquatorial(w);
    near(Math.hypot(...e), d, 1e-7, 'distance from Sun preserved');
  }
});

test('Proxima/Alpha Cen distance to Sun preserved in world frame', () => {
  const w = radecToWorld(217.42895, -62.67948, 1.3020);
  const d = Math.hypot(w[0] - SUN_GC[0], w[1] - SUN_GC[1], w[2] - SUN_GC[2]);
  near(d, 1.302, 1e-9);
});

test('camera-relative render vectors keep sub-AU precision near a star 8 kpc from GC', () => {
  const star = radecToWorld(219.90205833, -60.83399269, 1.3325); // ~ Alpha Cen
  const AU = 1 / 206264.806;
  const cam: Vec3 = [star[0] + 2 * AU, star[1], star[2]];
  const r = toRender(star, cam);
  const f32 = new Float32Array(r);
  near(f32[0], -2 * AU, 1e-9, 'relative x');
  // Naive float32 world coordinates would lose this completely:
  const naive = Math.fround(star[0]) - Math.fround(cam[0]);
  assert.ok(Math.abs(naive - -2 * AU) > 1e-6, 'float32 world coordinates are too coarse (sanity check)');
});

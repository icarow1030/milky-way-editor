import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpectralType, estimateFromPhotometry, encodeProps, packColor, unpackColor, bpRpFromTemp,
  SpecClass as C, LumClass as L, PropFlag,
} from '../src/core/spectral.ts';
import { tempFromBpRp } from '../src/core/photometry.ts';

test('parses catalogued spectral types', () => {
  const cases: Array<[string, number, number]> = [
    ['G2V', C.G, L.V], ['K1III', C.K, L.III], ['B9Ia', C.B, L.I], ['A0m...', C.A, 0], ['F5IV-V', C.F, L.IV],
    ['K3/K4III', C.K, L.III], ['M1.5Ve', C.M, L.V], ['DA2', C.WD, L.WD], ['sdB5', C.B, L.VI], ['dM3', C.M, L.V],
    ['gK0', C.K, L.III], ['kA2hA5mA7V', C.A, L.V], ['C5,4', C.Carbon, 0], ['M2Iab', C.M, L.I], ['', 0, 0],
  ];
  for (const [s, cls, lum] of cases) assert.deepEqual(parseSpectralType(s), { cls, lum }, s);
});

test('estimates classes from Gaia photometry', () => {
  assert.deepEqual(estimateFromPhotometry(0.82, 4.67), { cls: C.G, lum: L.V }, 'Sun-like');
  assert.deepEqual(estimateFromPhotometry(2.8, 11.5), { cls: C.M, lum: L.V }, 'M dwarf');
  assert.equal(estimateFromPhotometry(1.2, 0.5).lum, L.III, 'red clump giant');
  assert.equal(estimateFromPhotometry(2.0, -6).lum, L.I, 'red supergiant');
  assert.deepEqual(estimateFromPhotometry(0.0, 11.5), { cls: C.WD, lum: L.WD }, 'white dwarf');
  assert.equal(estimateFromPhotometry(-0.3, -2).cls, C.B, 'hot B star');
});

test('catalogued type wins; missing parts are estimated and flagged', () => {
  const [cls, lum, , flags] = encodeProps('K0', 1.2, 0.5, false);
  assert.equal(cls, C.K);
  assert.equal(lum, L.III);
  assert.equal(flags, PropFlag.LumEstimated);
  const g = encodeProps(undefined, 0.82, 4.7, true);
  assert.equal(g[3], PropFlag.ClassEstimated | PropFlag.LumEstimated | PropFlag.ColorConverted);
});

test('colour packing and B-V conversion round-trip', () => {
  for (const c of [-0.5, 0, 0.82, 2.5, 5.5]) assert.ok(Math.abs(unpackColor(packColor(c)) - c) <= 0.0125);
  assert.ok(Number.isNaN(unpackColor(packColor(NaN))));
  for (const c of [-0.3, 0.5, 1.5, 3]) assert.ok(Math.abs(bpRpFromTemp(tempFromBpRp(c)) - c) < 1e-6);
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sampleUV, advect, shouldRespawn, staticArrows, type VelocityGrid } from './currentsField.ts';
import { AOI } from '../geo.ts';

const grid: VelocityGrid = {
  nx: 2,
  ny: 2,
  bbox: { west: -90, south: 30, east: -88, north: 32 },
  u: [1, 1, 1, 1],
  v: [0, 0, 0, 0],
};

describe('sampleUV', () => {
  it('returns the SW cell at the SW centre', () => {
    const p = sampleUV(grid, -90, 30);
    assert.ok(p);
    assert.equal(p.u, 1);
    assert.equal(p.v, 0);
  });
  it('returns null outside the bbox', () => {
    assert.equal(sampleUV(grid, 0, 0), null);
  });
  it('returns null on a null cell (no interpolation from missing)', () => {
    const g: VelocityGrid = { ...grid, u: [null, 1, 1, 1], v: [null, 0, 0, 0] };
    assert.equal(sampleUV(g, -90, 30), null);
  });
});

describe('advect', () => {
  it('moves east for positive u', () => {
    const next = advect(-89, 30, 1, 0, 1, 1);
    assert.ok(next.lon > -89);
    assert.ok(Math.abs(next.lat - 30) < 1e-9);
  });
});

describe('shouldRespawn', () => {
  it('respawns outside AOI or when aged out', () => {
    assert.equal(shouldRespawn(-89, 30.2, 1, AOI, 8), false);
    assert.equal(shouldRespawn(-89, 30.2, 9, AOI, 8), true);
    assert.equal(shouldRespawn(0, 0, 0, AOI, 8), true);
  });
});

describe('staticArrows', () => {
  it('skips null cells', () => {
    const g: VelocityGrid = { ...grid, u: [1, null, 1, 1], v: [0, null, 0, 0] };
    assert.equal(staticArrows(g).length, 3);
  });
});

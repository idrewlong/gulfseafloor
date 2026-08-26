import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FLOW_SCALE,
  TRAIL_LAG_SEC,
  laggedTrailMetres,
  sampleUV,
  advect,
  shouldRespawn,
  staticArrows,
  trailLagMix,
  trailTailOffset,
  velocityGridFromJson,
  type VelocityGrid,
} from './currentsField.ts';
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
  it('bilinear-samples a fractional interior point on a non-uniform 2×2 grid', () => {
    const g: VelocityGrid = {
      nx: 2,
      ny: 2,
      bbox: { west: -90, south: 30, east: -88, north: 32 },
      u: [0, 1, 2, 3],
      v: [0, 4, 8, 12],
    };
    const p = sampleUV(g, -89.5, 31.5);
    assert.ok(p);
    assert.equal(p.u, 1.75);
    assert.equal(p.v, 7);
  });
});

describe('advect', () => {
  it('moves east for positive u', () => {
    const next = advect(-89, 30, 1, 0, 1, 1);
    assert.ok(next.lon > -89);
    assert.ok(Math.abs(next.lat - 30) < 1e-9);
  });
});

describe('laggedTrailMetres', () => {
  it('is a few metres for a 60 fps one-frame segment — invisible on the Sound', () => {
    const metres = laggedTrailMetres(0.5, FLOW_SCALE, 1 / 60);
    assert.ok(metres > 15 && metres < 30);
  });

  it('is kilometres for a typical shelf speed when the tail lags TRAIL_LAG_SEC', () => {
    const metres = laggedTrailMetres(0.5, FLOW_SCALE, TRAIL_LAG_SEC);
    assert.equal(metres, 0.5 * FLOW_SCALE * TRAIL_LAG_SEC);
    assert.ok(metres >= 4000);
  });
});

describe('trailLagMix', () => {
  it('is ~dt/lag for a short step so the tail trails the head', () => {
    const k = trailLagMix(1 / 60, 4);
    assert.ok(k > 0.003 && k < 0.006);
  });
});

describe('trailTailOffset', () => {
  it('is kilometres along flow for a 4 s lag at shelf speed', () => {
    assert.deepEqual(trailTailOffset(0.5, 0, TRAIL_LAG_SEC, FLOW_SCALE), { x: 5000, y: 0 });
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

describe('velocityGridFromJson', () => {
  it('maps bbox/nx/ny and keeps null velocity cells as null', () => {
    const grid = velocityGridFromJson({
      validTime: '2026-08-24T18:00:00Z',
      bbox: { west: -89.7, south: 29.95, east: -87.85, north: 30.52 },
      nx: 2,
      ny: 1,
      grid: 'centers',
      u: [0.12, null],
      v: [-0.04, null],
    });
    assert.ok(grid);
    assert.equal(grid.nx, 2);
    assert.equal(grid.ny, 1);
    assert.deepEqual(grid.bbox, { west: -89.7, south: 29.95, east: -87.85, north: 30.52 });
    assert.deepEqual(grid.u, [0.12, null]);
    assert.deepEqual(grid.v, [-0.04, null]);
  });

  it('rejects a grid that is not cell centres', () => {
    assert.equal(
      velocityGridFromJson({
        bbox: { west: -90, south: 30, east: -88, north: 32 },
        nx: 1,
        ny: 1,
        grid: 'corners',
        u: [0],
        v: [0],
      }),
      null,
    );
  });
});

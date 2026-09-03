import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAND_MASK_H, LAND_MASK_W, pointOnLand, rasterizeLandMask } from './landMask.ts';
import { BARRIER_ISLANDS, type LonLat } from '../geo/orient.ts';
import { AOI } from '../geo.ts';

const unit = { west: 0, south: 0, east: 1, north: 1 };

function square(x0: number, y0: number, x1: number, y1: number): LonLat[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

describe('rasterizeLandMask', () => {
  it('fills the inside of a ring and nothing outside it', () => {
    const mask = rasterizeLandMask([square(0.25, 0.25, 0.75, 0.75)], unit, 64, 64);
    assert.equal(pointOnLand(mask, unit, 0.5, 0.5, 64, 64), true, 'centre is land');
    assert.equal(pointOnLand(mask, unit, 0.1, 0.5, 64, 64), false, 'west of ring is water');
    assert.equal(pointOnLand(mask, unit, 0.9, 0.5, 64, 64), false, 'east of ring is water');
    assert.equal(pointOnLand(mask, unit, 0.5, 0.1, 64, 64), false, 'south of ring is water');
    assert.equal(pointOnLand(mask, unit, 0.5, 0.9, 64, 64), false, 'north of ring is water');
  });

  // Even-odd: a ring inside a ring is a hole, not doubled land.
  it('treats a nested ring as a hole', () => {
    const mask = rasterizeLandMask(
      [square(0.1, 0.1, 0.9, 0.9), square(0.4, 0.4, 0.6, 0.6)],
      unit,
      64,
      64,
    );
    assert.equal(pointOnLand(mask, unit, 0.5, 0.5, 64, 64), false, 'inner ring is a hole');
    assert.equal(pointOnLand(mask, unit, 0.2, 0.2, 64, 64), true, 'between rings is land');
  });

  it('ignores degenerate rings', () => {
    const mask = rasterizeLandMask([[[0.2, 0.2] as LonLat, [0.8, 0.8] as LonLat]], unit, 32, 32);
    assert.ok(mask.every((v) => v === 0), 'a two-point ring encloses nothing');
  });

  it('is empty when handed no rings', () => {
    const mask = rasterizeLandMask([], unit, 16, 16);
    assert.equal(mask.length, 16 * 16);
    assert.ok(mask.every((v) => v === 0));
  });
});

describe('the real AOI land mask', () => {
  const mask = rasterizeLandMask(BARRIER_ISLANDS, AOI);

  // The whole point: HYCOM's 4-7 km cells do not resolve these, so the mask must.
  // These are deepest-interior points with their clearance from the shoreline,
  // not centroids — Horn and West Ship are thin crescents whose centroids fall
  // in open water, and a bbox-corner point lands on the boundary.
  it('marks the barrier islands as land', () => {
    const islands: Array<[string, number, number]> = [
      ['Horn', -88.6812, 30.2376], // ~582 m clearance
      ['West Ship', -88.9713, 30.2104], // ~296 m
      ['East Ship', -88.8873, 30.2381], // ~195 m
      ['Cat', -89.094, 30.2256], // ~496 m
      ['Dauphin', -88.1074, 30.2487], // ~790 m
      ['Petit Bois', -88.4306, 30.2049], // ~356 m
    ];
    for (const [name, lon, lat] of islands) {
      assert.equal(pointOnLand(mask, AOI, lon, lat), true, `${name} Island must be land`);
    }
  });

  it('leaves open water in the Sound and the Bight unmasked', () => {
    const water: Array<[string, number, number]> = [
      ['Mississippi Sound', -88.85, 30.3],
      ['south of the islands', -88.7, 30.0],
      ['open Bight', -88.5, 29.7],
      ['Lake Borgne side', -89.6, 30.1],
    ];
    for (const [name, lon, lat] of water) {
      assert.equal(pointOnLand(mask, AOI, lon, lat), false, `${name} must be water`);
    }
  });

  // Deliberately island-only: the mainland is many HYCOM cells wide and is
  // already no-data, so masking it would only risk swallowing real water.
  it('masks a small fraction of the AOI', () => {
    let land = 0;
    for (const v of mask) {
      if (v === 255) {
        land++;
      }
    }
    const frac = land / (LAND_MASK_W * LAND_MASK_H);
    assert.ok(frac > 0 && frac < 0.02, `island land fraction ${frac.toFixed(5)} is implausible`);
  });
});

describe('pointOnLand', () => {
  it('returns false outside the mask bounds rather than wrapping', () => {
    const mask = rasterizeLandMask([square(0, 0, 1, 1)], unit, 32, 32);
    assert.equal(pointOnLand(mask, unit, -0.5, 0.5, 32, 32), false);
    assert.equal(pointOnLand(mask, unit, 1.5, 0.5, 32, 32), false);
    assert.equal(pointOnLand(mask, unit, 0.5, -0.5, 32, 32), false);
    assert.equal(pointOnLand(mask, unit, 0.5, 1.5, 32, 32), false);
  });
});

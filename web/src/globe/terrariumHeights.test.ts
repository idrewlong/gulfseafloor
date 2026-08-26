import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeTerrarium } from '../terrain/terrarium.ts';
import { heightsFromRgba } from './terrariumHeights.ts';

describe('heightsFromRgba', () => {
  it('keeps slippy PNG north-up order (Cesium heightmaps are north to south)', () => {
    // 2×2: north-west = +10 m, north-east = +4 m, south-west = −8 m, south-east = −20 m.
    const nw = encodeTerrarium(10);
    const ne = encodeTerrarium(4);
    const sw = encodeTerrarium(-8);
    const se = encodeTerrarium(-20);
    const rgba = new Uint8ClampedArray([
      ...nw, 255, ...ne, 255,
      ...sw, 255, ...se, 255,
    ]);
    const heights = heightsFromRgba(rgba, 2, 2);
    assert.equal(heights.length, 4);
    assert.ok(Math.abs(heights[0]! - 10) < 0.2, `NW ${heights[0]}`);
    assert.ok(Math.abs(heights[1]! - 4) < 0.2, `NE ${heights[1]}`);
    assert.ok(Math.abs(heights[2]! - -8) < 0.2, `SW ${heights[2]}`);
    assert.ok(Math.abs(heights[3]! - -20) < 0.2, `SE ${heights[3]}`);
  });
});

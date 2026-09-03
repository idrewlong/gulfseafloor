import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
  detectFloatOk,
  makePointGeometry,
  makeStaticArrows,
  makeTrailGeometry,
  TRAIL_SEGMENTS,
} from './currentsGpu.ts';
import { PARTICLE_COUNT, type VelocityGrid } from './currentsField.ts';

describe('makeTrailGeometry', () => {
  it('builds one line segment per trail segment per particle', () => {
    const geo = makeTrailGeometry();
    const verts = PARTICLE_COUNT * TRAIL_SEGMENTS * 2;
    assert.equal(geo.drawRange.count, verts);
    assert.equal(geo.getAttribute('position').count, verts);
    assert.equal(geo.getAttribute('aId').count, verts);
    assert.equal(geo.getAttribute('aT').count, verts);
  });

  // aT drives the head-to-tail alpha taper, so it must span the full range.
  it('spans aT from head to tail within one particle', () => {
    const geo = makeTrailGeometry();
    const at = geo.getAttribute('aT').array as Float32Array;
    const id = geo.getAttribute('aId').array as Float32Array;
    assert.equal(at[0], 0);
    assert.equal(id[0], 0);
    const lastVert = TRAIL_SEGMENTS * 2 - 1;
    assert.equal(at[lastVert], 1);
    assert.equal(id[lastVert], 0);
    assert.equal(id[lastVert + 1], 1, 'the next particle starts a new trail');
  });
});

describe('makePointGeometry', () => {
  it('has one vertex per particle so the field is visible as dots', () => {
    const geo = makePointGeometry();
    assert.equal(geo.drawRange.count, PARTICLE_COUNT);
    assert.equal(geo.getAttribute('position').count, PARTICLE_COUNT);
  });
});

function singleCellGrid(u: number, v: number): VelocityGrid {
  return {
    nx: 1,
    ny: 1,
    bbox: { west: -90, south: 30, east: -89, north: 31 },
    u: [u],
    v: [v],
  };
}

describe('makeStaticArrows', () => {
  // The reduced-motion / no-float-texture fallback path: below this speed an
  // arrow is noise, not signal (ARROW_MIN_MS = 0.02 m/s in currents.ts).
  it('drops a cell below the speed floor', () => {
    const group = makeStaticArrows(singleCellGrid(0.01, 0));
    const lines = group.children[0] as THREE.LineSegments;
    assert.equal(lines.geometry.getAttribute('position').count, 0);
  });

  it('draws a shaft plus a two-segment arrowhead for a surviving cell', () => {
    const group = makeStaticArrows(singleCellGrid(1, 0));
    const lines = group.children[0] as THREE.LineSegments;
    const pos = lines.geometry.getAttribute('position');
    // One shaft segment + two barbs = 3 line segments = 6 vertices.
    assert.equal(pos.count, 6);
  });

  it('carries a per-vertex color attribute the same length as position', () => {
    const group = makeStaticArrows(singleCellGrid(1, 0));
    const lines = group.children[0] as THREE.LineSegments;
    const pos = lines.geometry.getAttribute('position');
    const col = lines.geometry.getAttribute('color');
    assert.ok(col, 'color attribute must exist');
    assert.equal(col.count, pos.count);
    assert.equal(col.array.length, pos.array.length);
  });
});

describe('detectFloatOk', () => {
  it('returns false when extension lookup throws', () => {
    const renderer = {
      extensions: {
        has(): boolean {
          throw new Error('no webgl');
        },
      },
    };
    assert.equal(detectFloatOk(renderer), false);
  });
});

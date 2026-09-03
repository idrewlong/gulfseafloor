import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFloatOk, makePointGeometry, makeTrailGeometry, TRAIL_SEGMENTS } from './currentsGpu.ts';
import { PARTICLE_COUNT } from './currentsField.ts';

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

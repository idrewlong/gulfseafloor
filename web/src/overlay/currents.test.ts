import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFloatOk, makeTrailGeometry } from './currentsGpu.ts';
import { PARTICLE_COUNT } from './currentsField.ts';

describe('makeTrailGeometry', () => {
  it('has a finite draw range and a dummy position for particle segments', () => {
    const geo = makeTrailGeometry();
    const verts = PARTICLE_COUNT * 2;
    assert.equal(geo.drawRange.start, 0);
    assert.equal(geo.drawRange.count, verts);
    const pos = geo.getAttribute('position');
    assert.ok(pos);
    assert.equal(pos.count, verts);
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

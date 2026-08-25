import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { msToKnots, barbCounts, barbSvg } from './windBarb.ts';

describe('barbCounts', () => {
  it('maps 0, 5, 10, 50 kt', () => {
    assert.deepEqual(barbCounts(0), { pennants: 0, full: 0, half: false, calm: true });
    assert.deepEqual(barbCounts(5), { pennants: 0, full: 0, half: true, calm: false });
    assert.deepEqual(barbCounts(10), { pennants: 0, full: 1, half: false, calm: false });
    assert.deepEqual(barbCounts(50), { pennants: 1, full: 0, half: false, calm: false });
  });
});

describe('msToKnots', () => {
  it('converts 6.2 m/s', () => {
    assert.ok(Math.abs(msToKnots(6.2) - 12.0518) < 1e-3);
  });
});

describe('barbSvg', () => {
  it('uses a circle for calm and a path for wind', () => {
    assert.match(barbSvg(0, 0), /circle/);
    assert.match(barbSvg(180, 6.2), /path/);
    assert.doesNotMatch(barbSvg(180, 6.2), /#C0006E/i);
  });
});

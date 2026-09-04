import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rampFraction } from './inspector.ts';

describe('rampFraction', () => {
  it('pins the ends and lands strictly between them', () => {
    assert.equal(rampFraction(-200, -200, 0), 0);
    assert.equal(rampFraction(0, -200, 0), 1);
    const mid = rampFraction(-100, -200, 0);
    assert.ok(mid > 0 && mid < 1, `midpoint off the rail: ${mid}`);
  });

  // The rail is symmetric-log, not linear: -100 m is the arithmetic midpoint
  // of -200..0 but sits well below the halfway mark, because the shallow end
  // is given the room. This is the property that keeps a -2500 m window from
  // spending its whole length on abyssal navy.
  it('weights the rail toward the shallows', () => {
    assert.ok(rampFraction(-100, -200, 0) < 0.2);
    assert.ok(rampFraction(-10, -200, 0) > 0.5);
    assert.ok(rampFraction(-1, -200, 0) > 0.8);
  });

  it('increases monotonically as the seafloor rises', () => {
    let prev = rampFraction(-2500, -2500, 12);
    for (const e of [-1000, -200, -50, -10, -2, 0, 6, 12]) {
      const f = rampFraction(e, -2500, 12);
      assert.ok(f > prev, `rail must rise at ${e} m: ${f} <= ${prev}`);
      prev = f;
    }
  });

  it('clamps rather than running the tick off the rail', () => {
    // The legend covers a fixed range; a pick outside it (a deeper trench, a
    // dune above the top of the ramp) must park at the end, not overflow the
    // card.
    assert.equal(rampFraction(-900, -200, 0), 0);
    assert.equal(rampFraction(50, -200, 0), 1);
  });

  it('does not divide by zero on a degenerate range', () => {
    assert.equal(rampFraction(-10, 0, 0), 0);
    assert.equal(rampFraction(-10, 5, -5), 0);
  });
});

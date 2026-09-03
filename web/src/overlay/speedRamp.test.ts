import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SPEED_MAX_MS, speedColor, speedLegendTicks, speedRampCss } from './speedRamp.ts';

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('speedColor', () => {
  it('stays in gamut and clamps outside the range', () => {
    for (const s of [-1, 0, 0.3, 0.8, SPEED_MAX_MS, 99]) {
      const c = speedColor(s);
      assert.equal(c.length, 3);
      for (const ch of c) {
        assert.ok(ch >= 0 && ch <= 1, `channel ${ch} out of gamut at ${s} m/s`);
      }
    }
    assert.deepEqual(speedColor(99), speedColor(SPEED_MAX_MS));
    assert.deepEqual(speedColor(-1), speedColor(0));
  });

  // Faster must read brighter, or the ramp carries no information at a glance.
  it('increases in luminance with speed', () => {
    let prev = -1;
    for (let s = 0; s <= SPEED_MAX_MS; s += SPEED_MAX_MS / 16) {
      const lum = luminance(speedColor(s));
      assert.ok(lum > prev, `luminance must rise at ${s} m/s`);
      prev = lum;
    }
  });
});

describe('speedRampCss', () => {
  it('is a gradient with several stops', () => {
    const css = speedRampCss();
    assert.ok(css.startsWith('linear-gradient('));
    assert.ok(css.split('rgb(').length > 4);
  });
});

describe('speedLegendTicks', () => {
  it('labels in knots across the full ramp', () => {
    const ticks = speedLegendTicks();
    assert.ok(ticks.length >= 3);
    assert.equal(ticks[0]!.frac, 0);
    assert.equal(ticks[ticks.length - 1]!.frac, 1);
    for (const tick of ticks) {
      assert.match(tick.label, /kt$/);
    }
  });
});

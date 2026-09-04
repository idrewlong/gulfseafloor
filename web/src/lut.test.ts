import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { legendGradientCss, unlitBaseColor } from './lut.ts';
import { DEFAULT_DEPTH_MIN } from './viewerConfig.ts';

function assertRgb(got: readonly number[], want: readonly number[]): void {
  assert.equal(got.length, 3);
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(got[i]! - want[i]!);
    assert.ok(d < 1e-5, `channel ${i}: ${got[i]} vs ${want[i]}`);
  }
}

describe('unlitBaseColor', () => {
  // The shader reads uDepthMin, so parity has to be checked at a stated window
  // rather than at whichever one happens to be the default.
  it('matches the terrain shader gulf water at −30 m in a −30 m window', () => {
    assertRgb(unlitBaseColor(-30, -30), [0.23307903697796845, 0.28820468582653047, 0.36827312542437396]);
  });

  // The shelf is the largest water surface on the chart. Against the -2500 m
  // window the old window-relative `gulf` stretch collapsed 10-200 m to about
  // 2.8 RGB units — visually one flat colour. Guard the fix.
  it('keeps the shelf legible: 10-200 m must progress, not sit flat', () => {
    const sep = (a: number, b: number) => {
      const [x, y] = [unlitBaseColor(a), unlitBaseColor(b)];
      return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!) * 255;
    };
    assert.ok(sep(-10, -200) > 30, `shelf separation collapsed to ${sep(-10, -200).toFixed(1)}`);
    assert.ok(sep(-200, -2500) > 10, `slope separation collapsed to ${sep(-200, -2500).toFixed(1)}`);
    // Monotone: every step further down must keep getting darker.
    let prev = unlitBaseColor(-8);
    for (const d of [-20, -50, -100, -200, -500, -1000, -2500]) {
      const c = unlitBaseColor(d);
      assert.ok(c[2]! < prev[2]!, `blue channel must fall by ${d} m`);
      prev = c;
    }
  });

  it('defaults to the viewer depth window, so the legend cannot drift from the shader', () => {
    assertRgb(unlitBaseColor(-30), unlitBaseColor(-30, DEFAULT_DEPTH_MIN));
  });

  it('matches the terrain shader sand/water mix at 0 m', () => {
    assertRgb(unlitBaseColor(0), [0.608364, 0.557424, 0.406611]);
  });

  it('matches the terrain shader scrub at +4 m', () => {
    assertRgb(unlitBaseColor(4), [0.38, 0.44, 0.3]);
  });

  it('paints Sound-scale shallows as water, not a sand bed', () => {
    const sound = unlitBaseColor(-2);
    assert.ok(
      sound[1] > sound[0] && sound[2] > sound[0],
      `−2 m should read as teal water, got ${sound.join(', ')}`,
    );
  });
});

describe('legendGradientCss', () => {
  it('puts −30 m gulf at the bottom and +12 m scrub at the top', () => {
    const css = legendGradientCss(-30, 12, -30);
    assert.match(css, /^linear-gradient\(to top,/);
    assert.match(css, /rgb\(59, 73, 94\) 0\.0%/);
    assert.match(css, /rgb\(97, 112, 77\) 100\.0%\)$/);
  });
});

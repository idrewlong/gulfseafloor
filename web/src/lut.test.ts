import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { legendGradientCss, unlitBaseColor } from './lut.ts';

function assertRgb(got: readonly number[], want: readonly number[]): void {
  assert.equal(got.length, 3);
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(got[i]! - want[i]!);
    assert.ok(d < 1e-5, `channel ${i}: ${got[i]} vs ${want[i]}`);
  }
}

describe('unlitBaseColor', () => {
  it('matches the terrain shader gulf water at −30 m', () => {
    assertRgb(unlitBaseColor(-30), [0.30457394438860674, 0.4480201319755779, 0.5119399604636186]);
  });

  it('matches the terrain shader sand/water mix at 0 m', () => {
    assertRgb(unlitBaseColor(0), [0.608364, 0.557424, 0.406611]);
  });

  it('matches the terrain shader scrub at +4 m', () => {
    assertRgb(unlitBaseColor(4), [0.38, 0.44, 0.3]);
  });
});

describe('legendGradientCss', () => {
  it('puts −80 m gulf at the bottom and +12 m scrub at the top', () => {
    const css = legendGradientCss(-80, 12);
    assert.match(css, /^linear-gradient\(to top,/);
    assert.match(css, /rgb\(73, 111, 130\) 0%/);
    assert.match(css, /rgb\(97, 112, 77\) 100%\)$/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LAYER_NAMES,
  VIEW_STATE_VERSION,
  decodeViewState,
  encodeViewState,
  type ViewState,
} from './viewState.ts';

const base: ViewState = {
  lon: -89.1234,
  lat: 30.4567,
  dist: 180_000,
  polar: 12.5,
  timeMs: null,
  layers: { radar: true, sky: false, currents: true, buoys: false, aircraft: true },
  exaggeration: 1,
  contourInterval: 10,
  sunAzimuth: 315,
  sunAltitude: 38,
  units: 'm',
};

const defaults = {
  exaggeration: 1,
  contourInterval: 10,
  sunAzimuth: 315,
  sunAltitude: 38,
  units: 'm' as const,
};

describe('viewState round trip', () => {
  it('restores the camera, the clock and the layers', () => {
    const back = decodeViewState(encodeViewState(base, defaults));
    assert.equal(back.lon, -89.1234);
    assert.equal(back.lat, 30.4567);
    assert.equal(back.dist, 180_000);
    assert.equal(back.polar, 12.5);
    assert.equal(back.timeMs, null);
    assert.deepEqual(back.layers, base.layers);
  });

  it('restores a pinned time rather than snapping back to live', () => {
    const at = Date.UTC(2026, 8, 4, 14, 30);
    const back = decodeViewState(encodeViewState({ ...base, timeMs: at }, defaults));
    assert.equal(back.timeMs, at);
  });

  it('restores every layer combination exactly', () => {
    for (const name of LAYER_NAMES) {
      const layers = { radar: false, sky: false, currents: false, buoys: false, aircraft: false };
      layers[name] = true;
      const back = decodeViewState(encodeViewState({ ...base, layers }, defaults));
      assert.deepEqual(back.layers, layers, `only ${name} should be on`);
    }
  });

  it('survives every layer being off', () => {
    const layers = { radar: false, sky: false, currents: false, buoys: false, aircraft: false };
    const back = decodeViewState(encodeViewState({ ...base, layers }, defaults));
    assert.deepEqual(back.layers, layers);
  });

  it('carries the shading dials when they differ from the defaults', () => {
    const moved: ViewState = {
      ...base,
      exaggeration: 12,
      contourInterval: 50,
      sunAzimuth: 90,
      sunAltitude: 70,
      units: 'ft',
    };
    const back = decodeViewState(encodeViewState(moved, defaults));
    assert.equal(back.exaggeration, 12);
    assert.equal(back.contourInterval, 50);
    assert.equal(back.sunAzimuth, 90);
    assert.equal(back.sunAltitude, 70);
    assert.equal(back.units, 'ft');
  });

  // A URL nobody has touched should be short enough to paste into a chat
  // message without wrapping.
  it('omits dials that sit at their defaults', () => {
    const hash = encodeViewState(base, defaults);
    assert.ok(!hash.includes('x='), 'default exaggeration should not be written');
    assert.ok(!hash.includes('ci='), 'default contour interval should not be written');
    assert.ok(!hash.includes('s='), 'default sun should not be written');
    assert.ok(!hash.includes('u='), 'default units should not be written');
  });
});

describe('viewState validation', () => {
  it('ignores an empty or junk hash', () => {
    assert.deepEqual(decodeViewState(''), {});
    assert.deepEqual(decodeViewState('#'), {});
    assert.deepEqual(decodeViewState('#not-a-query'), {});
  });

  it('ignores a hash from a future format', () => {
    assert.deepEqual(decodeViewState(`#v=${VIEW_STATE_VERSION + 1}&c=-89,30,1000,0`), {});
  });

  it('drops an off-globe camera but keeps the rest of the URL', () => {
    const back = decodeViewState(`#v=1&c=-999,999,50000,10&t=live`);
    assert.equal(back.lon, undefined, 'an impossible longitude must not reach the camera');
    assert.equal(back.dist, 50_000, 'the salvageable half of the URL still applies');
    assert.equal(back.timeMs, null);
  });

  it('rejects a non-finite or negative distance', () => {
    for (const bad of ['NaN', 'Infinity', '-5', 'abc']) {
      const back = decodeViewState(`#v=1&c=-89,30,${bad},10`);
      assert.equal(back.dist, undefined, `distance ${bad} must be rejected`);
    }
  });

  it('clamps tilt into the range the controls allow', () => {
    assert.ok((decodeViewState('#v=1&c=-89,30,1000,89').polar ?? 0) < 89);
    assert.ok((decodeViewState('#v=1&c=-89,30,1000,-40').polar ?? 0) >= 0);
  });

  it('clamps exaggeration to the slider range', () => {
    assert.equal(decodeViewState('#v=1&x=9999').exaggeration, 50);
    assert.equal(decodeViewState('#v=1&x=-3').exaggeration, 1);
  });

  it('accepts only contour intervals the UI actually offers', () => {
    assert.equal(decodeViewState('#v=1&ci=50').contourInterval, 50);
    assert.equal(decodeViewState('#v=1&ci=7').contourInterval, undefined);
  });

  it('wraps sun azimuth as a bearing and clamps altitude', () => {
    assert.equal(decodeViewState('#v=1&s=370,38').sunAzimuth, 10);
    assert.equal(decodeViewState('#v=1&s=-10,38').sunAzimuth, 350);
    assert.equal(decodeViewState('#v=1&s=315,999').sunAltitude, 85);
  });

  it('rejects a nonsense timestamp rather than scrubbing to year 275760', () => {
    assert.equal(decodeViewState('#v=1&t=99999999999999999').timeMs, undefined);
    assert.equal(decodeViewState('#v=1&t=-5').timeMs, undefined);
    assert.equal(decodeViewState('#v=1&t=banana').timeMs, undefined);
  });

  it('ignores an unknown depth unit', () => {
    assert.equal(decodeViewState('#v=1&u=fathoms').units, undefined);
    assert.equal(decodeViewState('#v=1&u=ft').units, 'ft');
  });

  it('ignores unknown layer names without disturbing the known ones', () => {
    const back = decodeViewState('#v=1&l=currents,sharks');
    assert.deepEqual(back.layers, {
      radar: false,
      sky: false,
      currents: true,
      buoys: false,
      aircraft: false,
    });
  });
});

// The point of the hash is that a person can read it, paste it into a chat
// message, and see at a glance what view it names.
describe('viewState readability', () => {
  it('leaves commas unescaped so the link stays legible', () => {
    const hash = encodeViewState(base, defaults);
    assert.ok(!hash.includes('%2C'), `commas should not be percent-encoded: ${hash}`);
    assert.ok(hash.includes('c=-89.1234,30.4567,'), `camera should read plainly: ${hash}`);
    assert.ok(hash.includes('l=radar,currents,aircraft'), `layers should read plainly: ${hash}`);
  });

  it('still round-trips with unescaped commas', () => {
    const back = decodeViewState(encodeViewState(base, defaults));
    assert.equal(back.lon, base.lon);
    assert.equal(back.lat, base.lat);
    assert.deepEqual(back.layers, base.layers);
  });
});

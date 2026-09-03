import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUOY_RANK,
  availabilityFromHttp,
  buoyReadout,
  currentsCaption,
  defaultOn,
  formatValidZ,
  oceanCaption,
  unavailableOceanResponse,
} from './oceanUi.ts';
import type { VelocityStack } from './currentsField.ts';

describe('BUOY_RANK', () => {
  it('is 10 so places outrank buoys', () => {
    assert.equal(BUOY_RANK, 10);
  });
});

describe('availabilityFromHttp', () => {
  it('treats 404 as both layers unavailable', () => {
    assert.deepEqual(availabilityFromHttp(404, 404), { currents: false, buoys: false });
  });

  it('keeps the 200 side on when the other is 404', () => {
    assert.deepEqual(availabilityFromHttp(200, 404), { currents: true, buoys: false });
    assert.deepEqual(availabilityFromHttp(404, 200), { currents: false, buoys: true });
  });

  it('is true only for HTTP 200', () => {
    assert.deepEqual(availabilityFromHttp(200, 200), { currents: true, buoys: true });
    assert.deepEqual(availabilityFromHttp(500, 201), { currents: false, buoys: false });
  });
});

describe('defaultOn', () => {
  it('starts off even when both layers are available', () => {
    assert.deepEqual(defaultOn({ currents: true, buoys: true }), { currents: false, buoys: false });
    assert.deepEqual(defaultOn({ currents: true, buoys: false }), { currents: false, buoys: false });
    assert.deepEqual(defaultOn({ currents: false, buoys: true }), { currents: false, buoys: false });
  });
});

describe('unavailableOceanResponse', () => {
  it('is 404 so fetch failures disable both layers', () => {
    const res = unavailableOceanResponse();
    assert.equal(res.status, 404);
    assert.deepEqual(availabilityFromHttp(res.status, res.status), { currents: false, buoys: false });
  });

  it('does not use status 0, which Response rejects', () => {
    assert.throws(() => new Response(null, { status: 0 }));
  });
});

describe('formatValidZ', () => {
  it('uses hour-only Z when minutes are zero', () => {
    assert.equal(formatValidZ('2026-08-24T18:00:00Z'), '18Z');
  });

  it('keeps HH:mmZ when minutes are nonzero', () => {
    assert.equal(formatValidZ('2026-08-24T19:50:00Z'), '19:50Z');
  });
});

describe('oceanCaption', () => {
  it('is empty when both valid times are missing', () => {
    assert.equal(oceanCaption(null, null), '');
  });

  it('joins both sides with a middle dot', () => {
    assert.equal(
      oceanCaption('2026-08-24T18:00:00Z', '2026-08-24T19:50:00Z'),
      'Currents HYCOM 18Z · Buoys NDBC 19:50Z',
    );
  });

  it('omits a side when that valid time is null', () => {
    assert.equal(oceanCaption('2026-08-24T18:00:00Z', null), 'Currents HYCOM 18Z');
    assert.equal(oceanCaption(null, '2026-08-24T19:50:00Z'), 'Buoys NDBC 19:50Z');
  });
});

const capT0 = Date.parse('2026-09-03T12:00:00Z');
const capT1 = Date.parse('2026-09-03T15:00:00Z');
const capStack: VelocityStack = {
  nx: 1, ny: 1,
  bbox: { west: -90, south: 29, east: -87, north: 31 },
  times: [capT0, capT1],
  u: [[0], [0]], v: [[0], [0]],
};

describe('currentsCaption', () => {
  // Model output must never read as observation.
  it('names the bracketing forecast hours', () => {
    const caption = currentsCaption(capStack, capT0 + 80 * 60 * 1000);
    assert.equal(caption, 'Currents HYCOM 13:20Z · interpolated 12Z→15Z');
  });

  it('marks a field outside its window as stale', () => {
    const caption = currentsCaption(capStack, capT1 + 3600_000);
    assert.match(caption, /· stale$/);
  });

  // bracket() clamps to i0===i1 exactly at a window endpoint, which used to
  // drop the interpolation clause entirely and leave a bare timestamp — the
  // one moment the caption would stop reading as model output.
  it('names the forecast hour instead of going bare exactly on a step boundary', () => {
    assert.equal(currentsCaption(capStack, capT0), 'Currents HYCOM 12Z · forecast hour 12Z');
    assert.equal(currentsCaption(capStack, capT1), 'Currents HYCOM 15Z · forecast hour 15Z');
  });

  it('is empty without a stack', () => {
    assert.equal(currentsCaption(null, capT0), '');
  });
});

describe('buoyReadout', () => {
  it('formats wind in knots to one decimal and omits missing lines', () => {
    const full = buoyReadout({
      id: 'WYCM6',
      name: 'Gulfport Harbor',
      lon: -89.081,
      lat: 30.36,
      wdir: 180,
      wspd: 6.2,
      gst: 8.1,
      wvht: 0.4,
      wtmp: 29.1,
      obsTime: '2026-08-24T19:50:00Z',
    });
    assert.equal(
      full,
      [
        'WYCM6',
        'Gulfport Harbor',
        '180° / 12.1 kt',
        'Gust 15.7 kt',
        'Wave 0.4 m',
        'Water 29.1 °C',
        '2026-08-24T19:50:00Z',
      ].join('\n'),
    );

    const sparse = buoyReadout({ id: 'WYCM6', lon: -89.081, lat: 30.36 });
    assert.equal(sparse, 'WYCM6');
  });
});

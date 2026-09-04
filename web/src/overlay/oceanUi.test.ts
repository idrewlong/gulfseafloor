import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGING_AFTER_MS,
  BUOY_RANK,
  STALE_AFTER_MS,
  availabilityFromHttp,
  buoyReadout,
  currentsCaption,
  defaultOn,
  formatAge,
  formatValidZ,
  freshnessOf,
  obsAgeMs,
  oceanCaption,
  stationRows,
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
  // Pinned so the reported age is deterministic rather than clock-dependent.
  const now = Date.parse('2026-08-24T20:12:00Z');

  it('formats wind in knots to one decimal and omits missing lines', () => {
    const full = buoyReadout(
      {
        id: 'WYCM6',
        name: 'Gulfport Harbor',
        kind: 'fixed',
        lon: -89.081,
        lat: 30.36,
        wdir: 180,
        wspd: 6.2,
        gst: 8.1,
        wvht: 0.4,
        wtmp: 29.1,
        obsTime: '2026-08-24T19:50:00Z',
      },
      now,
    );
    assert.equal(
      full,
      [
        'WYCM6',
        'Gulfport Harbor',
        'Fixed station',
        'Wind 180\u00b0 / 12.1 kt',
        'Gust 15.7 kt',
        'Wave 0.4 m',
        'Water 29.1 \u00b0C',
        // Spelled out rather than left as a raw ISO stamp: the age is the
        // fact a reader needs, and it is the one they would have to compute.
        'Observed 22 min ago',
      ].join('\n'),
    );

    const sparse = buoyReadout({ id: 'WYCM6', lon: -89.081, lat: 30.36 }, now);
    assert.equal(sparse, ['WYCM6', 'Station', 'Observed no obs time'].join('\n'));
  });
});

describe('obsAgeMs', () => {
  const now = Date.parse('2026-09-03T21:00:00Z');

  it('is null without an obs time, and never negative', () => {
    assert.equal(obsAgeMs(undefined, now), null);
    assert.equal(obsAgeMs('not a date', now), null);
    // A station timestamped slightly ahead of a skewed client clock must
    // read as brand new, not as a negative age.
    assert.equal(obsAgeMs('2026-09-03T21:05:00Z', now), 0);
  });

  it('measures elapsed time from the obs stamp', () => {
    assert.equal(obsAgeMs('2026-09-03T20:30:00Z', now), 30 * 60 * 1000);
  });
});

describe('freshnessOf', () => {
  it('grades on the hour and six-hour boundaries', () => {
    assert.equal(freshnessOf(null), 'unknown');
    assert.equal(freshnessOf(0), 'fresh');
    assert.equal(freshnessOf(AGING_AFTER_MS - 1), 'fresh');
    assert.equal(freshnessOf(AGING_AFTER_MS), 'aging');
    assert.equal(freshnessOf(STALE_AFTER_MS - 1), 'aging');
    assert.equal(freshnessOf(STALE_AFTER_MS), 'stale');
  });

  it('calls a six-week-old observation stale', () => {
    // The real case this exists for: station 42067 sat in the AOI snapshot
    // reporting a July timestamp while the map drew it like a live station.
    assert.equal(freshnessOf(42 * 24 * 60 * 60 * 1000), 'stale');
  });
});

describe('formatAge', () => {
  it('scales the unit to the age', () => {
    assert.equal(formatAge(null), 'no obs time');
    assert.equal(formatAge(30 * 1000), 'just now');
    assert.equal(formatAge(22 * 60 * 1000), '22 min');
    assert.equal(formatAge(9 * 60 * 60 * 1000), '9 h');
    assert.equal(formatAge(8 * 24 * 60 * 60 * 1000), '8 d');
  });
});

describe('stationRows', () => {
  const now = Date.parse('2026-09-03T21:00:00Z');

  it('omits fields the station did not report but always states the age', () => {
    const rows = stationRows(
      { id: 'OSTF1', lon: -89.6, lat: 30.3, wtmp: 30.4, obsTime: '2026-09-03T20:38:00Z' },
      now,
    );
    assert.deepEqual(rows, [
      { label: 'Water', value: '30.4 \u00b0C' },
      { label: 'Observed', value: '22 min ago' },
    ]);
  });
});

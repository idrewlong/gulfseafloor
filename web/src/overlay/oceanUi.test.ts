import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BUOY_RANK,
  availabilityFromHttp,
  buoyReadout,
  defaultOn,
  formatValidZ,
  oceanCaption,
  unavailableOceanResponse,
} from './oceanUi.ts';

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

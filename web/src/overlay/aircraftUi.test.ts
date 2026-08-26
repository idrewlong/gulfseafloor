import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AIRCRAFT_RANK,
  AIRCRAFT_POLL_MS,
  AIRCRAFT_REPROBE_MS,
  aircraftAvailable,
  aircraftCaption,
  aircraftChromeHidden,
  aircraftPollIntervalMs,
  aircraftReadout,
  deadReckon,
  shouldPollAircraft,
  shouldReprobeAircraft,
} from './aircraftUi.ts';

describe('aircraftAvailable', () => {
  it('is true only for HTTP 200', () => {
    assert.equal(aircraftAvailable(200), true);
    assert.equal(aircraftAvailable(404), false);
    assert.equal(aircraftAvailable(500), false);
  });
});

describe('aircraftChromeHidden', () => {
  it('hides on globe and shows on bathymetry', () => {
    assert.equal(aircraftChromeHidden('globe'), true);
    assert.equal(aircraftChromeHidden('bathymetry'), false);
  });
});

describe('aircraftCaption', () => {
  it('names the feed and compact Z time', () => {
    assert.equal(aircraftCaption('opensky', '2026-08-26T02:00:00Z'), 'Aircraft OpenSky 02:00Z');
    assert.equal(aircraftCaption('adsb.lol', '2026-08-26T02:10:00Z'), 'Aircraft adsb.lol 02:10Z');
    assert.equal(aircraftCaption(null, null), '');
  });
});

describe('aircraftReadout', () => {
  it('formats every available field', () => {
    assert.equal(
      aircraftReadout({
        icao24: 'abc123',
        callsign: 'UAL123',
        lon: -89,
        lat: 30,
        altBaroM: 3200,
        trackDeg: 270,
        gsMps: 100,
        onGround: false,
      }),
      ['UAL123', 'abc123', '3200 m', '270°', '194.4 kt'].join('\n'),
    );
  });

  it('omits altitude when missing', () => {
    assert.equal(
      aircraftReadout({
        icao24: 'abc123',
        lon: -89,
        lat: 30,
        trackDeg: 270,
        gsMps: 100,
      }),
      ['abc123', '270°', '194.4 kt'].join('\n'),
    );
  });
});

describe('deadReckon', () => {
  it('moves north at 111.32 m/s for 1s near the equator-ish test lat', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 0, gsMps: 111.32, onGround: false };
    const got = deadReckon(a, 1);
    assert.ok(Math.abs(got.lon + 89) < 1e-8);
    assert.ok(got.lat > 30.0009 && got.lat < 30.0011);
  });

  it('does not coast when onGround is omitted', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 90, gsMps: 100 };
    assert.deepEqual(deadReckon(a, 10), { lon: -89, lat: 30 });
  });

  it('does not coast when reduced-motion caller passes dt 0', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 90, gsMps: 100, onGround: false };
    assert.deepEqual(deadReckon(a, 0), { lon: -89, lat: 30 });
  });

  it('clamps coasting to about two poll intervals', () => {
    const a = { icao24: 'x', lon: -89, lat: 30, trackDeg: 0, gsMps: 111.32, onGround: false };
    const capped = deadReckon(a, 20);
    const acrossGap = deadReckon(a, 600);
    assert.deepEqual(acrossGap, capped);
    assert.ok(capped.lat > 30.019 && capped.lat < 30.021);
  });
});

describe('AIRCRAFT_RANK', () => {
  it('is 20 so places and buoys outrank aircraft', () => {
    assert.equal(AIRCRAFT_RANK, 20);
  });
});

describe('shouldPollAircraft', () => {
  const on = { layerOn: true, documentHidden: false, available: true };
  it('polls only on bathymetry while visible and enabled', () => {
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on }), true);
    assert.equal(shouldPollAircraft({ mode: 'globe', ...on }), false);
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on, documentHidden: true }), false);
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on, layerOn: false }), false);
    assert.equal(shouldPollAircraft({ mode: 'bathymetry', ...on, available: false }), false);
  });
});

describe('shouldReprobeAircraft', () => {
  it('reprobes a dead feed slowly while bathymetry is visible', () => {
    assert.equal(
      shouldReprobeAircraft({
        mode: 'bathymetry',
        documentHidden: false,
        available: false,
        primed: true,
      }),
      true,
    );
    assert.equal(
      shouldReprobeAircraft({
        mode: 'globe',
        documentHidden: false,
        available: false,
        primed: true,
      }),
      false,
    );
    assert.equal(
      shouldReprobeAircraft({
        mode: 'bathymetry',
        documentHidden: true,
        available: false,
        primed: true,
      }),
      false,
    );
    assert.equal(
      shouldReprobeAircraft({
        mode: 'bathymetry',
        documentHidden: false,
        available: true,
        primed: true,
      }),
      false,
    );
    assert.equal(
      shouldReprobeAircraft({
        mode: 'bathymetry',
        documentHidden: false,
        available: false,
        primed: false,
      }),
      false,
    );
  });
});

describe('aircraftPollIntervalMs', () => {
  it('uses 10s while live and 60s after unavailable', () => {
    assert.equal(AIRCRAFT_POLL_MS, 10_000);
    assert.equal(AIRCRAFT_REPROBE_MS, 60_000);
    assert.equal(aircraftPollIntervalMs(true), 10_000);
    assert.equal(aircraftPollIntervalMs(false), 60_000);
  });
});

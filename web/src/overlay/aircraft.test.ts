import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AOI } from '../geo.ts';
import { type LabelCandidate } from '../ui/labelLayout.ts';
import { AIRCRAFT_ID_BASE, layoutAircraftVisibility, parseAircraftJson } from './aircraft.ts';
import { AIRCRAFT_RANK } from './aircraftUi.ts';
import { BUOY_RANK } from './oceanUi.ts';

describe('parseAircraftJson', () => {
  it('keeps a valid aircraft snapshot', () => {
    const parsed = parseAircraftJson({
      source: 'adsb.lol',
      fetchedAt: '2026-08-26T02:10:00Z',
      aircraft: [
        {
          icao24: 'abc123',
          callsign: 'UAL123',
          lon: -89.08,
          lat: 30.41,
          altBaroM: 3200,
          trackDeg: 270,
          gsMps: 80,
          onGround: false,
        },
      ],
    });
    assert.deepEqual(parsed, {
      source: 'adsb.lol',
      fetchedAt: '2026-08-26T02:10:00Z',
      aircraft: [
        {
          icao24: 'abc123',
          callsign: 'UAL123',
          lon: -89.08,
          lat: 30.41,
          altBaroM: 3200,
          trackDeg: 270,
          gsMps: 80,
          onGround: false,
        },
      ],
    });
  });

  it('drops rows missing icao24 or lon/lat', () => {
    const parsed = parseAircraftJson({
      source: 'opensky',
      fetchedAt: '2026-08-26T02:00:00Z',
      aircraft: [
        { icao24: 'abc123', lon: -89.08, lat: 30.41, trackDeg: 270, gsMps: 80, onGround: false },
        { icao24: '', lon: -89, lat: 30 },
        { lon: -89, lat: 30 },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.aircraft.length, 1);
    assert.equal(parsed.aircraft[0]?.icao24, 'abc123');
  });

  it('rejects an invalid snapshot envelope', () => {
    assert.equal(parseAircraftJson({ source: 'other', fetchedAt: 'now', aircraft: [] }), null);
    assert.equal(parseAircraftJson({ source: 'opensky', fetchedAt: '', aircraft: [] }), null);
    assert.equal(parseAircraftJson({ source: 'opensky', fetchedAt: 'now', aircraft: null }), null);
  });
});

describe('layoutAircraftVisibility', () => {
  const project = (lon: number, lat: number): { x: number; y: number } => ({ x: lon, y: lat });

  it('yields to a place or buoy at the same pixel', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const place = [{ id: 0, x: 100, y: 10, rank: 1 }];
    const { visible } = layoutAircraftVisibility(place, rows, project, 800, 400);
    assert.equal(visible.has(AIRCRAFT_ID_BASE), false);

    const buoy = [{ id: 1000, x: 100, y: 10, rank: BUOY_RANK }];
    const again = layoutAircraftVisibility(buoy, rows, project, 800, 400);
    assert.equal(again.visible.has(AIRCRAFT_ID_BASE), false);
  });

  it('uses AIRCRAFT_RANK 20', () => {
    assert.equal(AIRCRAFT_RANK, 20);
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const { candidates } = layoutAircraftVisibility([], rows, project, 800, 400);
    assert.equal(candidates[0]?.rank, 20);
  });

  it('merges extra candidates before resolving occupancy', () => {
    const extra: LabelCandidate[] = [{ id: 7, x: 100, y: 10, rank: 1 }];
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const { candidates, visible } = layoutAircraftVisibility(extra, rows, project, 800, 400);
    assert.deepEqual(candidates.map((candidate) => candidate.id), [7, AIRCRAFT_ID_BASE]);
    assert.deepEqual([...visible], [7]);
  });

  it('skips aircraft outside the AOI', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const { visible, candidates, positions } = layoutAircraftVisibility(
      [],
      rows,
      project,
      800,
      400,
      AOI,
    );
    assert.equal(visible.has(AIRCRAFT_ID_BASE), false);
    assert.deepEqual(candidates, []);
    assert.deepEqual(positions, [null]);
  });
});

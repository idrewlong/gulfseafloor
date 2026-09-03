import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AOI } from '../geo.ts';
import { type LabelCandidate } from '../ui/labelLayout.ts';
import {
  AIRCRAFT_EDGE_PAD_DEG,
  AIRCRAFT_ID_BASE,
  layoutAircraftVisibility,
  parseAircraftJson,
  planAircraftMarkReuse,
} from './aircraft.ts';
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
    assert.equal(parseAircraftJson({ source: 'opensky', fetchedAt: 'now', aircraft: 'nope' }), null);
  });

  it('treats null or missing aircraft as an empty list', () => {
    const missing = parseAircraftJson({ source: 'opensky', fetchedAt: '2026-08-26T02:00:00Z' });
    assert.deepEqual(missing, { source: 'opensky', fetchedAt: '2026-08-26T02:00:00Z', aircraft: [] });
    const nullable = parseAircraftJson({
      source: 'adsb.lol',
      fetchedAt: '2026-08-26T02:10:00Z',
      aircraft: null,
    });
    assert.deepEqual(nullable, { source: 'adsb.lol', fetchedAt: '2026-08-26T02:10:00Z', aircraft: [] });
  });
});

describe('layoutAircraftVisibility', () => {
  /** Ground plane at elev 0; altitude lifts the mark up-screen one pixel per 100 m. */
  const project = (lon: number, lat: number, elev: number): { x: number; y: number } => ({
    x: lon,
    y: lat - elev / 100,
  });

  it('draws every on-screen aircraft, and declutters only the callsigns', () => {
    const rows = [
      { icao24: 'aaa111', lon: 100, lat: 10 },
      { icao24: 'bbb222', lon: 104, lat: 10 },
    ];
    const { labelled, placements } = layoutAircraftVisibility([], rows, project, 800, 400);
    // Four pixels apart: the two callsigns cannot both be drawn...
    assert.equal(labelled.size, 1);
    // ...but neither aircraft may be dropped from the chart for it.
    assert.ok(placements[0]?.air);
    assert.ok(placements[1]?.air);
  });

  it('keeps the mark when a place or buoy label wins the same pixel', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const place = [{ id: 0, x: 100, y: 10, rank: 1 }];
    const { labelled, placements } = layoutAircraftVisibility(place, rows, project, 800, 400);
    assert.equal(labelled.has(AIRCRAFT_ID_BASE), false);
    assert.ok(placements[0]?.air);

    const buoy = [{ id: 1000, x: 100, y: 10, rank: BUOY_RANK }];
    const again = layoutAircraftVisibility(buoy, rows, project, 800, 400);
    assert.equal(again.labelled.has(AIRCRAFT_ID_BASE), false);
    assert.ok(again.placements[0]?.air);
  });

  it('lifts the mark to its altitude and foots the leader at sea level', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 300, altBaroM: 10_000 }];
    const { placements } = layoutAircraftVisibility([], rows, project, 800, 400);
    assert.deepEqual(placements[0]?.air, { x: 100, y: 200 });
    assert.deepEqual(placements[0]?.ground, { x: 100, y: 300 });
  });

  it('foots the leader under an aircraft reporting no altitude', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 300 }];
    const { placements } = layoutAircraftVisibility([], rows, project, 800, 400);
    assert.deepEqual(placements[0]?.air, { x: 100, y: 300 });
    assert.deepEqual(placements[0]?.ground, { x: 100, y: 300 });
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
    const { candidates, labelled } = layoutAircraftVisibility(extra, rows, project, 800, 400);
    assert.deepEqual(candidates.map((candidate) => candidate.id), [7, AIRCRAFT_ID_BASE]);
    assert.deepEqual([...labelled], [7]);
  });

  it('drops aircraft well outside the chart', () => {
    const rows = [{ icao24: 'abc123', lon: 100, lat: 10 }];
    const { labelled, candidates, placements } = layoutAircraftVisibility(
      [],
      rows,
      project,
      800,
      400,
      AOI,
    );
    assert.equal(labelled.has(AIRCRAFT_ID_BASE), false);
    assert.deepEqual(candidates, []);
    assert.deepEqual(placements, [{ air: null, ground: null }]);
  });

  it('holds a mark just past the chart edge so dead reckoning does not blink it', () => {
    // Projected straight through so the pad, not the viewport, decides.
    const flat = (lon: number, lat: number): { x: number; y: number } => ({
      x: 400 + lon,
      y: 200 + lat,
    });
    const justOutside = [{ icao24: 'abc123', lon: AOI.east + AIRCRAFT_EDGE_PAD_DEG / 2, lat: 30 }];
    assert.ok(layoutAircraftVisibility([], justOutside, flat, 800, 400, AOI).placements[0]?.air);

    const farOutside = [{ icao24: 'abc123', lon: AOI.east + AIRCRAFT_EDGE_PAD_DEG * 2, lat: 30 }];
    assert.equal(
      layoutAircraftVisibility([], farOutside, flat, 800, 400, AOI).placements[0]?.air,
      null,
    );
  });
});

describe('planAircraftMarkReuse', () => {
  it('reuses marks by icao24 when the set changes', () => {
    const plan = planAircraftMarkReuse(['aaa', 'bbb'], ['ccc', 'bbb']);
    assert.deepEqual(plan.reuse, ['bbb']);
    assert.deepEqual(plan.create, ['ccc']);
    assert.deepEqual(plan.remove, ['aaa']);
  });

  it('reuses every mark when identity is unchanged', () => {
    const plan = planAircraftMarkReuse(['aaa', 'bbb'], ['aaa', 'bbb']);
    assert.deepEqual(plan.reuse, ['aaa', 'bbb']);
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.remove, []);
  });
});

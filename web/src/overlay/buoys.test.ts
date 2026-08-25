import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buoyMarkEngaged, layoutBuoyVisibility, parseBuoysJson, type BuoyStation } from './buoys.ts';
import { BUOY_RANK } from './oceanUi.ts';

describe('parseBuoysJson', () => {
  it('keeps stations and validTime from a 200 payload', () => {
    const parsed = parseBuoysJson({
      validTime: '2026-08-24T19:50:00Z',
      stations: [
        {
          id: 'WYCM6',
          name: 'Gulfport Harbor',
          lon: -89.081,
          lat: 30.36,
          wdir: 180,
          wspd: 6.2,
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.validTime, '2026-08-24T19:50:00Z');
    assert.equal(parsed.stations.length, 1);
    assert.equal(parsed.stations[0]?.id, 'WYCM6');
    assert.equal(parsed.stations[0]?.wspd, 6.2);
  });

  it('drops a station missing id or lon/lat', () => {
    const parsed = parseBuoysJson({
      validTime: '2026-08-24T19:50:00Z',
      stations: [{ id: '', lon: -89, lat: 30 }, { lon: -89, lat: 30 }, { id: 'OK', lon: -89, lat: 30 }],
    });
    assert.ok(parsed);
    assert.deepEqual(
      parsed.stations.map((s) => s.id),
      ['OK'],
    );
  });
});

describe('layoutBuoyVisibility', () => {
  const project = (lon: number, lat: number): { x: number; y: number } => ({
    x: lon,
    y: lat,
  });

  it('uses ids 1000+index and BUOY_RANK', () => {
    const stations: BuoyStation[] = [
      { id: 'A', lon: 200, lat: 10 },
      { id: 'B', lon: 400, lat: 10 },
    ];
    const { visible, candidates } = layoutBuoyVisibility([], stations, project, 800, 400);
    assert.equal(visible.has(1000), true);
    assert.equal(visible.has(1001), true);
    assert.deepEqual(
      candidates.map((c) => ({ id: c.id, rank: c.rank })),
      [
        { id: 1000, rank: BUOY_RANK },
        { id: 1001, rank: BUOY_RANK },
      ],
    );
  });

  it('hides a buoy that sits too close to a place label', () => {
    const stations: BuoyStation[] = [{ id: 'WYCM6', lon: 12, lat: 11 }];
    const { visible } = layoutBuoyVisibility(
      [{ id: 0, x: 10, y: 10, rank: 1 }],
      stations,
      project,
      800,
      400,
    );
    assert.equal(visible.has(0), true);
    assert.equal(visible.has(1000), false);
  });
});

describe('buoyMarkEngaged', () => {
  it('keeps the readout while hovered even if focus is gone', () => {
    assert.equal(
      buoyMarkEngaged({ matches: (sel) => sel === ':hover' }),
      true,
    );
  });

  it('keeps the readout while focused even if hover is gone', () => {
    assert.equal(
      buoyMarkEngaged({ matches: (sel) => sel === ':focus' }),
      true,
    );
  });

  it('restores depth only when neither hover nor focus', () => {
    assert.equal(buoyMarkEngaged({ matches: () => false }), false);
  });
});

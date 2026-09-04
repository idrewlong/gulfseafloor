import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fieldAt, forecastSpan, parseForecastJson, sampleField, type WeatherField } from './weatherField.ts';

const T = (s: string): number => Date.parse(s);

// 2x2 grid over a unit-ish box, two hourly steps.
const raw = {
  bbox: { west: -90, south: 29, east: -88, north: 30 },
  nx: 2,
  ny: 2,
  points: [
    { lon: -90, lat: 29 },
    { lon: -88, lat: 29 },
    { lon: -90, lat: 30 },
    { lon: -88, lat: 30 },
  ],
  steps: [
    {
      validTime: '2026-09-04T00:00:00Z',
      sky: [0, 100, 0, 100],
      pop: [0, 50, 0, 50],
      precip: [0, 1, 0, 1],
      windU: [1, 1, 1, 1],
      windV: [0, 0, 0, 0],
      tempC: [20, 20, 20, 20],
    },
    {
      validTime: '2026-09-04T01:00:00Z',
      sky: [100, 100, 100, 100],
      pop: [null, 50, 0, 50],
      precip: [0, 1, 0, 1],
      windU: [1, 1, 1, 1],
      windV: [0, 0, 0, 0],
      tempC: [22, 22, 22, 22],
    },
  ],
  periods: [],
};

describe('parseForecastJson', () => {
  it('reads the grid and its time axis', () => {
    const f = parseForecastJson(raw);
    assert.ok(f);
    assert.equal(f.nx, 2);
    assert.equal(f.ny, 2);
    assert.deepEqual(f.times, [T('2026-09-04T00:00:00Z'), T('2026-09-04T01:00:00Z')]);
    assert.deepEqual(f.bbox, { west: -90, south: 29, east: -88, north: 30 });
  });

  it('rejects a payload whose arrays do not match the grid', () => {
    assert.equal(parseForecastJson({ ...raw, nx: 3 }), null);
    assert.equal(parseForecastJson({ ...raw, steps: [] }), null);
    assert.equal(parseForecastJson(null), null);
  });
});

describe('forecastSpan', () => {
  it('is the first and last step', () => {
    const f = parseForecastJson(raw) as WeatherField;
    assert.deepEqual(forecastSpan(f), { t0: T('2026-09-04T00:00:00Z'), t1: T('2026-09-04T01:00:00Z') });
  });
});

describe('fieldAt', () => {
  const f = parseForecastJson(raw) as WeatherField;

  it('interpolates between steps', () => {
    const g = fieldAt(f, T('2026-09-04T00:30:00Z'));
    assert.equal(g.sky[0], 50);
    assert.equal(g.tempC[0], 21);
  });

  // A hole in either bracketing step is a hole in the blend. Filling it from
  // the neighbouring hour would invent a forecast.
  it('propagates null from either side', () => {
    const g = fieldAt(f, T('2026-09-04T00:30:00Z'));
    assert.equal(g.pop[0], null);
    assert.equal(g.pop[1], 50);
  });

  it('clamps outside the window instead of extrapolating', () => {
    assert.equal(fieldAt(f, T('2026-09-03T00:00:00Z')).sky[0], 0);
    assert.equal(fieldAt(f, T('2026-09-05T00:00:00Z')).sky[0], 100);
  });
});

describe('sampleField', () => {
  const f = parseForecastJson(raw) as WeatherField;
  const g = fieldAt(f, T('2026-09-04T00:00:00Z'));

  it('bilinearly samples inside the box', () => {
    assert.equal(sampleField(f, g.sky, -90, 29), 0);
    assert.equal(sampleField(f, g.sky, -88, 29), 100);
    assert.equal(sampleField(f, g.sky, -89, 29), 50);
  });

  it('clamps outside the box to its edge', () => {
    assert.equal(sampleField(f, g.sky, -99, 29), 0);
    assert.equal(sampleField(f, g.sky, -80, 29), 100);
  });

  // One missing corner must not silently drag a real value toward zero.
  it('returns null when any contributing corner is missing', () => {
    const holed = [null, 100, 0, 100] as (number | null)[];
    assert.equal(sampleField(f, holed, -89, 29.5), null);
    assert.equal(sampleField(f, holed, -88, 29.5), 100);
  });
});

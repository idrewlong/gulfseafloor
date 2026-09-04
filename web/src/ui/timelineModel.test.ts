import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  barGeometry,
  fraction,
  headLabel,
  layerStatus,
  sweepRateX,
  timelineRows,
  weatherExtent,
} from './timelineModel.ts';
import type { Coverage, Extent } from '../time/axis.ts';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-03T12:00:00Z');
const E: Extent = { t0: NOW - 4 * HOUR, t1: NOW + 4 * HOUR };

const radar: Coverage = { id: 'radar', label: 'Radar', kind: 'span', t0: NOW - 2 * HOUR, t1: NOW };
const buoys: Coverage = {
  id: 'buoys',
  label: 'Buoys',
  kind: 'instant',
  t0: NOW,
  t1: NOW,
  staleAfterMs: HOUR,
};

describe('fraction', () => {
  it('places a time along the track', () => {
    assert.equal(fraction(E, NOW), 0.5);
    assert.equal(fraction(E, E.t0), 0);
    assert.equal(fraction(E, E.t1), 1);
  });

  it('clamps outside the extent', () => {
    assert.equal(fraction(E, E.t0 - 99 * HOUR), 0);
    assert.equal(fraction(E, E.t1 + 99 * HOUR), 1);
  });

  it('collapses a zero-width extent instead of dividing by zero', () => {
    assert.equal(fraction({ t0: NOW, t1: NOW }, NOW), 0);
  });
});

describe('barGeometry', () => {
  it('spans a span layer across its own window', () => {
    assert.deepEqual(barGeometry(E, radar), { left: 0.25, width: 0.25 });
  });

  // An instant's bar is drawn over the window covers() actually accepts, so
  // the row and the drop-out rule cannot disagree on screen.
  it('draws an instant across its declared freshness', () => {
    assert.deepEqual(barGeometry(E, buoys), { left: 0.375, width: 0.25 });
  });

  it('gives an instant with no declared freshness no width', () => {
    const tick: Coverage = { id: 't', label: 'T', kind: 'instant', t0: NOW, t1: NOW };
    assert.deepEqual(barGeometry(E, tick), { left: 0.5, width: 0 });
  });
});

describe('sweepRateX', () => {
  it('sets a rate that walks the whole extent in the sweep time', () => {
    assert.equal(sweepRateX(E, 20_000), (8 * HOUR) / 20_000);
  });

  it('falls back to real time rather than dividing by zero', () => {
    assert.equal(sweepRateX(E, 0), 1);
  });
});

describe('headLabel', () => {
  it('names the day as well as the hour, because the axis crosses midnight', () => {
    assert.equal(headLabel(Date.parse('2026-09-03T18:30:00Z')), '03 Sep 18:30Z');
    assert.equal(headLabel(Date.parse('2026-09-04T00:00:00Z')), '04 Sep 00:00Z');
  });
});

describe('layerStatus', () => {
  it('reports a covered layer with nothing to explain', () => {
    assert.deepEqual(layerStatus(radar, NOW - HOUR), {
      id: 'radar',
      label: 'Radar',
      covered: true,
      note: '',
    });
  });

  it('names the boundary the head ran past', () => {
    assert.equal(layerStatus(radar, NOW + HOUR).covered, false);
    assert.equal(layerStatus(radar, NOW + HOUR).note, 'no data after 03 Sep 12:00Z');
  });

  it('names the boundary the head ran before', () => {
    assert.equal(layerStatus(radar, NOW - 3 * HOUR).note, 'no data before 03 Sep 10:00Z');
  });

  it('says an observation is an observation, not a forecast gap', () => {
    assert.equal(layerStatus(buoys, NOW + 2 * HOUR).note, 'observed 03 Sep 12:00Z · live only');
  });
});

describe('timelineRows', () => {
  const weather: Coverage = { ...radar, id: 'radar', track: 'weather' };
  const chart: Coverage = { id: 'currents', label: 'Currents', kind: 'span', t0: NOW, t1: NOW + HOUR };

  // The timeline is the weather timelapse control. Currents, buoys and
  // aircraft still follow the head — they are just not what the loop is of,
  // so they do not get a row.
  it('lists only weather layers', () => {
    assert.deepEqual(
      timelineRows([chart, weather]).map((c) => c.id),
      ['radar'],
    );
  });

  it('treats a layer with no track as chart furniture, not weather', () => {
    assert.deepEqual(timelineRows([chart]), []);
  });
});

describe('weatherExtent', () => {
  const rad: Coverage = { id: 'radar', label: 'Radar', kind: 'span', track: 'weather', t0: NOW - 2 * HOUR, t1: NOW };
  const fcst: Coverage = { id: 'forecast', label: 'Forecast', kind: 'span', track: 'weather', t0: NOW, t1: NOW + 24 * HOUR };
  const currents: Coverage = { id: 'currents', label: 'Currents', kind: 'span', t0: NOW - 9 * HOUR, t1: NOW + 99 * HOUR };

  // The bar loops over weather. If a chart layer could stretch the track,
  // a sweep would spend most of its run outside the radar it is meant to be
  // animating.
  it('spans the weather layers only', () => {
    assert.deepEqual(weatherExtent([currents, rad, fcst]), { t0: NOW - 2 * HOUR, t1: NOW + 24 * HOUR });
  });

  it('is null when no weather layer has loaded', () => {
    assert.equal(weatherExtent([currents]), null);
  });
});

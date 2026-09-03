import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampToFootprint,
  coverDistance,
  maxPolarForCoverage,
  viewFootprint,
  type Extent,
} from './cameraFrame.ts';

/** 400 m square centred on the origin of the local metric plane. */
const SQUARE: Extent = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

describe('coverDistance', () => {
  it('fills a square viewport with a square chart', () => {
    const d = coverDistance({
      extent: SQUARE,
      fovDeg: 90,
      viewportWidth: 1000,
      viewportHeight: 1000,
    });
    assert.ok(Math.abs(d - 200) < 1e-6, `expected 200, got ${d}`);
  });

  it('covers a wide chart by its height, leaving room to pan east-west', () => {
    const wide: Extent = { minX: -1000, minY: -200, maxX: 1000, maxY: 200 };
    const d = coverDistance({
      extent: wide,
      fovDeg: 90,
      viewportWidth: 1000,
      viewportHeight: 1000,
    });
    // Height is the tighter axis: 400 m across 1000 px, so 400 m of ground fills
    // the frame height and the chart still runs off both sides.
    assert.ok(Math.abs(d - 200) < 1e-6, `expected 200, got ${d}`);
    const fp = viewFootprint({ distance: d, fovDeg: 90, aspect: 1, polar: 0, azimuth: 0 });
    assert.ok(fp.maxY - fp.minY <= 400 + 1e-6, 'view must not overshoot the chart height');
    assert.ok(fp.maxX - fp.minX < 2000, 'chart still extends past the view east-west');
  });

  it('covers a tall chart by its width instead', () => {
    const tall: Extent = { minX: -200, minY: -1000, maxX: 200, maxY: 1000 };
    const d = coverDistance({
      extent: tall,
      fovDeg: 90,
      viewportWidth: 1000,
      viewportHeight: 1000,
    });
    assert.ok(Math.abs(d - 200) < 1e-6, `expected 200, got ${d}`);
  });

  it('never leaves a gap: the view is covered on both axes at the cover distance', () => {
    const chart: Extent = { minX: -5000, minY: -3000, maxX: 5000, maxY: 3000 };
    const d = coverDistance({
      extent: chart,
      fovDeg: 48,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    const fp = viewFootprint({ distance: d, fovDeg: 48, aspect: 1440 / 900, polar: 0, azimuth: 0 });
    assert.ok(fp.maxX - fp.minX <= 10000 + 1e-6, 'view wider than the chart');
    assert.ok(fp.maxY - fp.minY <= 6000 + 1e-6, 'view taller than the chart');
  });
});

describe('maxPolarForCoverage', () => {
  const CEILING = 0.14 * Math.PI;
  const CHART: Extent = { minX: -5000, minY: -3000, maxX: 5000, maxY: 3000 };
  const LENS = { fovDeg: 48, aspect: 1440 / 900, extent: CHART, ceiling: CEILING };

  it('allows no tilt when the view already spans the chart edge to edge', () => {
    const d = coverDistance({
      extent: CHART,
      fovDeg: 48,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    assert.ok(maxPolarForCoverage({ ...LENS, distance: d }) < 0.01);
  });

  it('allows the full ceiling once zoomed in with room to spare', () => {
    assert.equal(maxPolarForCoverage({ ...LENS, distance: 3000 }), CEILING);
  });

  it('gives back a partial tilt whose view still fits inside the chart', () => {
    const polar = maxPolarForCoverage({ ...LENS, distance: 6000 });
    assert.ok(polar > 0 && polar < CEILING, `expected a partial tilt, got ${polar}`);
    const fp = viewFootprint({ distance: 6000, fovDeg: 48, aspect: 1440 / 900, polar, azimuth: 0 });
    assert.ok(fp.maxY - fp.minY <= 6000 + 1, 'tilted view spills past the chart');
    assert.ok(fp.maxX - fp.minX <= 10000 + 1, 'tilted view spills past the chart');
  });

  it('opens the tilt ceiling monotonically as you zoom in', () => {
    const far = maxPolarForCoverage({ ...LENS, distance: 6600 });
    const mid = maxPolarForCoverage({ ...LENS, distance: 6300 });
    const near = maxPolarForCoverage({ ...LENS, distance: 6000 });
    assert.ok(far < mid && mid < near, `expected ${far} < ${mid} < ${near}`);
  });
});

describe('viewFootprint', () => {
  it('is symmetric about the target when looking straight down', () => {
    const fp = viewFootprint({
      distance: 1000,
      fovDeg: 90,
      aspect: 2,
      polar: 0,
      azimuth: 0,
    });
    assert.ok(Math.abs(fp.maxY - 1000) < 1e-6, `expected 1000, got ${fp.maxY}`);
    assert.ok(Math.abs(fp.minY + 1000) < 1e-6, `expected -1000, got ${fp.minY}`);
    assert.ok(Math.abs(fp.maxX - 2000) < 1e-6, `expected 2000, got ${fp.maxX}`);
    assert.ok(Math.abs(fp.minX + 2000) < 1e-6, `expected -2000, got ${fp.minX}`);
  });

  it('reaches further ahead than behind once tilted', () => {
    const fp = viewFootprint({
      distance: 1000,
      fovDeg: 48,
      aspect: 1.6,
      polar: 0.14 * Math.PI,
      azimuth: 0,
    });
    assert.ok(fp.maxY > Math.abs(fp.minY), `ahead ${fp.maxY} should exceed behind ${-fp.minY}`);
  });

  it('swaps the long axis when the camera looks east instead of north', () => {
    const opts = { distance: 1000, fovDeg: 48, aspect: 1.6, polar: 0.14 * Math.PI };
    const north = viewFootprint({ ...opts, azimuth: 0 });
    const east = viewFootprint({ ...opts, azimuth: Math.PI / 2 });
    assert.ok(Math.abs(east.maxX - north.maxY) < 1e-6, `${east.maxX} vs ${north.maxY}`);
    assert.ok(Math.abs(east.maxY - north.maxX) < 1e-6, `${east.maxY} vs ${north.maxX}`);
  });
});

describe('clampToFootprint', () => {
  const CHART: Extent = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const SMALL_VIEW = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

  it('leaves a target alone when the whole view is already on the chart', () => {
    const out = clampToFootprint({ x: 100, y: -50 }, CHART, SMALL_VIEW);
    assert.deepEqual(out, { x: 100, y: -50 });
  });

  it('stops the pan when the view edge reaches the chart edge', () => {
    const out = clampToFootprint({ x: 5000, y: -5000 }, CHART, SMALL_VIEW);
    assert.deepEqual(out, { x: 800, y: -800 });
  });

  it('keeps the far edge on the chart when the view is tilted forward', () => {
    const tilted = { minX: -200, minY: -100, maxX: 200, maxY: 600 };
    const out = clampToFootprint({ x: 0, y: 5000 }, CHART, tilted);
    assert.equal(out.y, 400);
    assert.ok(out.y + tilted.maxY <= CHART.maxY, 'far edge walked off the chart');
  });

  it('centres the axis when the view is wider than the chart', () => {
    const huge = { minX: -3000, minY: -200, maxX: 3000, maxY: 200 };
    const out = clampToFootprint({ x: 5000, y: 0 }, CHART, huge);
    assert.equal(out.x, 0);
  });
});

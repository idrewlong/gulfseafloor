import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blendAt, parseRadarJson, radarSpan, type RadarSet } from './radarFrames.ts';

const T = (s: string): number => Date.parse(s);

const raw = {
  bbox: { West: -91.36, South: 28.5, East: -86.69, North: 30.78 },
  width: 1024,
  height: 499,
  frames: [
    { validTime: '2026-09-04T04:00:00Z', file: '20260904T040000Z.png' },
    { validTime: '2026-09-04T04:05:00Z', file: '20260904T040500Z.png' },
    { validTime: '2026-09-04T04:10:00Z', file: '20260904T041000Z.png' },
  ],
};

describe('parseRadarJson', () => {
  it('reads the loop into ascending millisecond times', () => {
    const set = parseRadarJson(raw);
    assert.ok(set);
    assert.deepEqual(set.times, [T('2026-09-04T04:00:00Z'), T('2026-09-04T04:05:00Z'), T('2026-09-04T04:10:00Z')]);
    assert.equal(set.files[2], '20260904T041000Z.png');
    assert.deepEqual(set.bbox, { west: -91.36, south: 28.5, east: -86.69, north: 30.78 });
  });

  it('sorts frames it was handed out of order', () => {
    const set = parseRadarJson({ ...raw, frames: [raw.frames[2], raw.frames[0], raw.frames[1]] });
    assert.ok(set);
    assert.deepEqual(set.times, [T('2026-09-04T04:00:00Z'), T('2026-09-04T04:05:00Z'), T('2026-09-04T04:10:00Z')]);
  });

  it('drops frames with an unparseable time rather than placing them at zero', () => {
    const set = parseRadarJson({ ...raw, frames: [...raw.frames, { validTime: 'soon', file: 'x.png' }] });
    assert.ok(set);
    assert.equal(set.times.length, 3);
  });

  it('rejects a payload with no usable frame', () => {
    assert.equal(parseRadarJson({ ...raw, frames: [] }), null);
    assert.equal(parseRadarJson(null), null);
    assert.equal(parseRadarJson({ frames: [{ validTime: 'x', file: 'y' }] }), null);
  });
});

describe('radarSpan', () => {
  it('is the first and last frame time', () => {
    const set = parseRadarJson(raw) as RadarSet;
    assert.deepEqual(radarSpan(set, 0), { t0: T('2026-09-04T04:00:00Z'), t1: T('2026-09-04T04:10:00Z') });
  });

  // A scan speaks until the next one lands. Without this the newest frame is
  // already expired the instant it arrives, and the layer is struck through
  // permanently while the chart is live.
  it('carries the newest scan forward by its validity', () => {
    const set = parseRadarJson(raw) as RadarSet;
    assert.deepEqual(radarSpan(set, 10 * 60_000), {
      t0: T('2026-09-04T04:00:00Z'),
      t1: T('2026-09-04T04:20:00Z'),
    });
  });
});

describe('blendAt', () => {
  const set = parseRadarJson(raw) as RadarSet;

  it('crossfades between the bracketing frames', () => {
    const b = blendAt(set, T('2026-09-04T04:02:30Z'));
    assert.deepEqual([b.i0, b.i1], [0, 1]);
    assert.equal(b.mix, 0.5);
  });

  it('sits exactly on a frame with no blend', () => {
    const b = blendAt(set, T('2026-09-04T04:05:00Z'));
    assert.deepEqual([b.i0, b.i1], [1, 1]);
    assert.equal(b.mix, 0);
  });

  // Radar is an observation. Well past the newest scan there is nothing to
  // show, and holding the last frame would paint an old echo under a later
  // time.
  it('reports being outside the loop rather than clamping', () => {
    assert.equal(blendAt(set, T('2026-09-04T05:00:00Z')).inside, false);
    assert.equal(blendAt(set, T('2026-09-04T03:00:00Z')).inside, false);
    assert.equal(blendAt(set, T('2026-09-04T04:02:30Z')).inside, true);
  });

  it('holds the newest scan through its validity, without blending past it', () => {
    const grace = 10 * 60_000;
    const b = blendAt(set, T('2026-09-04T04:15:00Z'), grace);
    assert.equal(b.inside, true);
    assert.deepEqual([b.i0, b.i1], [2, 2]);
    assert.equal(b.mix, 0, 'nothing to blend toward past the last frame');
    assert.equal(blendAt(set, T('2026-09-04T04:21:00Z'), grace).inside, false);
  });

  // Grace is forward-only: it says a scan is still current, not that one
  // existed before the radar started reporting.
  it('does not extend backwards before the first scan', () => {
    assert.equal(blendAt(set, T('2026-09-04T03:55:00Z'), 10 * 60_000).inside, false);
  });
});

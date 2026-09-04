/**
 * The radar loop as the chart sees it: a list of instants and the file that
 * renders each one.
 *
 * Pure — no DOM, no three.js, no clock — so the frame arithmetic can be
 * checked without a GPU, the same split currentsTime.ts uses.
 */
import type { BBox } from '../geo.ts';

export type RadarSet = {
  bbox: BBox;
  width: number;
  height: number;
  /** Ascending; parallel to `files`. */
  times: number[];
  files: string[];
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Reads the server's radar manifest.
 *
 * Frames are sorted rather than trusted in order, and a frame whose time
 * will not parse is dropped: `Date.parse` returns NaN, and a NaN sorted into
 * the axis would put a real radar image at an unreal instant.
 */
export function parseRadarJson(raw: unknown): RadarSet | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const doc = raw as { bbox?: unknown; width?: unknown; height?: unknown; frames?: unknown };
  if (!Array.isArray(doc.frames)) {
    return null;
  }
  const box = doc.bbox as Record<string, unknown> | undefined;
  if (box == null) {
    return null;
  }
  // Go marshals the bbox with capitalised keys; accept either spelling
  // rather than depending on which side renames its field first.
  const pick = (a: string, b: string): number | null => num(box[a]) ?? num(box[b]);
  const west = pick('west', 'West');
  const south = pick('south', 'South');
  const east = pick('east', 'East');
  const north = pick('north', 'North');
  if (west == null || south == null || east == null || north == null) {
    return null;
  }

  const rows: { t: number; file: string }[] = [];
  for (const f of doc.frames) {
    if (f == null || typeof f !== 'object') {
      continue;
    }
    const row = f as { validTime?: unknown; file?: unknown };
    if (typeof row.validTime !== 'string' || typeof row.file !== 'string' || row.file === '') {
      continue;
    }
    const t = Date.parse(row.validTime);
    if (!Number.isFinite(t)) {
      continue;
    }
    rows.push({ t, file: row.file });
  }
  if (rows.length === 0) {
    return null;
  }
  rows.sort((a, b) => a.t - b.t);

  return {
    bbox: { west, south, east, north },
    width: num(doc.width) ?? 0,
    height: num(doc.height) ?? 0,
    times: rows.map((r) => r.t),
    files: rows.map((r) => r.file),
  };
}

/**
 * The window this layer can speak for.
 *
 * `graceMs` carries the newest scan forward: a scan is the current picture
 * until the next one lands. Without it the newest frame expires the instant
 * it arrives and the layer sits struck through whenever the chart is live,
 * which is the one state it should most obviously be drawing in.
 */
export function radarSpan(set: RadarSet, graceMs: number): { t0: number; t1: number } {
  return {
    t0: set.times[0]!,
    t1: set.times[set.times.length - 1]! + Math.max(graceMs, 0),
  };
}

export type RadarBlend = {
  i0: number;
  i1: number;
  /** 0 shows i0, 1 shows i1. */
  mix: number;
  /** False when tMs is outside the loop; the layer should not draw. */
  inside: boolean;
};

/**
 * The two frames bracketing `tMs` and how far between them it sits.
 *
 * Outside the loop this reports `inside: false` instead of clamping. Radar
 * is an observation: past the newest scan there is nothing to show, and
 * holding the last frame would paint a stale echo under a later timestamp.
 */
export function blendAt(set: RadarSet, tMs: number, graceMs = 0): RadarBlend {
  const last = set.times.length - 1;
  // Grace is forward-only: it says the newest scan is still current, never
  // that one existed before the radar began reporting.
  if (tMs < set.times[0]! || tMs > set.times[last]! + Math.max(graceMs, 0)) {
    return { i0: 0, i1: 0, mix: 0, inside: false };
  }
  if (tMs >= set.times[last]!) {
    return { i0: last, i1: last, mix: 0, inside: true };
  }
  let i1 = 1;
  while (i1 < last && set.times[i1]! < tMs) {
    i1++;
  }
  // An exact hit on either bracket needs no crossfade: show that frame.
  if (set.times[i1] === tMs) {
    return { i0: i1, i1, mix: 0, inside: true };
  }
  const i0 = Math.max(i1 - 1, 0);
  if (set.times[i0] === tMs || i0 === i1) {
    return { i0, i1: i0, mix: 0, inside: true };
  }
  const span = set.times[i1]! - set.times[i0]!;
  if (span <= 0) {
    return { i0, i1: i0, mix: 0, inside: true };
  }
  const mix = (tMs - set.times[i0]!) / span;
  return { i0, i1, mix, inside: true };
}

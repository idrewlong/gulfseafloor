/**
 * The NWS gridded forecast as the chart sees it: a coarse lattice of cloud
 * cover, precipitation probability and wind over the AOI, hourly for a week.
 *
 * It is a forecast, not an observation, and it is deliberately coarse — a
 * handful of NWS gridpoints, not a rendered field. Cloud shading and rain
 * density are driven from it; nothing here is presented as measured weather.
 *
 * Pure: no DOM, no three.js, no clock.
 */
import type { BBox } from '../geo.ts';

export type Cell = (number | null)[];

export type FieldStep = {
  sky: Cell;
  pop: Cell;
  precip: Cell;
  windU: Cell;
  windV: Cell;
  tempC: Cell;
};

export type WeatherField = {
  bbox: BBox;
  nx: number;
  ny: number;
  /** Ascending; parallel to `steps`. */
  times: number[];
  steps: FieldStep[];
};

const KEYS = ['sky', 'pop', 'precip', 'windU', 'windV', 'tempC'] as const;

function cell(v: unknown, n: number): Cell | null {
  if (!Array.isArray(v) || v.length !== n) {
    return null;
  }
  return v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseForecastJson(raw: unknown): WeatherField | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const doc = raw as Record<string, unknown>;
  const nx = num(doc.nx);
  const ny = num(doc.ny);
  const box = doc.bbox as Record<string, unknown> | undefined;
  if (nx == null || ny == null || nx < 2 || ny < 2 || box == null || !Array.isArray(doc.steps)) {
    return null;
  }
  const pick = (a: string, b: string): number | null => num(box[a]) ?? num(box[b]);
  const west = pick('west', 'West');
  const south = pick('south', 'South');
  const east = pick('east', 'East');
  const north = pick('north', 'North');
  if (west == null || south == null || east == null || north == null) {
    return null;
  }

  const n = nx * ny;
  const times: number[] = [];
  const steps: FieldStep[] = [];
  for (const s of doc.steps) {
    if (s == null || typeof s !== 'object') {
      continue;
    }
    const row = s as Record<string, unknown>;
    if (typeof row.validTime !== 'string') {
      continue;
    }
    const t = Date.parse(row.validTime);
    if (!Number.isFinite(t)) {
      continue;
    }
    const built: Partial<FieldStep> = {};
    let ok = true;
    for (const k of KEYS) {
      const c = cell(row[k], n);
      if (c == null) {
        ok = false;
        break;
      }
      built[k] = c;
    }
    if (!ok) {
      continue;
    }
    times.push(t);
    steps.push(built as FieldStep);
  }
  if (steps.length === 0) {
    return null;
  }
  return { bbox: { west, south, east, north }, nx, ny, times, steps };
}

/** The window this layer can speak for. */
export function forecastSpan(f: WeatherField): { t0: number; t1: number } {
  return { t0: f.times[0]!, t1: f.times[f.times.length - 1]! };
}

function blendCell(a: Cell, b: Cell, t: number): Cell {
  return a.map((v, i) => {
    const w = b[i];
    // A hole in either bracketing hour is a hole in the blend. Filling it
    // from the neighbour would invent a forecast where NWS published none.
    if (v == null || w == null) {
      return null;
    }
    return v * (1 - t) + w * t;
  });
}

/**
 * The field at `tMs`, linearly interpolated between hours and clamped at
 * either end rather than extrapolated.
 */
export function fieldAt(f: WeatherField, tMs: number): FieldStep {
  const last = f.times.length - 1;
  let i1 = 1;
  if (tMs <= f.times[0]!) {
    return f.steps[0]!;
  }
  if (tMs >= f.times[last]!) {
    return f.steps[last]!;
  }
  while (i1 < last && f.times[i1]! < tMs) {
    i1++;
  }
  const i0 = i1 - 1;
  const span = f.times[i1]! - f.times[i0]!;
  const t = span <= 0 ? 0 : (tMs - f.times[i0]!) / span;
  const a = f.steps[i0]!;
  const b = f.steps[i1]!;
  const out: Partial<FieldStep> = {};
  for (const k of KEYS) {
    out[k] = blendCell(a[k], b[k], t);
  }
  return out as FieldStep;
}

/**
 * Bilinear sample of one channel at a position, clamped to the box edges.
 *
 * Any missing corner makes the sample null rather than dragging a real value
 * toward zero: the lattice is coarse enough that one absent gridpoint covers
 * a lot of water, and a quietly halved cloud fraction there would be a
 * fabricated forecast.
 */
export function sampleField(f: WeatherField, c: Cell, lon: number, lat: number): number | null {
  const { west, south, east, north } = f.bbox;
  const fx = east === west ? 0 : (lon - west) / (east - west);
  const fy = north === south ? 0 : (lat - south) / (north - south);
  const gx = Math.min(Math.max(fx, 0), 1) * (f.nx - 1);
  const gy = Math.min(Math.max(fy, 0), 1) * (f.ny - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, f.nx - 1);
  const y1 = Math.min(y0 + 1, f.ny - 1);
  const tx = gx - x0;
  const ty = gy - y0;

  const at = (x: number, y: number): number | null => c[y * f.nx + x] ?? null;
  const c00 = at(x0, y0);
  const c10 = at(x1, y0);
  const c01 = at(x0, y1);
  const c11 = at(x1, y1);

  // Only corners that actually contribute may veto the sample: sitting
  // exactly on an edge must not be poisoned by the cell beyond it.
  const wx0 = 1 - tx;
  const wx1 = tx;
  const wy0 = 1 - ty;
  const wy1 = ty;
  const parts: [number | null, number][] = [
    [c00, wx0 * wy0],
    [c10, wx1 * wy0],
    [c01, wx0 * wy1],
    [c11, wx1 * wy1],
  ];
  let sum = 0;
  for (const [v, w] of parts) {
    if (w === 0) {
      continue;
    }
    if (v == null) {
      return null;
    }
    sum += v * w;
  }
  return sum;
}

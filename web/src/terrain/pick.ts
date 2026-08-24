/** Ray / displaced-heightfield picking. Mesh raycasts cannot be used: terrain is
 *  GPU-displaced, and every tile's CPU geometry sits on the same z=0 plane. */

export type Vec3 = { x: number; y: number; z: number };

export type HeightQuery = (
  x: number,
  y: number,
) => { lon: number; lat: number; elevation: number | null } | null;

export type HeightHit = {
  lon: number;
  lat: number;
  elevation: number | null;
};

export function rayAabbT(
  origin: Vec3,
  dir: Vec3,
  min: Vec3,
  max: Vec3,
): { t0: number; t1: number } | null {
  let t0 = 0;
  let t1 = Number.POSITIVE_INFINITY;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    const o = origin[axis];
    const lo = min[axis];
    const hi = max[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) {
        return null;
      }
      continue;
    }
    let near = (lo - o) / d;
    let far = (hi - o) / d;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) {
      return null;
    }
  }
  if (t1 < 0) {
    return null;
  }
  return { t0, t1 };
}

export function marchHeightfield(
  origin: Vec3,
  dir: Vec3,
  bounds: { min: Vec3; max: Vec3 },
  exaggeration: number,
  sampleXY: HeightQuery,
  options?: { stepMeters?: number; maxSteps?: number },
): HeightHit | null {
  const spanHit = rayAabbT(origin, dir, bounds.min, bounds.max);
  if (!spanHit) {
    return null;
  }

  const stepMeters = options?.stepMeters ?? 32;
  const maxSteps = options?.maxSteps ?? 512;
  const span = spanHit.t1 - spanHit.t0;
  if (span <= 0) {
    return sampleAt(origin, dir, spanHit.t0, exaggeration, sampleXY);
  }
  const steps = Math.min(maxSteps, Math.max(24, Math.ceil(span / stepMeters)));

  let prevT = spanHit.t0;
  let prevAbove: boolean | null = null;

  for (let i = 0; i <= steps; i++) {
    const t = spanHit.t0 + (span * i) / steps;
    const sample = query(origin, dir, t, sampleXY);
    if (!sample || sample.elevation === null) {
      prevT = t;
      continue;
    }
    const z = origin.z + dir.z * t;
    const above = z >= sample.elevation * exaggeration;
    if (prevAbove === true && !above) {
      return refine(origin, dir, prevT, t, exaggeration, sampleXY) ?? {
        lon: sample.lon,
        lat: sample.lat,
        elevation: sample.elevation,
      };
    }
    prevAbove = above;
    prevT = t;
  }

  return null;
}

function query(origin: Vec3, dir: Vec3, t: number, sampleXY: HeightQuery) {
  return sampleXY(origin.x + dir.x * t, origin.y + dir.y * t);
}

function sampleAt(
  origin: Vec3,
  dir: Vec3,
  t: number,
  exaggeration: number,
  sampleXY: HeightQuery,
): HeightHit | null {
  const sample = query(origin, dir, t, sampleXY);
  if (!sample || sample.elevation === null) {
    return null;
  }
  const z = origin.z + dir.z * t;
  if (Math.abs(z - sample.elevation * exaggeration) > 8) {
    return null;
  }
  return { lon: sample.lon, lat: sample.lat, elevation: sample.elevation };
}

function refine(
  origin: Vec3,
  dir: Vec3,
  tLo: number,
  tHi: number,
  exaggeration: number,
  sampleXY: HeightQuery,
): HeightHit | null {
  let lo = tLo;
  let hi = tHi;
  let best: HeightHit | null = null;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const sample = query(origin, dir, mid, sampleXY);
    if (!sample || sample.elevation === null) {
      hi = mid;
      continue;
    }
    best = { lon: sample.lon, lat: sample.lat, elevation: sample.elevation };
    const z = origin.z + dir.z * mid;
    if (z >= sample.elevation * exaggeration) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

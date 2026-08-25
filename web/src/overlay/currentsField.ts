import { bboxContains, type BBox } from '../geo.ts';

/** Matches `METRES_PER_DEG_LAT` in `geo.ts`. */
const METRES_PER_DEG_LAT = 111_320;

export const PARTICLE_COUNT = 8192;
export const FLOW_SCALE = 2500;
export const PARTICLE_MAX_AGE = 8;

export type VelocityGrid = {
  nx: number;
  ny: number;
  bbox: BBox;
  u: (number | null)[];
  v: (number | null)[];
};

function finiteOrNull(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Map `/api/ocean/currents` JSON onto the client grid. Null cells stay null. */
export function velocityGridFromJson(raw: unknown): VelocityGrid | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as {
    bbox?: { west?: unknown; south?: unknown; east?: unknown; north?: unknown };
    nx?: unknown;
    ny?: unknown;
    grid?: unknown;
    u?: unknown;
    v?: unknown;
  };
  if (o.grid !== 'centers') {
    return null;
  }
  const nx = o.nx;
  const ny = o.ny;
  if (typeof nx !== 'number' || typeof ny !== 'number' || !Number.isInteger(nx) || !Number.isInteger(ny) || nx <= 0 || ny <= 0) {
    return null;
  }
  const b = o.bbox;
  if (
    !b ||
    typeof b.west !== 'number' ||
    typeof b.south !== 'number' ||
    typeof b.east !== 'number' ||
    typeof b.north !== 'number' ||
    b.west >= b.east ||
    b.south >= b.north
  ) {
    return null;
  }
  if (!Array.isArray(o.u) || !Array.isArray(o.v) || o.u.length !== nx * ny || o.v.length !== nx * ny) {
    return null;
  }
  return {
    nx,
    ny,
    bbox: { west: b.west, south: b.south, east: b.east, north: b.north },
    u: o.u.map(finiteOrNull),
    v: o.v.map(finiteOrNull),
  };
}

function cellCentre(grid: VelocityGrid, ix: number, iy: number): { lon: number; lat: number } {
  const { nx, ny, bbox } = grid;
  const lon = nx <= 1 ? bbox.west : bbox.west + (ix / (nx - 1)) * (bbox.east - bbox.west);
  const lat = ny <= 1 ? bbox.south : bbox.south + (iy / (ny - 1)) * (bbox.north - bbox.south);
  return { lon, lat };
}

function sampleAt(grid: VelocityGrid, i: number): { u: number; v: number } | null {
  const u = grid.u[i];
  const v = grid.v[i];
  if (u == null || v == null) {
    return null;
  }
  return { u, v };
}

/** Bilinear sample. `bbox` is the first/last cell centres. Any null corner → null. */
export function sampleUV(grid: VelocityGrid, lon: number, lat: number): { u: number; v: number } | null {
  if (!bboxContains(grid.bbox, lon, lat)) {
    return null;
  }
  const { nx, ny, bbox } = grid;
  if (nx <= 0 || ny <= 0) {
    return null;
  }
  const fx = nx === 1 ? 0 : ((lon - bbox.west) / (bbox.east - bbox.west)) * (nx - 1);
  const fy = ny === 1 ? 0 : ((lat - bbox.south) / (bbox.north - bbox.south)) * (ny - 1);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx > nx - 1 || fy > ny - 1) {
    return null;
  }

  const x0 = Math.min(Math.floor(fx), nx - 1);
  const y0 = Math.min(Math.floor(fy), ny - 1);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const sw = sampleAt(grid, y0 * nx + x0);
  const se = sampleAt(grid, y0 * nx + x1);
  const nw = sampleAt(grid, y1 * nx + x0);
  const ne = sampleAt(grid, y1 * nx + x1);
  if (sw == null || se == null || nw == null || ne == null) {
    return null;
  }

  const u0 = sw.u * (1 - tx) + se.u * tx;
  const u1 = nw.u * (1 - tx) + ne.u * tx;
  const v0 = sw.v * (1 - tx) + se.v * tx;
  const v1 = nw.v * (1 - tx) + ne.v * tx;
  return {
    u: u0 * (1 - ty) + u1 * ty,
    v: v0 * (1 - ty) + v1 * ty,
  };
}

/** `u` east m/s, `v` north m/s. `flowScale` is visual exaggeration, not a physical dt. */
export function advect(
  lon: number,
  lat: number,
  u: number,
  v: number,
  dtSec: number,
  flowScale: number,
): { lon: number; lat: number } {
  const metresEast = u * dtSec * flowScale;
  const metresNorth = v * dtSec * flowScale;
  const mPerDegLon = METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return {
    lon: lon + metresEast / mPerDegLon,
    lat: lat + metresNorth / METRES_PER_DEG_LAT,
  };
}

export function shouldRespawn(lon: number, lat: number, age: number, bbox: BBox, maxAge: number): boolean {
  return age >= maxAge || !bboxContains(bbox, lon, lat);
}

export function staticArrows(
  grid: VelocityGrid,
): Array<{ lon: number; lat: number; u: number; v: number }> {
  const out: Array<{ lon: number; lat: number; u: number; v: number }> = [];
  for (let iy = 0; iy < grid.ny; iy++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const sample = sampleAt(grid, iy * grid.nx + ix);
      if (sample == null) {
        continue;
      }
      const { lon, lat } = cellCentre(grid, ix, iy);
      out.push({ lon, lat, u: sample.u, v: sample.v });
    }
  }
  return out;
}

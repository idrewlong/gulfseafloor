/**
 * Mapzen Terrarium terrain-RGB — must match Go `internal/terrain`.
 *
 *   elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
 *
 * 0.1 m resolution from −10 000 m to +6 777.215 m.
 */

export const TERRARIUM_OFFSET_M = 10000;
export const TERRARIUM_INTERVAL_M = 0.1;
export const TERRARIUM_MIN_M = -TERRARIUM_OFFSET_M;
export const TERRARIUM_MAX_M =
  -TERRARIUM_OFFSET_M + 16_777_215 * TERRARIUM_INTERVAL_M;

/** Elevations at or below this are treated as nodata (GDAL −9999 / packed floor). */
export const NODATA_ELEVATION_M = -9999;

export function decodeTerrarium(r: number, g: number, b: number): number {
  return -TERRARIUM_OFFSET_M + (r * 256 * 256 + g * 256 + b) * TERRARIUM_INTERVAL_M;
}

export function encodeTerrarium(elev: number): [number, number, number] {
  const clamped = Math.min(TERRARIUM_MAX_M, Math.max(TERRARIUM_MIN_M, elev));
  let scaled = Math.round((clamped + TERRARIUM_OFFSET_M) / TERRARIUM_INTERVAL_M);
  if (scaled < 0) {
    scaled = 0;
  }
  if (scaled > 16_777_215) {
    scaled = 16_777_215;
  }
  const r = (scaled >> 16) & 0xff;
  const g = (scaled >> 8) & 0xff;
  const b = scaled & 0xff;
  return [r, g, b];
}

export function isNodata(elevation: number): boolean {
  return elevation <= NODATA_ELEVATION_M;
}

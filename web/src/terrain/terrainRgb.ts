/**
 * Mapbox terrain-RGB — must match Go `internal/terrain`.
 *
 *   elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
 *
 * 0.1 m resolution from −10 000 m to +6 777.215 m.
 *
 * NOT Mapzen Terrarium, which packs (R*256 + G + B/256) - 32768. Decoding a
 * real Terrarium tile with this function returns roughly 828 000 m.
 */

export const TERRAIN_RGB_OFFSET_M = 10000;
export const TERRAIN_RGB_INTERVAL_M = 0.1;
export const TERRAIN_RGB_MIN_M = -TERRAIN_RGB_OFFSET_M;
export const TERRAIN_RGB_MAX_M =
  -TERRAIN_RGB_OFFSET_M + 16_777_215 * TERRAIN_RGB_INTERVAL_M;

/** Elevations at or below this are treated as nodata (GDAL −9999 / packed floor). */
export const NODATA_ELEVATION_M = -9999;

export function decodeTerrainRGB(r: number, g: number, b: number): number {
  return -TERRAIN_RGB_OFFSET_M + (r * 256 * 256 + g * 256 + b) * TERRAIN_RGB_INTERVAL_M;
}

export function encodeTerrainRGB(elev: number): [number, number, number] {
  const clamped = Math.min(TERRAIN_RGB_MAX_M, Math.max(TERRAIN_RGB_MIN_M, elev));
  let scaled = Math.round((clamped + TERRAIN_RGB_OFFSET_M) / TERRAIN_RGB_INTERVAL_M);
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

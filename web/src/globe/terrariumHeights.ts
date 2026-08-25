import { decodeTerrarium, isNodata } from '../terrain/terrarium.ts';

/**
 * Cesium HeightmapTerrainData is row-major, north to south, west to east —
 * the same layout as a slippy-map PNG.
 */
export function heightsFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    const elev = decodeTerrarium(r, g, b);
    out[i] = isNodata(elev) ? 0 : elev;
  }
  return out;
}

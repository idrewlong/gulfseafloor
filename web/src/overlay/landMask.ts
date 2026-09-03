import type { LonLat } from '../geo/orient.ts';
import type { BBox } from '../geo.ts';

/**
 * HYCOM GLBy0.08 cells run 4-7 km across this AOI, so the model does not
 * resolve the barrier islands — Horn Island is about 1 km wide. Left alone,
 * the overlay faithfully draws current straight over Ship, Horn, and Cat.
 * This mask is what keeps the drawing honest where the model is coarse.
 *
 * Only the barrier islands are masked. The mainland spans many HYCOM cells, so
 * the model already marks it no-data and particles die there on their own;
 * inventing a mainland ring from the client's open shoreline polyline would
 * risk masking real water in Lake Borgne and Breton Sound.
 *
 * 2048x1024 over the AOI is ~145 m per texel, so West Ship Island — the
 * smallest, about 1.2 km across — still spans several rows.
 */
export const LAND_MASK_W = 2048;
export const LAND_MASK_H = 1024;

type Edge = { x0: number; y0: number; x1: number; y1: number };

/** Row index of a latitude, in mask space (row 0 = bbox.south). */
function rowOf(lat: number, bbox: BBox, h: number): number {
  return ((lat - bbox.south) / (bbox.north - bbox.south)) * h;
}

/** Column index of a longitude, in mask space (col 0 = bbox.west). */
function colOf(lon: number, bbox: BBox, w: number): number {
  return ((lon - bbox.west) / (bbox.east - bbox.west)) * w;
}

function edgesOf(rings: readonly (readonly LonLat[])[], bbox: BBox, w: number, h: number): Edge[] {
  const out: Edge[] = [];
  for (const ring of rings) {
    if (ring.length < 3) {
      continue;
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const y0 = rowOf(a[1], bbox, h);
      const y1 = rowOf(b[1], bbox, h);
      // A horizontal edge contributes no crossing and would divide by zero.
      if (y0 === y1) {
        continue;
      }
      out.push({ x0: colOf(a[0], bbox, w), y0, x1: colOf(b[0], bbox, w), y1 });
    }
  }
  return out;
}

/**
 * Even-odd scanline fill of closed lon/lat rings into a 1-byte-per-texel mask
 * (255 = land). Edges are bucketed by row so the 19k-point mainland ring costs
 * one pass, not one polygon test per texel.
 */
export function rasterizeLandMask(
  rings: readonly (readonly LonLat[])[],
  bbox: BBox,
  w: number = LAND_MASK_W,
  h: number = LAND_MASK_H,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  const edges = edgesOf(rings, bbox, w, h);
  if (edges.length === 0) {
    return mask;
  }

  const buckets: Edge[][] = Array.from({ length: h }, () => []);
  for (const e of edges) {
    const lo = Math.max(0, Math.ceil(Math.min(e.y0, e.y1) - 0.5));
    const hi = Math.min(h - 1, Math.floor(Math.max(e.y0, e.y1) - 0.5));
    for (let row = lo; row <= hi; row++) {
      buckets[row]!.push(e);
    }
  }

  const xs: number[] = [];
  for (let row = 0; row < h; row++) {
    const bucket = buckets[row]!;
    if (bucket.length === 0) {
      continue;
    }
    const y = row + 0.5;
    xs.length = 0;
    for (const e of bucket) {
      // Half-open in y so a vertex shared by two edges counts once.
      if (y < Math.min(e.y0, e.y1) || y >= Math.max(e.y0, e.y1)) {
        continue;
      }
      xs.push(e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0));
    }
    if (xs.length < 2) {
      continue;
    }
    xs.sort((a, b) => a - b);
    const base = row * w;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i]! - 0.5));
      const to = Math.min(w - 1, Math.floor(xs[i + 1]! - 0.5));
      for (let col = from; col <= to; col++) {
        mask[base + col] = 255;
      }
    }
  }
  return mask;
}

/**
 * Land test against the rasterised mask rather than the rings, so the CPU
 * arrows and the GPU particles agree texel for texel.
 */
export function pointOnLand(
  mask: Uint8Array,
  bbox: BBox,
  lon: number,
  lat: number,
  w: number = LAND_MASK_W,
  h: number = LAND_MASK_H,
): boolean {
  const col = Math.floor(colOf(lon, bbox, w));
  const row = Math.floor(rowOf(lat, bbox, h));
  if (col < 0 || row < 0 || col >= w || row >= h) {
    return false;
  }
  return mask[row * w + col] === 255;
}

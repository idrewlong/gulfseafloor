export const DEFAULT_EXAGGERATION = 1;

/**
 * Hypsometric window. The chart used to stop at the Bight's −81 m floor, so
 * −80 covered it. Extending south past Southwest Pass to the shelf break put
 * the head of Mississippi Canyon inside the AOI and dropped the real floor to
 * −2505 m: a fifth of the chart now lies deeper than the old window's end.
 *
 * The window is the full range rather than the old −80. That is a deliberate
 * trade, not an oversight — it buys relief in the canyon at the cost of
 * compressing the Sound and the delta into the top few percent of the ramp,
 * where `absorb` in lut.ts and terrain.frag.glsl has already saturated.
 * Shallow water reads mostly through the scatter term's 1–8 m smoothstep.
 */
export const DEFAULT_DEPTH_MIN = -2500;
export const DEFAULT_DEPTH_MAX = 12;

/** Kept as documentation of the old drop; skirt fragments are discarded, not shaded. */
export const SKIRT_METRES = 1.5;

/**
 * Radians from +Z. The chart is a flat map first: zero is dead top-down and is
 * where it opens. The ceiling is a slight tilt for reading relief — far short
 * of the angle that would show the slab edge-on or its underside.
 */
export const CAMERA_MIN_POLAR = 0;
export const CAMERA_MAX_POLAR = Math.PI * 0.14;

/** Vertex displacement: metres of elevation × exaggeration. Same scale on land and water. */
export function displacedZ(elevationMetres: number, exaggeration: number): number {
  return elevationMetres * exaggeration;
}

/**
 * Skirt triangles always hang below the slab (the outer half still does
 * even if only vSkirt > 0.5 is discarded). Never shade them.
 */
export function skirtVisibleFrom(_viewDirZ: number): boolean {
  return false;
}

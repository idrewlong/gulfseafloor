export const DEFAULT_EXAGGERATION = 1;

/** Hypsometric window. Synthetic mid-shelf at 42354 is ~−80 m; inland plain caps at +12 m. */
export const DEFAULT_DEPTH_MIN = -80;
export const DEFAULT_DEPTH_MAX = 12;

/** Kept as documentation of the old drop; skirt fragments are discarded, not shaded. */
export const SKIRT_METRES = 1.5;

/** Radians from +Z. High enough to avoid the pole-flip, low enough to stay off the horizon. */
export const CAMERA_MIN_POLAR = Math.PI * 0.12;
export const CAMERA_MAX_POLAR = Math.PI * 0.40;

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

export const DEFAULT_EXAGGERATION = 1;

/**
 * Hypsometric window. GEBCO bottoms out at −81 m inside the AOI, at the
 * southeast corner where the Bight opens toward DeSoto Canyon; inland
 * pine-coast caps at +12 m.
 */
export const DEFAULT_DEPTH_MIN = -80;
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

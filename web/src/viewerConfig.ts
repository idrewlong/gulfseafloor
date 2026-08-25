export const DEFAULT_EXAGGERATION = 1;

/** World-space skirt drop at 1×. Scaled by exaggeration in the shader. */
export const SKIRT_METRES = 1.5;

/** Radians from +Z. High enough to avoid the pole-flip, low enough to stay off the horizon. */
export const CAMERA_MIN_POLAR = Math.PI * 0.12;
export const CAMERA_MAX_POLAR = Math.PI * 0.40;

/** Vertex displacement: metres of elevation × exaggeration. Same scale on land and water. */
export function displacedZ(elevationMetres: number, exaggeration: number): number {
  return elevationMetres * exaggeration;
}

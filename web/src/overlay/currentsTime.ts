import type { VelocityGrid, VelocityStack } from './currentsField.ts';

/**
 * Bracketing step indices and the fraction between them. Times outside the
 * window clamp to an end step, so the field is never extrapolated.
 */
export function bracket(times: number[], tMs: number): { i0: number; i1: number; t: number } {
  const last = times.length - 1;
  if (times.length === 0) {
    return { i0: 0, i1: 0, t: 0 };
  }
  if (tMs <= times[0]!) {
    return { i0: 0, i1: 0, t: 0 };
  }
  if (tMs >= times[last]!) {
    return { i0: last, i1: last, t: 0 };
  }
  let i1 = 1;
  while (i1 < last && times[i1]! < tMs) {
    i1++;
  }
  const i0 = i1 - 1;
  const span = times[i1]! - times[i0]!;
  return { i0, i1, t: span <= 0 ? 0 : (tMs - times[i0]!) / span };
}

function blend(a: number | null, b: number | null, t: number): number | null {
  // Null is no-data. Blending it toward a real value would invent current.
  if (a == null || b == null) {
    return null;
  }
  return a * (1 - t) + b * t;
}

/** The velocity field at `tMs`, linearly interpolated between forecast steps. */
export function interpolateGrid(stack: VelocityStack, tMs: number): VelocityGrid {
  const { i0, i1, t } = bracket(stack.times, tMs);
  const u0 = stack.u[i0]!;
  const u1 = stack.u[i1]!;
  const v0 = stack.v[i0]!;
  const v1 = stack.v[i1]!;
  const n = stack.nx * stack.ny;
  const u = new Array<number | null>(n);
  const v = new Array<number | null>(n);
  for (let i = 0; i < n; i++) {
    u[i] = blend(u0[i]!, u1[i]!, t);
    v[i] = blend(v0[i]!, v1[i]!, t);
  }
  return { nx: stack.nx, ny: stack.ny, bbox: stack.bbox, u, v };
}

/** True when now falls outside the covered forecast window. */
export function isStale(stack: VelocityStack, tMs: number): boolean {
  if (stack.times.length === 0) {
    return true;
  }
  return tMs < stack.times[0]! || tMs > stack.times[stack.times.length - 1]!;
}

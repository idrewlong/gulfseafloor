/**
 * Camera framing for a full-bleed chart: how far back to sit so the AOI covers
 * the viewport with no edge showing, how much tilt the current zoom can afford
 * before the view spills off the chart, and where the look-at may travel.
 *
 * All of it is plain geometry on the local metric plane (X east, Y north,
 * metres), so it stays testable without a WebGL context.
 */

/** A box on the local metric plane. */
export type Extent = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Never let a frustum edge graze the horizon, where the footprint blows up. */
const MAX_RAY_ANGLE = Math.PI * 0.47;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Camera distance at which the chart covers the whole viewport — the map fills
 * the screen and no edge shows. This is the zoom-out limit: the tighter of the
 * two axes decides, so the chart always overruns the frame on the other one.
 */
export function coverDistance(opts: {
  extent: Extent;
  fovDeg: number;
  viewportWidth: number;
  viewportHeight: number;
}): number {
  const width = Math.max(1, opts.viewportWidth);
  const height = Math.max(1, opts.viewportHeight);
  const spanX = Math.max(0, opts.extent.maxX - opts.extent.minX);
  const spanY = Math.max(0, opts.extent.maxY - opts.extent.minY);

  // Ground metres per pixel is uniform; take whichever axis runs out first, so
  // the view never grows past the chart on either one.
  const metresPerPixel = Math.min(spanX / width, spanY / height);
  return (metresPerPixel * height) / (2 * Math.tan((opts.fovDeg * Math.PI) / 360));
}

/**
 * Ground box the camera actually covers, as offsets from the look-at point.
 * A tilted camera sees a trapezoid; this is its axis-aligned bound, which is
 * what the pan clamp needs.
 */
export function viewFootprint(opts: {
  distance: number;
  fovDeg: number;
  aspect: number;
  polar: number;
  azimuth: number;
}): Extent {
  const halfFov = (opts.fovDeg * Math.PI) / 360;
  const polar = Math.abs(opts.polar);
  const eyeHeight = opts.distance * Math.cos(polar);
  const nadir = -opts.distance * Math.sin(polar);

  const farAngle = clamp(polar + halfFov, -MAX_RAY_ANGLE, MAX_RAY_ANGLE);
  const nearAngle = clamp(polar - halfFov, -MAX_RAY_ANGLE, MAX_RAY_ANGLE);
  const far = nadir + eyeHeight * Math.tan(farAngle);
  const near = nadir + eyeHeight * Math.tan(nearAngle);

  // Half-width grows with the slant range, so the far edge is the widest.
  // At slant range L the camera-space depth is L·cos(halfFov), so the ground
  // half-width is L·cos(halfFov)·tan(halfFov)·aspect — that is, L·sin(halfFov)·aspect.
  const widthPerRange = opts.aspect * Math.sin(halfFov);
  const farWidth = (eyeHeight / Math.cos(farAngle)) * widthPerRange;
  const nearWidth = (eyeHeight / Math.cos(nearAngle)) * widthPerRange;

  // azimuth 0 looks north: forward is +Y, right is +X.
  const fx = Math.sin(opts.azimuth);
  const fy = Math.cos(opts.azimuth);
  const rx = Math.cos(opts.azimuth);
  const ry = -Math.sin(opts.azimuth);

  const corners: Array<{ x: number; y: number }> = [];
  for (const [along, width] of [
    [far, farWidth],
    [near, nearWidth],
  ] as const) {
    for (const side of [-1, 1]) {
      corners.push({
        x: fx * along + rx * width * side,
        y: fy * along + ry * width * side,
      });
    }
  }

  return {
    minX: Math.min(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

/** Does the whole view still land on the chart at this tilt? */
function coveredAt(opts: {
  distance: number;
  fovDeg: number;
  aspect: number;
  extent: Extent;
  polar: number;
}): boolean {
  const fp = viewFootprint({ ...opts, azimuth: 0 });
  return (
    fp.maxX - fp.minX <= opts.extent.maxX - opts.extent.minX &&
    fp.maxY - fp.minY <= opts.extent.maxY - opts.extent.minY
  );
}

/**
 * Steepest tilt the current zoom can afford without the view spilling off the
 * chart. Tilting widens the ground footprint, so zoomed out to the whole chart
 * there is no room for any and the answer is zero; zoom in and it opens up to
 * `ceiling`. Footprint growth is monotonic in the tilt, so a bisection finds
 * the crossing exactly rather than guessing at it.
 */
export function maxPolarForCoverage(opts: {
  distance: number;
  fovDeg: number;
  aspect: number;
  extent: Extent;
  ceiling: number;
}): number {
  if (!coveredAt({ ...opts, polar: 0 })) {
    return 0;
  }
  if (coveredAt({ ...opts, polar: opts.ceiling })) {
    return opts.ceiling;
  }
  let lo = 0;
  let hi = opts.ceiling;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (coveredAt({ ...opts, polar: mid })) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function clampAxis(
  value: number,
  chartMin: number,
  chartMax: number,
  viewMin: number,
  viewMax: number,
): number {
  const lo = chartMin - viewMin;
  const hi = chartMax - viewMax;
  if (lo > hi) {
    // The view is wider than the chart on this axis: centre instead of fight.
    return (chartMin + chartMax) / 2 - (viewMin + viewMax) / 2;
  }
  return clamp(value, lo, hi);
}

/**
 * Pull the look-at point back until the whole footprint sits on the chart, so
 * panning stops at the edge instead of drifting into void.
 */
export function clampToFootprint(
  target: { x: number; y: number },
  chart: Extent,
  footprint: Extent,
): { x: number; y: number } {
  return {
    x: clampAxis(target.x, chart.minX, chart.maxX, footprint.minX, footprint.maxX),
    y: clampAxis(target.y, chart.minY, chart.maxY, footprint.minY, footprint.maxY),
  };
}

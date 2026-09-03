import { msToKnots } from './windBarb.ts';

/** Ramp ceiling. Loop Current filaments run near 1.5 m/s (~3 kt). */
export const SPEED_MAX_MS = 1.5;

/**
 * Deep indigo → cyan → mint → pale yellow. Anchored in cyan to keep the
 * established currents identity, and ending high-luminance and saturated so
 * it cannot be confused with the muted teal-and-sand hypsometric ramp in
 * `lut.ts`. Luminance rises monotonically so speed reads at a glance.
 */
const STOPS: Array<[number, number, number]> = [
  [0.09, 0.13, 0.36],
  [0.13, 0.42, 0.63],
  [0.25, 0.72, 0.78],
  [0.55, 0.90, 0.75],
  [0.97, 0.95, 0.70],
];

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Linear-space RGB in 0..1 for a speed in m/s. Out-of-range clamps. */
export function speedColor(speedMs: number): [number, number, number] {
  const f = clamp01((Number.isFinite(speedMs) ? speedMs : 0) / SPEED_MAX_MS);
  const last = STOPS.length - 1;
  const scaled = f * last;
  const i = Math.min(Math.floor(scaled), last - 1);
  const t = scaled - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t,
    a[2] * (1 - t) + b[2] * t,
  ];
}

function css(color: [number, number, number]): string {
  const [r, g, b] = color.map((c) => Math.round(c * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Horizontal CSS gradient: 0 m/s at the left, SPEED_MAX_MS at the right. */
export function speedRampCss(): string {
  const steps = 12;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    stops.push(`${css(speedColor(f * SPEED_MAX_MS))} ${(f * 100).toFixed(0)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Legend ticks at quarter points, labelled in knots. */
export function speedLegendTicks(): Array<{ frac: number; label: string }> {
  return [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    frac,
    label: `${msToKnots(frac * SPEED_MAX_MS).toFixed(1)} kt`,
  }));
}

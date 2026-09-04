/**
 * Track geometry and wording for the timeline bar.
 *
 * Pure, and kept apart from timeline.ts for the same reason labelLayout.ts is
 * kept apart from labels.ts: the arithmetic and the phrasing are the parts
 * worth testing, and neither needs a DOM to be checked.
 */
import { covers, extent, type Coverage, type Extent } from '../time/axis.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Where `tMs` sits on the track, 0 at the left edge and 1 at the right. */
export function fraction(e: Extent, tMs: number): number {
  const span = e.t1 - e.t0;
  if (span <= 0) {
    return 0;
  }
  return Math.min(Math.max((tMs - e.t0) / span, 0), 1);
}

/**
 * The coverage row for one layer, as fractions of the track.
 *
 * An instant is drawn across the window `covers()` actually accepts — its
 * declared freshness either side of the observation — so the row on screen
 * and the drop-out rule cannot tell the viewer different things.
 */
export function barGeometry(e: Extent, cov: Coverage): { left: number; width: number } {
  if (cov.kind === 'instant') {
    const half = cov.staleAfterMs ?? 0;
    const left = fraction(e, cov.t0 - half);
    return { left, width: fraction(e, cov.t0 + half) - left };
  }
  const left = fraction(e, cov.t0);
  return { left, width: fraction(e, cov.t1) - left };
}

/**
 * Playback rate that walks the whole extent in `sweepMs` of real time, so a
 * two-hour radar loop and a twenty-seven-hour forecast both take about the
 * same time to watch.
 */
export function sweepRateX(e: Extent, sweepMs: number): number {
  if (sweepMs <= 0) {
    return 1;
  }
  return (e.t1 - e.t0) / sweepMs;
}

/**
 * The head readout. Carries the day as well as the hour: the axis spans more
 * than twenty-four hours and a bare `18Z` would be ambiguous across midnight.
 */
export function headLabel(tMs: number): string {
  const d = new Date(tMs);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}Z`;
}

/**
 * The layers the timeline draws rows for.
 *
 * The bar is the weather timelapse: radar and the forecast field are what it
 * loops over. Currents, buoys and aircraft still read the head and still
 * drop out where they have no data — they just are not the subject.
 */
export function timelineRows(coverage: Coverage[]): Coverage[] {
  return coverage.filter((c) => c.track === 'weather');
}

/**
 * The track's span: the weather layers, not every layer on the chart.
 *
 * Chart layers still follow the head and still drop out where they have no
 * data, but they must not stretch the bar — a currents stack reaching a day
 * ahead would leave a play sweep running mostly over blank radar.
 */
export function weatherExtent(coverage: Coverage[]): Extent | null {
  return extent(timelineRows(coverage));
}

export type LayerStatus = {
  id: string;
  label: string;
  covered: boolean;
  /** Why the layer is not drawn. Empty while it is. */
  note: string;
};

/**
 * Whether a layer draws at `tMs`, and if not, the boundary that stopped it.
 *
 * The note names a time rather than saying "unavailable", because the useful
 * fact is where the data ends — a viewer who scrubbed two hours past the last
 * radar frame should be told that, not left guessing whether the layer broke.
 */
export function layerStatus(cov: Coverage, tMs: number): LayerStatus {
  const base = { id: cov.id, label: cov.label };
  if (covers([cov], cov.id, tMs)) {
    return { ...base, covered: true, note: '' };
  }
  if (cov.kind === 'instant') {
    return { ...base, covered: false, note: `observed ${headLabel(cov.t0)} · live only` };
  }
  const note =
    tMs > cov.t1 ? `no data after ${headLabel(cov.t1)}` : `no data before ${headLabel(cov.t0)}`;
  return { ...base, covered: false, note };
}

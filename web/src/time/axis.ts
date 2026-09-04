/**
 * The chart's time axis.
 *
 * Every layer carries a time — HYCOM a forecast step, NDBC an observation,
 * ADS-B a position report — and until this module they each silently assumed
 * `Date.now()`. The axis makes the displayed time one explicit value that
 * layers read, and makes each layer declare the window it can actually speak
 * for, so the viewer can refuse to draw a layer outside it.
 *
 * Everything here is pure: no DOM, no three.js, and no clock. `nowMs` is an
 * argument for the same reason `interpolateGrid(stack, tMs)` takes one — it
 * makes the behaviour testable without fake timers.
 */

/** The kind of window a layer covers. */
export type CoverageKind =
  /** A continuous window: a forecast stack, a radar loop. */
  | 'span'
  /** A single moment: an observation. Valid for `staleAfterMs` around `t0`. */
  | 'instant';

/**
 * Which band of the chart a layer belongs to.
 *
 * The timeline is the weather timelapse control, so only 'weather' layers
 * get a row on it. Chart layers still register and still follow the head —
 * they are simply not what the loop is of.
 */
export type CoverageTrack = 'weather' | 'chart';

/** One layer's declaration of the time it can speak for. */
export type Coverage = {
  id: string;
  label: string;
  kind: CoverageKind;
  /** Defaults to 'chart' when absent. */
  track?: CoverageTrack;
  t0: number;
  t1: number;
  /**
   * For an instant, the datum's own nominal freshness — NDBC's reporting
   * cadence, ADS-B's update rate. Not a grace period for showing stale data
   * under a "now" label: outside it the layer drops out like any other.
   */
  staleAfterMs?: number;
};

export type AxisState = {
  /** The time the chart is showing. */
  headMs: number;
  /** The head is pinned to the wall clock and follows it. */
  live: boolean;
  /** The head is sweeping the extent under `advance`. */
  playing: boolean;
  /** Playback speed: displayed milliseconds per real millisecond. */
  rateX: number;
  coverage: Coverage[];
};

export type Extent = { t0: number; t1: number };

/**
 * The union of every registered window — the scrubber's span.
 *
 * Null when nothing has loaded, which is how the timeline knows to stay
 * hidden rather than draw an axis over no data. Disjoint windows union into
 * one span: a hole in the middle is real, and the per-layer coverage rows are
 * where it gets shown, not here.
 */
export function extent(coverage: Coverage[]): Extent | null {
  if (coverage.length === 0) {
    return null;
  }
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const c of coverage) {
    t0 = Math.min(t0, c.t0);
    t1 = Math.max(t1, c.t1);
  }
  return { t0, t1 };
}

/** Whether `id` has data at `tMs`. False for a layer that never registered. */
export function covers(coverage: Coverage[], id: string, tMs: number): boolean {
  const c = coverage.find((x) => x.id === id);
  if (c == null) {
    return false;
  }
  if (c.kind === 'instant') {
    return Math.abs(tMs - c.t0) <= (c.staleAfterMs ?? 0);
  }
  return tMs >= c.t0 && tMs <= c.t1;
}

/**
 * `tMs` held inside the extent. Passed through untouched when nothing has
 * loaded — there is no window to clamp to yet, and inventing one would move
 * the head somewhere no data supports.
 */
export function clampHead(state: AxisState, tMs: number, bounds?: Extent | null): number {
  const e = bounds ?? extent(state.coverage);
  if (e == null) {
    return tMs;
  }
  return Math.min(Math.max(tMs, e.t0), e.t1);
}

/**
 * The state one frame later.
 *
 * Live wins over playing: pinning to the wall clock means the frame delta is
 * irrelevant, and re-pinning every frame is what makes the head follow new
 * data as it lands. Playback sweeps and loops; it never runs off the end.
 */
export function advance(
  state: AxisState,
  dtMs: number,
  nowMs: number,
  bounds?: Extent | null,
): AxisState {
  if (state.live) {
    const headMs = clampHead(state, nowMs, bounds);
    return headMs === state.headMs ? state : { ...state, headMs };
  }
  if (!state.playing) {
    return state;
  }
  const e = bounds ?? extent(state.coverage);
  if (e == null) {
    return state;
  }
  const next = state.headMs + dtMs * state.rateX;
  return { ...state, headMs: next > e.t1 ? e.t0 : Math.max(next, e.t0) };
}

/**
 * Move the head by hand. This is the gesture that means "stop showing me
 * now", so it drops both live and playback rather than leaving the head
 * fighting the clock.
 */
export function scrubTo(state: AxisState, tMs: number, bounds?: Extent | null): AxisState {
  return { ...state, headMs: clampHead(state, tMs, bounds), live: false, playing: false };
}

/** Return the head to the wall clock. */
export function snapLive(state: AxisState, nowMs: number, bounds?: Extent | null): AxisState {
  return { ...state, headMs: clampHead(state, nowMs, bounds), live: true, playing: false };
}

/**
 * Declare a layer's window, replacing any previous declaration for the same
 * id — layers re-register whenever their data refreshes, and a stack that
 * moved forward must not leave its old window on the axis.
 *
 * Re-clamps the head, because a window that shrank can strand it outside the
 * data.
 */
export function register(state: AxisState, cov: Coverage): AxisState {
  const next = { ...state, coverage: [...state.coverage.filter((c) => c.id !== cov.id), cov] };
  return { ...next, headMs: clampHead(next, next.headMs) };
}

/** Drop a layer's window, re-clamping the head into what is left. */
export function unregister(state: AxisState, id: string): AxisState {
  const next = { ...state, coverage: state.coverage.filter((c) => c.id !== id) };
  return { ...next, headMs: clampHead(next, next.headMs) };
}

/** A subscribable holder for one `AxisState`. */
export type AxisStore = {
  state(): AxisState;
  /** The time the chart is showing — the value layers read every frame. */
  head(): number;
  update(fn: (s: AxisState) => AxisState): void;
  /** Returns an unsubscribe function. */
  subscribe(fn: (s: AxisState) => void): () => void;
};

/**
 * The axis every layer shares, starting live at `nowMs` with nothing
 * registered — an empty axis has no extent, so the timeline stays hidden
 * until the first layer loads.
 *
 * `update` notifies only when the reducer actually returned a new state. The
 * render loop calls `advance` every frame, and a paused axis returns its
 * state object unchanged; without this check every layer would repaint sixty
 * times a second for a time that did not move.
 */
export function createAxis(nowMs: number): AxisStore {
  let current: AxisState = {
    headMs: nowMs,
    live: true,
    playing: false,
    rateX: 1,
    coverage: [],
  };
  const listeners = new Set<(s: AxisState) => void>();

  return {
    state: () => current,
    head: () => current.headMs,
    update(fn) {
      const next = fn(current);
      if (next === current) {
        return;
      }
      current = next;
      // Copy: a listener may unsubscribe itself while being notified.
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

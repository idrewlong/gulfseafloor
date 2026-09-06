/**
 * The aircraft layer's whole lifecycle, in one place.
 *
 * This used to be ~110 lines of loose `let`s and closures in main.ts: the
 * availability flag, the priming flag, the poll timer, the report, and the
 * per-frame scratch rows were all module-level state that any other layer's
 * code could reach. Nothing enforced that `aircraftPrimed` was only ever set
 * beside `aircraftAvailableStatus`, and the timer was cleared and re-armed
 * from three different places.
 *
 * It does not use the generic `poller`: aircraft is the one layer whose
 * cadence depends on more than the last result. It stops entirely while the
 * tab is hidden or the layer is switched off, and re-probes a failed upstream
 * on a slower clock — the policy for which lives in aircraftUi.ts and is
 * tested there.
 */
import {
  aircraftAvailable,
  aircraftPollIntervalMs,
  deadReckonInto,
  shouldPollAircraft,
  shouldReprobeAircraft,
  type Aircraft,
} from './aircraftUi.ts';
import { parseAircraftJson } from './aircraft.ts';

export type AircraftLayerOptions = {
  /** Fetch that resolves to a Response even when the network is down. */
  fetchOk: (url: string) => Promise<Response>;
  /** Mount/unmount the marks. Owned by the caller; this only drives it. */
  setAircraft: (rows: Aircraft[]) => void;
  setEnabled: (on: boolean) => void;
  /** Reflect availability and checked-state into the layers panel. */
  setToggle: (available: boolean, on: boolean) => void;
  /** Called after any change that the caption or visibility depends on. */
  onChange: () => void;
  /** Whether the layer should start on. A shared link overrides the default. */
  initiallyOn: boolean;
};

export type AircraftLayer = {
  /** True when the reader has the layer switched on. */
  on(): boolean;
  /** Switch the layer on or off; re-arms or stops the poll to match. */
  setOn(on: boolean): void;
  /** The feed name and fetch time, for the caption. */
  source(): string | null;
  fetchedAt(): string | null;
  /**
   * Advance the rows to `nowMs` by dead reckoning and hand them back. Returns
   * null when there is nothing to draw. The array is reused between frames.
   */
  rowsAt(reduced: boolean): Aircraft[] | null;
  /** Poll now. */
  refresh(): Promise<void>;
  destroy(): void;
};

export function createAircraftLayer(opts: AircraftLayerOptions): AircraftLayer {
  let on = false;
  let available = false;
  let primed = false;
  let source: string | null = null;
  let fetchedAt: string | null = null;
  let report: { t: number; rows: Aircraft[] } | null = null;
  // Dead reckoning moves only lon/lat, so the report's rows are copied once
  // when a report lands and mutated in place afterwards. Rebuilding them with
  // a spread every frame allocated an object per aircraft per frame.
  let frameRows: Aircraft[] = [];
  let timer: number | undefined;
  let destroyed = false;

  const pollOpts = (): {
    mode: 'globe' | 'bathymetry';
    layerOn: boolean;
    documentHidden: boolean;
    available: boolean;
    primed: boolean;
  } => ({
    mode: 'bathymetry',
    layerOn: on,
    documentHidden: document.hidden,
    available,
    primed,
  });

  const clearTimer = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const reschedule = (): void => {
    clearTimer();
    if (destroyed) {
      return;
    }
    const o = pollOpts();
    if (shouldPollAircraft(o) || shouldReprobeAircraft(o)) {
      timer = window.setInterval(() => {
        void pull();
      }, aircraftPollIntervalMs(available));
    }
  };

  const markUnavailable = (): void => {
    available = false;
    on = false;
    primed = true;
    source = null;
    fetchedAt = null;
    report = null;
    frameRows = [];
    opts.setToggle(false, false);
    opts.setAircraft([]);
    opts.setEnabled(false);
  };

  const pull = async (): Promise<void> => {
    if (destroyed) {
      return;
    }
    try {
      const res = await opts.fetchOk('/api/aircraft');
      if (!aircraftAvailable(res.status)) {
        markUnavailable();
        opts.onChange();
        reschedule();
        return;
      }
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
      const parsed = parseAircraftJson(raw);
      if (!parsed) {
        markUnavailable();
        opts.onChange();
        reschedule();
        return;
      }
      const recovering = !available;
      available = true;
      if (!primed || recovering) {
        // A shared link that had aircraft off must not have them switched
        // back on the moment the first poll succeeds.
        on = opts.initiallyOn;
        primed = true;
      }
      opts.setToggle(true, on);
      source = parsed.source;
      fetchedAt = parsed.fetchedAt;
      report = { t: performance.now(), rows: parsed.aircraft };
      frameRows = parsed.aircraft.map((row) => ({ ...row }));
      opts.setAircraft(parsed.aircraft);
      opts.onChange();
      reschedule();
    } catch {
      markUnavailable();
      opts.onChange();
      reschedule();
    }
  };

  const onVisibility = (): void => {
    clearTimer();
    const o = pollOpts();
    if (shouldPollAircraft(o) || shouldReprobeAircraft(o)) {
      void pull();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    on: () => on,
    setOn(next: boolean): void {
      if (next === on) {
        return;
      }
      on = next;
      onVisibility();
    },
    source: () => source,
    fetchedAt: () => fetchedAt,
    rowsAt(reduced: boolean): Aircraft[] | null {
      if (!report) {
        return null;
      }
      const dt = reduced ? 0 : (performance.now() - report.t) / 1000;
      const rows = report.rows;
      for (let i = 0; i < rows.length; i++) {
        const src = rows[i];
        const dst = frameRows[i];
        if (src && dst) {
          deadReckonInto(src, dt, dst);
        }
      }
      return frameRows;
    },
    refresh: pull,
    destroy(): void {
      destroyed = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

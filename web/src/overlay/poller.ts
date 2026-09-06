/**
 * The one polling loop every live layer runs.
 *
 * Currents, buoys and aircraft all did the same three things by hand in
 * main.ts: load once, set an interval, and swallow errors. They also all
 * shared the same defect — the interval was armed whether or not the
 * endpoint existed, so a server with no snapshot (or an air-gapped one,
 * where `GULF_OCEAN_REFRESH=0` guarantees it never will have) was asked for
 * it every few minutes for the life of the tab.
 *
 * A load reports back what it learned, and the poller acts on it:
 *
 *   'ok'          — data arrived; keep polling on the normal cadence.
 *   'empty'       — the endpoint is there but has nothing yet. This is the
 *                   routine first-boot case: the server's own refreshers
 *                   land 15–25s after it starts, so the layer 404s and then
 *                   begins working. Keep polling.
 *   'unavailable' — the layer is switched off at the server and will not
 *                   appear. Stop, and leave it to `probe()` if a caller
 *                   wants to look again later.
 */
export type LoadResult = 'ok' | 'empty' | 'unavailable';

export type Poller = {
  /** Run a load now, outside the schedule. Safe to call when stopped. */
  refresh(): Promise<void>;
  /** Stop polling. Idempotent. */
  stop(): void;
  /** True while an interval is armed. */
  running(): boolean;
};

export type PollerOptions = {
  /** One fetch-and-apply cycle. Must not throw; a throw is read as 'empty'. */
  load: () => Promise<LoadResult>;
  /** Normal cadence, in ms. */
  everyMs: number;
  /**
   * How long to wait before re-probing a layer that reported 'unavailable'.
   * Omitted means never: the layer is gone until the page reloads.
   *
   * Aircraft uses this. It is the one layer whose upstream is a third party
   * that can fail and recover inside a single session, and probing it costs
   * one request. The ocean layers do not: their availability is a server
   * configuration, and it does not change under a running server.
   */
  reprobeMs?: number;
};

export function createPoller(opts: PollerOptions): Poller {
  const { load, everyMs, reprobeMs } = opts;
  let timer: number | undefined;
  let stopped = false;

  const clear = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  const arm = (ms: number): void => {
    clear();
    if (stopped || !Number.isFinite(ms) || ms <= 0) {
      return;
    }
    timer = window.setInterval(() => {
      void cycle();
    }, ms);
  };

  const cycle = async (): Promise<void> => {
    let result: LoadResult;
    try {
      result = await load();
    } catch {
      // A failed poll keeps whatever is already loaded. The next tick
      // retries; a transient network error is not a reason to give up on a
      // layer the server does have.
      result = 'empty';
    }
    if (stopped) {
      return;
    }
    if (result === 'unavailable') {
      if (reprobeMs != null && reprobeMs > 0) {
        arm(reprobeMs);
        return;
      }
      clear();
      return;
    }
    arm(everyMs);
  };

  void cycle();

  return {
    refresh: cycle,
    stop(): void {
      stopped = true;
      clear();
    },
    running: (): boolean => timer !== undefined,
  };
}

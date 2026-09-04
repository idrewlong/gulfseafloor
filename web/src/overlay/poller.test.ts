import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createPoller, type LoadResult } from './poller.ts';

/**
 * A hand-cranked stand-in for window's interval timers, so the tests can
 * step time instead of waiting on it.
 */
type FakeClock = {
  tick(): void;
  armed(): number | null;
  restore(): void;
};

function installClock(): FakeClock {
  let handle = 0;
  let active: { id: number; fn: () => void; ms: number } | null = null;
  const g = globalThis as unknown as {
    window?: unknown;
    setInterval?: unknown;
    clearInterval?: unknown;
  };
  const prior = g.window;
  g.window = {
    setInterval(fn: () => void, ms: number): number {
      handle += 1;
      active = { id: handle, fn, ms };
      return handle;
    },
    clearInterval(id: number): void {
      if (active && active.id === id) {
        active = null;
      }
    },
  };
  return {
    tick(): void {
      active?.fn();
    },
    armed(): number | null {
      return active ? active.ms : null;
    },
    restore(): void {
      g.window = prior;
    },
  };
}

/** Let the poller's floating promises settle. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createPoller', () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = installClock();
  });
  afterEach(() => {
    clock.restore();
  });

  it('loads once immediately, without waiting for the first interval', async () => {
    let calls = 0;
    createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        return 'ok';
      },
      everyMs: 1000,
    });
    await settle();
    assert.equal(calls, 1);
  });

  it('keeps polling while the layer reports data', async () => {
    let calls = 0;
    createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        return 'ok';
      },
      everyMs: 1000,
    });
    await settle();
    assert.equal(clock.armed(), 1000);
    clock.tick();
    await settle();
    assert.equal(calls, 2);
  });

  // The routine first-boot sequence: the server's own refreshers land
  // 15-25s after it starts, so a layer 404s and then begins working.
  it('keeps polling an endpoint that is present but still empty', async () => {
    let calls = 0;
    createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        return calls === 1 ? 'empty' : 'ok';
      },
      everyMs: 1000,
    });
    await settle();
    assert.equal(clock.armed(), 1000, 'an empty layer must stay scheduled');
    clock.tick();
    await settle();
    assert.equal(calls, 2);
  });

  // The bug this type exists to fix: an air-gapped server will never grow a
  // weather snapshot, and asking it every five minutes for the life of the
  // tab is pure noise.
  it('stops polling a layer the server does not serve', async () => {
    let calls = 0;
    createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        return 'unavailable';
      },
      everyMs: 1000,
    });
    await settle();
    assert.equal(clock.armed(), null, 'an unavailable layer must not stay scheduled');
    assert.equal(calls, 1);
  });

  it('re-probes an unavailable layer on the slower cadence when asked to', async () => {
    let calls = 0;
    createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        return calls < 3 ? 'unavailable' : 'ok';
      },
      everyMs: 1000,
      reprobeMs: 60_000,
    });
    await settle();
    assert.equal(clock.armed(), 60_000, 'a recoverable layer re-probes slowly');
    clock.tick();
    await settle();
    assert.equal(clock.armed(), 60_000);
    clock.tick();
    await settle();
    assert.equal(clock.armed(), 1000, 'recovery returns it to the normal cadence');
  });

  // A transient network error is not a reason to abandon a layer the server
  // does have.
  it('treats a thrown load as empty and keeps polling', async () => {
    let calls = 0;
    createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        throw new Error('offline');
      },
      everyMs: 1000,
    });
    await settle();
    assert.equal(clock.armed(), 1000);
    assert.equal(calls, 1);
  });

  it('stops for good once stopped', async () => {
    let calls = 0;
    const p = createPoller({
      load: async (): Promise<LoadResult> => {
        calls += 1;
        return 'ok';
      },
      everyMs: 1000,
    });
    await settle();
    p.stop();
    assert.equal(p.running(), false);
    await p.refresh();
    assert.equal(clock.armed(), null, 'a refresh after stop must not re-arm');
    assert.equal(calls, 2, 'an explicit refresh still runs the load once');
  });
});

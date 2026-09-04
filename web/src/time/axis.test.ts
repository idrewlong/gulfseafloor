import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advance,
  createAxis,
  clampHead,
  covers,
  extent,
  register,
  scrubTo,
  snapLive,
  unregister,
  type AxisState,
  type Coverage,
} from './axis.ts';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-03T12:00:00Z');

const currents: Coverage = {
  id: 'currents',
  label: 'Currents',
  kind: 'span',
  t0: NOW - 3 * HOUR,
  t1: NOW + 24 * HOUR,
};

const radar: Coverage = {
  id: 'radar',
  label: 'Radar',
  kind: 'span',
  t0: NOW - 2 * HOUR,
  t1: NOW,
};

const buoys: Coverage = {
  id: 'buoys',
  label: 'Buoys',
  kind: 'instant',
  t0: NOW - 20 * 60 * 1000,
  t1: NOW - 20 * 60 * 1000,
  staleAfterMs: HOUR,
};

function state(overrides: Partial<AxisState> = {}): AxisState {
  return {
    headMs: NOW,
    live: true,
    playing: false,
    rateX: 1,
    coverage: [currents],
    ...overrides,
  };
}

describe('extent', () => {
  it('unions every registered window', () => {
    assert.deepEqual(extent([radar, currents]), { t0: NOW - 3 * HOUR, t1: NOW + 24 * HOUR });
  });

  it('spans disjoint windows without inventing a gap flag', () => {
    const old: Coverage = { id: 'old', label: 'Old', kind: 'span', t0: NOW - 99 * HOUR, t1: NOW - 98 * HOUR };
    assert.deepEqual(extent([old, radar]), { t0: NOW - 99 * HOUR, t1: NOW });
  });

  it('is null when nothing has loaded, so the bar stays hidden', () => {
    assert.equal(extent([]), null);
  });

  it('includes an instant at its own timestamp', () => {
    assert.deepEqual(extent([buoys]), { t0: buoys.t0, t1: buoys.t0 });
  });
});

describe('covers', () => {
  it('covers a span inclusive of both ends', () => {
    assert.equal(covers([radar], 'radar', radar.t0), true);
    assert.equal(covers([radar], 'radar', radar.t1), true);
    assert.equal(covers([radar], 'radar', radar.t1 + 1), false);
  });

  it('covers an instant within its own declared freshness', () => {
    assert.equal(covers([buoys], 'buoys', NOW), true);
    assert.equal(covers([buoys], 'buoys', buoys.t0 + HOUR), true);
    assert.equal(covers([buoys], 'buoys', buoys.t0 + HOUR + 1), false);
    assert.equal(covers([buoys], 'buoys', buoys.t0 - HOUR - 1), false);
  });

  it('treats an instant with no staleAfterMs as a single moment', () => {
    const tick: Coverage = { id: 'tick', label: 'Tick', kind: 'instant', t0: NOW, t1: NOW };
    assert.equal(covers([tick], 'tick', NOW), true);
    assert.equal(covers([tick], 'tick', NOW + 1), false);
  });

  it('is false for a layer that never registered', () => {
    assert.equal(covers([currents], 'radar', NOW), false);
  });
});

describe('clampHead', () => {
  it('holds the head inside the extent', () => {
    const s = state();
    assert.equal(clampHead(s, NOW + 99 * HOUR), NOW + 24 * HOUR);
    assert.equal(clampHead(s, NOW - 99 * HOUR), NOW - 3 * HOUR);
  });

  it('passes the time through when nothing has loaded', () => {
    assert.equal(clampHead(state({ coverage: [] }), NOW + 99 * HOUR), NOW + 99 * HOUR);
  });
});

describe('advance', () => {
  it('re-pins to the wall clock while live, ignoring the frame delta', () => {
    const next = advance(state({ headMs: NOW - 5 * HOUR }), 16, NOW);
    assert.equal(next.headMs, NOW);
  });

  it('steps by the frame delta times the rate while playing', () => {
    const s = state({ live: false, playing: true, rateX: 600, headMs: NOW });
    assert.equal(advance(s, 1000, NOW).headMs, NOW + 600 * 1000);
  });

  it('loops back to the start of the extent at the end of the sweep', () => {
    const s = state({ live: false, playing: true, rateX: 1, headMs: NOW + 24 * HOUR });
    assert.equal(advance(s, 1000, NOW).headMs, NOW - 3 * HOUR);
  });

  it('holds still when neither live nor playing', () => {
    const s = state({ live: false, playing: false, headMs: NOW + HOUR });
    assert.equal(advance(s, 5000, NOW).headMs, NOW + HOUR);
  });

  it('clamps the live head into the extent when the clock runs past the data', () => {
    const s = state({ coverage: [radar], headMs: NOW });
    assert.equal(advance(s, 16, NOW + 9 * HOUR).headMs, radar.t1);
  });
});

describe('scrubTo', () => {
  it('drops out of live and stops playback', () => {
    const next = scrubTo(state({ playing: true }), NOW + 2 * HOUR);
    assert.equal(next.headMs, NOW + 2 * HOUR);
    assert.equal(next.live, false);
    assert.equal(next.playing, false);
  });

  it('clamps a scrub past the end of the data', () => {
    assert.equal(scrubTo(state(), NOW + 99 * HOUR).headMs, NOW + 24 * HOUR);
  });
});

describe('snapLive', () => {
  it('returns the head to the wall clock and stops playback', () => {
    const next = snapLive(state({ live: false, playing: true, headMs: NOW - 3 * HOUR }), NOW);
    assert.equal(next.headMs, NOW);
    assert.equal(next.live, true);
    assert.equal(next.playing, false);
  });
});

describe('register', () => {
  it('adds a layer window', () => {
    const next = register(state({ coverage: [] }), radar);
    assert.deepEqual(extent(next.coverage), { t0: radar.t0, t1: radar.t1 });
  });

  it('replaces a window on re-registration rather than duplicating it', () => {
    const moved: Coverage = { ...currents, t0: NOW, t1: NOW + 48 * HOUR };
    const next = register(state(), moved);
    assert.equal(next.coverage.length, 1);
    assert.deepEqual(extent(next.coverage), { t0: NOW, t1: NOW + 48 * HOUR });
  });

  it('pulls a stranded head back into the new extent', () => {
    const s = state({ live: false, headMs: NOW + 20 * HOUR, coverage: [] });
    assert.equal(register(s, radar).headMs, radar.t1);
  });

  it('unregisters a layer', () => {
    const s = register(state(), radar);
    assert.deepEqual(unregister(s, 'radar').coverage, [currents]);
  });
});

describe('createAxis', () => {
  it('starts live at the given clock with nothing registered', () => {
    const axis = createAxis(NOW);
    assert.equal(axis.state().headMs, NOW);
    assert.equal(axis.state().live, true);
    assert.equal(axis.state().playing, false);
    assert.deepEqual(axis.state().coverage, []);
  });

  it('notifies subscribers when the state changes', () => {
    const axis = createAxis(NOW);
    const seen: number[] = [];
    axis.subscribe((s) => seen.push(s.headMs));
    axis.update((s) => register(s, currents));
    axis.update((s) => scrubTo(s, NOW + 2 * HOUR));
    assert.deepEqual(seen, [NOW, NOW + 2 * HOUR]);
  });

  // The render loop calls advance() every frame. A paused axis returns the
  // same state object, and repainting every layer 60 times a second for a
  // time that did not move would undo the point of having one clock.
  it('stays quiet when an update returns the state unchanged', () => {
    const axis = createAxis(NOW);
    let calls = 0;
    axis.subscribe(() => {
      calls++;
    });
    axis.update((s) => ({ ...s, live: false, playing: false }));
    calls = 0;
    axis.update((s) => advance(s, 16, NOW));
    assert.equal(calls, 0);
  });

  it('stops notifying an unsubscribed listener', () => {
    const axis = createAxis(NOW);
    let calls = 0;
    const off = axis.subscribe(() => {
      calls++;
    });
    off();
    axis.update((s) => register(s, currents));
    assert.equal(calls, 0);
  });
});

describe('bounds', () => {
  const wide = state({ coverage: [currents] }); // -3h .. +24h
  const weather = { t0: NOW - 2 * HOUR, t1: NOW + 30 * 60 * 1000 };

  // The timeline loops over weather, so it hands its own bounds in rather
  // than letting a currents stack reaching a day ahead stretch the sweep.
  it('clamps to explicit bounds when given them', () => {
    assert.equal(clampHead(wide, NOW + 20 * HOUR, weather), weather.t1);
    assert.equal(clampHead(wide, NOW - 20 * HOUR, weather), weather.t0);
  });

  it('loops playback at the given bounds, not the full coverage', () => {
    const s = { ...wide, live: false, playing: true, rateX: 1, headMs: weather.t1 };
    assert.equal(advance(s, 1000, NOW, weather).headMs, weather.t0);
  });

  it('falls back to the full coverage when no bounds are given', () => {
    assert.equal(clampHead(wide, NOW + 99 * HOUR), NOW + 24 * HOUR);
  });
});

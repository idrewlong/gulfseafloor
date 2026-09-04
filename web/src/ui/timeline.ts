/**
 * The timeline bar: the chart's clock made visible and movable.
 *
 * The arithmetic and the wording live in timelineModel.ts; this file is the
 * DOM and the event wiring only.
 */
import { advance, scrubTo, snapLive, type AxisStore, type Coverage } from '../time/axis.ts';
import type { OutlookDay } from './outlook.ts';
import {
  barGeometry,
  fraction,
  headLabel,
  layerStatus,
  sweepRateX,
  timelineRows,
  weatherExtent,
} from './timelineModel.ts';

/** Real milliseconds a full sweep of the extent should take under play. */
const SWEEP_MS = 20_000;

/** Tallest a day's precipitation bar may draw, in pixels. */
const POP_BAR_PX = 12;

/** Arrow-key nudge, as a fraction of the extent. */
const NUDGE = 1 / 48;

export type TimelineOptions = {
  root: HTMLElement;
  axis: AxisStore;
  /** Injected so the bar is driven by the same clock as the render loop. */
  now: () => number;
};

export type TimelineHandle = {
  /** The seven-day outlook, drawn as the axis's day scale. */
  setOutlook(days: OutlookDay[]): void;
  /** Called from the render loop to step playback and follow the wall clock. */
  tick(dtMs: number): void;
  destroy(): void;
};

export function mountTimeline(opts: TimelineOptions): TimelineHandle {
  const { root, axis, now } = opts;

  root.innerHTML = `
    <div class="tl">
      <div class="tl-transport">
        <button type="button" class="tl-play" aria-label="Play the time sweep">&#9654;</button>
        <button type="button" class="tl-live" aria-pressed="true">Live</button>
      </div>
      <div class="tl-axis">
        <div class="tl-days" aria-hidden="true"></div>
        <div
          class="tl-track"
          role="slider"
          tabindex="0"
          aria-label="Chart time"
          aria-valuetext=""
        >
          <div class="tl-now" aria-hidden="true"></div>
          <div class="tl-handle" aria-hidden="true"></div>
        </div>
        <ul class="tl-rows"></ul>
      </div>
      <div class="tl-stamp">
        <p class="tl-stamp-label">Showing</p>
        <output class="tl-head"></output>
      </div>
    </div>
  `;

  const play = root.querySelector<HTMLButtonElement>('.tl-play');
  const live = root.querySelector<HTMLButtonElement>('.tl-live');
  const track = root.querySelector<HTMLElement>('.tl-track');
  const nowTick = root.querySelector<HTMLElement>('.tl-now');
  const handle = root.querySelector<HTMLElement>('.tl-handle');
  const head = root.querySelector<HTMLOutputElement>('.tl-head');
  const rows = root.querySelector<HTMLUListElement>('.tl-rows');
  const dayRuler = root.querySelector<HTMLElement>('.tl-days');
  if (!play || !live || !track || !nowTick || !handle || !head || !rows || !dayRuler) {
    throw new Error('timeline markup failed to mount');
  }
  let days: OutlookDay[] = [];

  /** The time under a pointer at `clientX`. */
  const timeAt = (clientX: number): number | null => {
    const e = weatherExtent(axis.state().coverage);
    if (e == null) {
      return null;
    }
    const box = track.getBoundingClientRect();
    if (box.width <= 0) {
      return null;
    }
    const f = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
    return e.t0 + f * (e.t1 - e.t0);
  };

  const renderRows = (coverage: Coverage[], headMs: number, e: { t0: number; t1: number }): void => {
    rows.replaceChildren(
      ...coverage.map((cov) => {
        const status = layerStatus(cov, headMs);
        const bar = barGeometry(e, cov);
        const li = document.createElement('li');
        li.className = status.covered ? 'tl-row' : 'tl-row is-uncovered';

        const label = document.createElement('span');
        label.className = 'tl-row-label';
        label.textContent = status.label;

        const rail = document.createElement('span');
        rail.className = 'tl-row-rail';
        const fill = document.createElement('span');
        fill.className = 'tl-row-fill';
        fill.style.left = `${bar.left * 100}%`;
        // A zero-width instant would vanish; give it a hairline so the row
        // still shows where the observation sits.
        fill.style.width = `${Math.max(bar.width * 100, 0.6)}%`;
        rail.append(fill);

        const note = document.createElement('span');
        note.className = 'tl-row-note';
        note.textContent = status.note;

        li.append(label, rail, note);
        return li;
      }),
    );
  };

  /**
   * The seven-day outlook drawn as the axis's own day scale.
   *
   * Each column sits where that day actually falls on the track, so the
   * forecast is the ruler for the thing it describes rather than a detached
   * strip beside it. Days outside the loaded window are simply clipped.
   */
  const renderDays = (e: { t0: number; t1: number }): void => {
    dayRuler.replaceChildren(
      ...days.map((d) => {
        const left = fraction(e, d.start);
        const right = fraction(e, Math.max(d.end, d.start));
        const cell = document.createElement('div');
        cell.className = 'tl-day';
        cell.style.left = `${left * 100}%`;
        cell.style.width = `${Math.max(right - left, 0) * 100}%`;

        const name = document.createElement('span');
        name.className = 'tl-day-name';
        name.textContent = d.label;

        const temps = document.createElement('span');
        temps.className = 'tl-day-temps';
        const hi = d.high == null ? '—' : `${d.high}°`;
        const lo = d.low == null ? '—' : `${d.low}°`;
        temps.textContent = `${hi}/${lo}`;

        cell.append(name, temps);
        cell.title = [d.label, `${hi} / ${lo}`, d.short, d.pop == null ? '' : `${d.pop}% precip`]
          .filter(Boolean)
          .join(' · ');

        if (d.pop != null && d.pop > 0) {
          const pop = document.createElement('span');
          pop.className = 'tl-day-pop';
          // Scaled into a short band rather than the full ruler height: at
          // full height a 60% chance fills most of the cell and reads as a
          // highlight behind the label instead of as a quantity.
          pop.style.height = `${(Math.min(d.pop, 100) / 100) * POP_BAR_PX}px`;
          pop.title = `${d.pop}% chance of precipitation`;
          cell.append(pop);
        }
        return cell;
      }),
    );
  };

  const render = (): void => {
    const state = axis.state();
    // The bar is the weather timelapse control, so it appears — and spans —
    // only when there is weather to loop over.
    const e = weatherExtent(state.coverage);
    root.hidden = e == null;
    if (e == null) {
      return;
    }

    const f = fraction(e, state.headMs);
    handle.style.left = `${f * 100}%`;
    nowTick.style.left = `${fraction(e, now()) * 100}%`;
    head.textContent = headLabel(state.headMs);

    track.setAttribute('aria-valuemin', String(e.t0));
    track.setAttribute('aria-valuemax', String(e.t1));
    track.setAttribute('aria-valuenow', String(state.headMs));
    track.setAttribute('aria-valuetext', headLabel(state.headMs));

    play.textContent = state.playing ? '❚❚' : '▶';
    play.setAttribute('aria-label', state.playing ? 'Pause the time sweep' : 'Play the time sweep');
    live.setAttribute('aria-pressed', String(state.live));
    live.classList.toggle('is-live', state.live);

    renderDays(e);
    renderRows(timelineRows(state.coverage), state.headMs, e);
  };

  const scrubFromPointer = (clientX: number): void => {
    const t = timeAt(clientX);
    if (t != null) {
      axis.update((s) => scrubTo(s, t, weatherExtent(s.coverage)));
    }
  };

  const onPointerMove = (event: PointerEvent): void => scrubFromPointer(event.clientX);
  const onPointerUp = (): void => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  track.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    track.focus();
    scrubFromPointer(event.clientX);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });

  // Bound on the track, not on window: MapControls owns the arrow keys while
  // the canvas has focus, and the two must not fight over them.
  track.addEventListener('keydown', (event) => {
    const e = weatherExtent(axis.state().coverage);
    if (e == null) {
      return;
    }
    const step = (e.t1 - e.t0) * NUDGE;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -step : step;
      axis.update((s) => scrubTo(s, s.headMs + delta, weatherExtent(s.coverage)));
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      play.click();
      return;
    }
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      live.click();
    }
  });

  play.addEventListener('click', () => {
    axis.update((s) => {
      const e = weatherExtent(s.coverage);
      if (e == null) {
        return s;
      }
      const playing = !s.playing;
      // Starting a sweep is a decision to stop watching now.
      return { ...s, playing, live: playing ? false : s.live, rateX: sweepRateX(e, SWEEP_MS) };
    });
  });

  live.addEventListener('click', () => {
    axis.update((s) => snapLive(s, now(), weatherExtent(s.coverage)));
  });

  const unsubscribe = axis.subscribe(render);
  let lastNowSecond = Math.floor(now() / 1000);
  render();

  return {
    setOutlook(next) {
      days = next;
      render();
    },
    tick(dtMs) {
      const before = axis.state();
      axis.update((s) => advance(s, dtMs, now(), weatherExtent(s.coverage)));
      // The NOW tick creeps even when the head does not, so a paused axis
      // still needs a repaint — but only about once a second, not per frame.
      const second = Math.floor(now() / 1000);
      if (axis.state() === before && second !== lastNowSecond) {
        lastNowSecond = second;
        render();
      }
    },
    destroy() {
      unsubscribe();
      onPointerUp();
      root.replaceChildren();
    },
  };
}

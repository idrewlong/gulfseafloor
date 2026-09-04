import { depthAxisFraction, legendGradientCss } from '../lut.ts';
import { formatElevation, formatLat, formatLon } from './format.ts';
import { isDepthUnit, type DepthUnit } from './units.ts';
import type { Freshness, ReadoutRow } from '../overlay/oceanUi.ts';

/**
 * The chart inspector: one card in the bottom-left corner carrying whatever
 * the reader is currently pointing at.
 *
 * It replaces a floating lat/lon+depth readout that sat unboxed over the
 * terrain, and it folds the buoy and aircraft detail into the same frame
 * instead of overwriting the depth readout in place. The position and depth
 * rows never disappear, so pointing at a station no longer costs the reader
 * the depth under it.
 */

export type ElevationSample = {
  lon: number;
  lat: number;
  elevation: number | null;
};

/** A hovered station or aircraft, rendered under the standing position rows. */
export type DetailBlock = {
  /** Section label: "Station", "Aircraft". */
  kicker: string;
  /** Primary identifier — station id, callsign. */
  title: string;
  /** Station name, or the ICAO24 behind a callsign. */
  subtitle?: string;
  /** Platform class, e.g. "Moored buoy". */
  meta?: string;
  /** Grades the age dot. Omitted for sources that carry no obs age. */
  freshness?: Freshness;
  rows: ReadoutRow[];
};

export type InspectorOptions = {
  root: HTMLElement;
  depthMin: number;
  depthMax: number;
  unit?: DepthUnit;
};

const DASH = '—';

export function mountInspector(opts: InspectorOptions): void {
  const { root, depthMin, depthMax, unit = 'm' } = opts;
  root.classList.add('inspector');
  root.innerHTML = `
    <div class="ins-block">
      <p class="ins-kicker">Position</p>
      <p class="ins-latlon">${DASH}</p>
    </div>
    <div class="ins-block">
      <p class="ins-kicker">Seafloor</p>
      <p class="ins-elev">${DASH}</p>
      <div class="ins-ramp" aria-hidden="true">
        <span class="ins-tick" hidden></span>
      </div>
    </div>
    <div class="ins-detail" hidden>
      <p class="ins-kicker">
        <span class="ins-detail-kicker"></span>
        <span class="ins-age"></span>
      </p>
      <p class="ins-title"></p>
      <p class="ins-sub"></p>
      <dl class="ins-rows"></dl>
    </div>
  `;

  const ramp = root.querySelector<HTMLElement>('.ins-ramp');
  if (!ramp) {
    throw new Error('inspector markup failed to mount');
  }
  // Same ramp the depth legend uses, so the tick reads against a scale the
  // reader has already seen on the right-hand side of the chart.
  ramp.style.background = legendGradientCss(depthMin, depthMax, depthMin, 'to right');
  root.dataset.depthMin = String(depthMin);
  root.dataset.depthMax = String(depthMax);
  root.dataset.depthUnit = unit;
}

/**
 * Swap the readout units in place. The ramp, the tick position and the depth
 * window are all metres-based and unaffected — only the printed number moves.
 */
export function setInspectorUnit(root: HTMLElement, unit: DepthUnit): void {
  root.dataset.depthUnit = unit;
}

function unitOf(root: HTMLElement): DepthUnit {
  const raw = root.dataset.depthUnit;
  return isDepthUnit(raw) ? raw : 'm';
}

/**
 * Where an elevation sits on the depth ramp, as a 0..1 fraction from the
 * deep end. Values outside the legend's range clamp to its ends rather than
 * running the tick off the rail.
 */
export function rampFraction(elevation: number, min: number, max: number): number {
  if (!(max > min)) {
    return 0;
  }
  // Must be the same axis legendGradientCss paints, or the tick points at a
  // colour that is not the one under it.
  return depthAxisFraction(elevation, min, max);
}

export function setPosition(root: HTMLElement, sample: ElevationSample | null): void {
  const latlon = root.querySelector<HTMLElement>('.ins-latlon');
  const elev = root.querySelector<HTMLElement>('.ins-elev');
  const tick = root.querySelector<HTMLElement>('.ins-tick');
  if (!latlon || !elev || !tick) {
    return;
  }

  const ll = sample ? `${formatLat(sample.lat)} ${formatLon(sample.lon)}` : DASH;
  if (latlon.textContent !== ll) {
    latlon.textContent = ll;
  }

  const value =
    sample == null || sample.elevation === null
      ? DASH
      : formatElevation(sample.elevation, unitOf(root));
  if (elev.textContent !== value) {
    elev.textContent = value;
  }

  if (sample == null || sample.elevation === null) {
    tick.hidden = true;
    return;
  }
  const min = Number(root.dataset.depthMin ?? 0);
  const max = Number(root.dataset.depthMax ?? 0);
  tick.hidden = false;
  tick.style.left = `${rampFraction(sample.elevation, min, max) * 100}%`;
}

/** Null clears the block and collapses it; the position rows stay put. */
export function setDetail(root: HTMLElement, detail: DetailBlock | null): void {
  const block = root.querySelector<HTMLElement>('.ins-detail');
  if (!block) {
    return;
  }
  if (detail == null) {
    block.hidden = true;
    return;
  }

  const kicker = block.querySelector<HTMLElement>('.ins-detail-kicker');
  const age = block.querySelector<HTMLElement>('.ins-age');
  const title = block.querySelector<HTMLElement>('.ins-title');
  const sub = block.querySelector<HTMLElement>('.ins-sub');
  const rows = block.querySelector<HTMLElement>('.ins-rows');
  if (!kicker || !age || !title || !sub || !rows) {
    return;
  }

  kicker.textContent = detail.kicker;
  title.textContent = detail.title;

  // The platform class rides with the name so the reader can tell a moored
  // buoy from a pier-mounted station without going back to the glyph.
  const subtitle = [detail.subtitle, detail.meta].filter(Boolean).join(' · ');
  sub.textContent = subtitle;
  sub.hidden = subtitle === '';

  if (detail.freshness) {
    age.dataset.freshness = detail.freshness;
    age.hidden = false;
  } else {
    delete age.dataset.freshness;
    age.hidden = true;
  }

  rows.replaceChildren();
  for (const row of detail.rows) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    dd.textContent = row.value;
    wrap.append(dt, dd);
    rows.append(wrap);
  }

  block.hidden = false;
}

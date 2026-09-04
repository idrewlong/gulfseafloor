import type { VelocityStack } from './currentsField.ts';
import { bracket, isStale } from './currentsTime.ts';
import { msToKnots } from './windBarb.ts';
import { kindLabel, stationKind, type StationKind } from './stationGlyph.ts';

export const BUOY_RANK = 10;

export type LayerAvailability = { currents: boolean; buoys: boolean };

export function availabilityFromHttp(currentsStatus: number, buoysStatus: number): LayerAvailability {
  return {
    currents: currentsStatus === 200,
    buoys: buoysStatus === 200,
  };
}

export function defaultOn(_avail: LayerAvailability): { currents: boolean; buoys: boolean } {
  return { currents: false, buoys: false };
}

/** Same as a missing snapshot. `Response` status 0 is invalid and throws. */
export function unavailableOceanResponse(): Response {
  return new Response(null, { status: 404 });
}

export function formatValidZ(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = d.getUTCMinutes();
  if (mm === 0) {
    return `${hh}Z`;
  }
  return `${hh}:${String(mm).padStart(2, '0')}Z`;
}

export function oceanCaption(currentsIso: string | null, buoysIso: string | null): string {
  const parts: string[] = [];
  if (currentsIso != null) {
    parts.push(`Currents HYCOM ${formatValidZ(currentsIso)}`);
  }
  if (buoysIso != null) {
    parts.push(`Buoys NDBC ${formatValidZ(buoysIso)}`);
  }
  return parts.join(' · ');
}

/**
 * Names the bracketing forecast hours, because the displayed field is model
 * output interpolated to now — not an observation. Shortening this to a bare
 * timestamp would misrepresent the data.
 */
export function currentsCaption(stack: VelocityStack | null, nowMs: number): string {
  if (stack == null || stack.times.length === 0) {
    return '';
  }
  const { i0, i1 } = bracket(stack.times, nowMs);
  const at = formatValidZ(new Date(nowMs).toISOString());
  let caption = `Currents HYCOM ${at}`;
  if (i0 !== i1) {
    const from = formatValidZ(new Date(stack.times[i0]!).toISOString());
    const to = formatValidZ(new Date(stack.times[i1]!).toISOString());
    caption += ` · interpolated ${from}→${to}`;
  } else {
    // bracket() clamps to i0===i1 exactly at either end of the window (now
    // lands on the first or last step). Without this clause the caption
    // would fall back to a bare timestamp, the one moment it would stop
    // reading as model output rather than an observation.
    const hour = formatValidZ(new Date(stack.times[i0]!).toISOString());
    caption += ` · forecast hour ${hour}`;
  }
  if (isStale(stack, nowMs)) {
    caption += ' · stale';
  }
  return caption;
}

/**
 * How long ago a station last reported, relative to nowMs. Null when the
 * station carries no obs time at all.
 */
export function obsAgeMs(obsTime: string | undefined, nowMs: number): number | null {
  if (!obsTime) {
    return null;
  }
  const t = Date.parse(obsTime);
  if (!Number.isFinite(t)) {
    return null;
  }
  // A clock skewed a little the wrong way must not read as a negative age.
  return Math.max(0, nowMs - t);
}

export type Freshness = 'fresh' | 'aging' | 'stale' | 'unknown';

export const AGING_AFTER_MS = 60 * 60 * 1000;
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * NDBC leaves a dead station in the table indefinitely: this AOI has carried
 * stations whose last report was six weeks old, drawn identically to one
 * from twenty minutes ago. Grading the age is what keeps the map from
 * presenting an abandoned instrument as a live observation.
 */
export function freshnessOf(ageMs: number | null): Freshness {
  if (ageMs == null) {
    return 'unknown';
  }
  if (ageMs < AGING_AFTER_MS) {
    return 'fresh';
  }
  if (ageMs < STALE_AFTER_MS) {
    return 'aging';
  }
  return 'stale';
}

/** Coarse, human age: "22 min", "9 h", "41 d". */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null) {
    return 'no obs time';
  }
  // Sub-minute must test the raw age, not the rounded minutes: 30 s rounds
  // up to 1 and would never reach a "< 1 min" branch.
  if (ageMs < 60000) {
    return 'just now';
  }
  const min = Math.round(ageMs / 60000);
  if (min < 60) {
    return `${min} min`;
  }
  const hours = Math.round(min / 60);
  if (hours < 48) {
    return `${hours} h`;
  }
  return `${Math.round(hours / 24)} d`;
}

export type StationLike = {
  id: string;
  name?: string;
  kind?: string;
  lon: number;
  lat: number;
  wdir?: number;
  wspd?: number;
  gst?: number;
  wvht?: number;
  wtmp?: number;
  obsTime?: string;
};

export type ReadoutRow = { label: string; value: string };

/**
 * The station's measurements as label/value rows. The inspector panel and the
 * screen-reader label are built from this one list so the two can never drift
 * into describing the same station differently.
 */
export function stationRows(st: StationLike, nowMs: number): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  if (st.wdir != null && st.wspd != null) {
    rows.push({ label: 'Wind', value: `${Math.round(st.wdir)}\u00b0 / ${msToKnots(st.wspd).toFixed(1)} kt` });
  } else if (st.wspd != null) {
    rows.push({ label: 'Wind', value: `${msToKnots(st.wspd).toFixed(1)} kt` });
  }
  if (st.gst != null) {
    rows.push({ label: 'Gust', value: `${msToKnots(st.gst).toFixed(1)} kt` });
  }
  if (st.wvht != null) {
    rows.push({ label: 'Wave', value: `${st.wvht.toFixed(1)} m` });
  }
  if (st.wtmp != null) {
    rows.push({ label: 'Water', value: `${st.wtmp.toFixed(1)} \u00b0C` });
  }
  const age = obsAgeMs(st.obsTime, nowMs);
  // "no obs time ago" is nonsense, so the null case supplies its own phrase.
  rows.push({ label: 'Observed', value: age == null ? 'no obs time' : `${formatAge(age)} ago` });
  return rows;
}

/** The platform class label for a station payload. */
export function stationKindLabel(st: StationLike): string {
  return kindLabel(stationKind(st.kind));
}

export function stationKindOf(st: StationLike): StationKind {
  return stationKind(st.kind);
}

/**
 * Flat text form, used for the mark's aria-label. Ages are spelled out
 * rather than left as a bare ISO stamp: "8 d ago" is the fact that matters,
 * and it is the one a screen-reader user would otherwise have to compute.
 */
export function buoyReadout(st: StationLike, nowMs: number = Date.now()): string {
  const lines: string[] = [st.id];
  if (st.name) {
    lines.push(st.name);
  }
  lines.push(stationKindLabel(st));
  for (const row of stationRows(st, nowMs)) {
    lines.push(`${row.label} ${row.value}`);
  }
  return lines.join('\n');
}

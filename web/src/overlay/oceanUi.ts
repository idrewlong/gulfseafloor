import type { VelocityStack } from './currentsField.ts';
import { bracket, isStale } from './currentsTime.ts';
import { msToKnots } from './windBarb.ts';

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

export function buoyReadout(st: {
  id: string;
  name?: string;
  lon: number;
  lat: number;
  wdir?: number;
  wspd?: number;
  gst?: number;
  wvht?: number;
  wtmp?: number;
  obsTime?: string;
}): string {
  const lines: string[] = [st.id];
  if (st.name) {
    lines.push(st.name);
  }
  if (st.wdir != null && st.wspd != null) {
    lines.push(`${st.wdir}° / ${msToKnots(st.wspd).toFixed(1)} kt`);
  }
  if (st.gst != null) {
    lines.push(`Gust ${msToKnots(st.gst).toFixed(1)} kt`);
  }
  if (st.wvht != null) {
    lines.push(`Wave ${st.wvht.toFixed(1)} m`);
  }
  if (st.wtmp != null) {
    lines.push(`Water ${st.wtmp.toFixed(1)} °C`);
  }
  if (st.obsTime) {
    lines.push(st.obsTime);
  }
  return lines.join('\n');
}

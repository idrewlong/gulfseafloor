/**
 * The chart's shareable address.
 *
 * Everything a reader can change — where the camera is, what time the chart
 * is showing, which layers are drawn, and how the terrain is shaded — is
 * mirrored into the URL hash, so a view can be sent to someone else or
 * bookmarked and come back the same. Without it the only way to describe a
 * view was prose, and a screenshot could not be reproduced.
 *
 * Pure: no DOM, no three.js. main.ts owns the reading and writing; this file
 * owns the format and, more importantly, the validation. Every value coming
 * out of a URL is attacker-supplied and is range-checked before it reaches
 * the camera or a shader uniform.
 */
import { CAMERA_MAX_POLAR, CAMERA_MIN_POLAR } from './viewerConfig.ts';
import { isDepthUnit, type DepthUnit } from './ui/units.ts';

/** Bumped only if the format changes incompatibly; an unknown version is ignored. */
export const VIEW_STATE_VERSION = 1;

export type LayerName = 'currents' | 'buoys' | 'aircraft';

export const LAYER_NAMES: readonly LayerName[] = ['currents', 'buoys', 'aircraft'];

export type ViewState = {
  /** Look-at position, degrees. */
  lon: number;
  lat: number;
  /** Camera distance from the look-at, metres. */
  dist: number;
  /** Tilt from straight down, degrees. */
  polar: number;
  layers: Record<LayerName, boolean>;
  exaggeration: number;
  contourInterval: number;
  sunAzimuth: number;
  sunAltitude: number;
  units: DepthUnit;
};

const CONTOUR_CHOICES = [0, 10, 50, 100];

function num(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Trim a float to `places`, dropping a trailing ".0" — URLs stay readable. */
function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Render a state as a hash fragment, leading '#' included.
 *
 * Only the camera, time and layers are always written. The shading dials are
 * written whenever they differ from the passed defaults, so a plain view
 * produces a short, legible URL rather than a wall of parameters.
 */
export function encodeViewState(
  state: ViewState,
  defaults?: Partial<Pick<
    ViewState,
    'exaggeration' | 'contourInterval' | 'sunAzimuth' | 'sunAltitude' | 'units'
  >>,
): string {
  const q = new URLSearchParams();
  q.set('v', String(VIEW_STATE_VERSION));
  q.set('c', [
    round(state.lon, 5),
    round(state.lat, 5),
    Math.round(state.dist),
    round(state.polar, 1),
  ].join(','));
  // Layers are listed by name rather than as a bitmask so the URL stays
  // readable and a layer added later cannot silently shift the others.
  q.set('l', LAYER_NAMES.filter((n) => state.layers[n]).join(',') || '-');

  const d = defaults ?? {};
  if (d.exaggeration !== state.exaggeration) {
    q.set('x', String(state.exaggeration));
  }
  if (d.contourInterval !== state.contourInterval) {
    q.set('ci', String(state.contourInterval));
  }
  if (d.sunAzimuth !== state.sunAzimuth || d.sunAltitude !== state.sunAltitude) {
    q.set('s', `${Math.round(state.sunAzimuth)},${Math.round(state.sunAltitude)}`);
  }
  if (d.units !== state.units) {
    q.set('u', state.units);
  }
  // URLSearchParams percent-encodes ',' as %2C, which turns a legible
  // "c=-88.91,30.29,64000" into "c=-88.91%2C30.29%2C64000". A comma is a
  // sub-delimiter and legal unescaped in a fragment (RFC 3986 §3.5), and
  // URLSearchParams parses a literal comma back as an ordinary character, so
  // putting it back costs nothing and the link stays readable to a human.
  return `#${q.toString().replaceAll('%2C', ',')}`;
}

/**
 * Read whatever a hash validly supplies. Absent, malformed and out-of-range
 * values are dropped individually — a URL that has been truncated in a chat
 * client still restores the parts that survived, rather than being discarded
 * whole or, worse, driving the camera somewhere impossible.
 */
export function decodeViewState(hash: string): Partial<ViewState> {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') {
    return {};
  }
  const q = new URLSearchParams(raw);
  const version = num(q.get('v'));
  if (version !== VIEW_STATE_VERSION) {
    return {};
  }
  const out: Partial<ViewState> = {};

  const c = (q.get('c') ?? '').split(',');
  if (c.length === 4) {
    const lon = num(c[0] ?? null);
    const lat = num(c[1] ?? null);
    const dist = num(c[2] ?? null);
    const polar = num(c[3] ?? null);
    // Longitude and latitude are checked against the whole globe rather than
    // the AOI: main.ts clamps to the chart's own footprint, and duplicating
    // the AOI here would mean two places to update when it moves.
    if (lon != null && lat != null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
      out.lon = lon;
      out.lat = lat;
    }
    if (dist != null && dist > 0 && Number.isFinite(dist)) {
      out.dist = dist;
    }
    if (polar != null) {
      const lo = (CAMERA_MIN_POLAR * 180) / Math.PI;
      const hi = (CAMERA_MAX_POLAR * 180) / Math.PI;
      out.polar = clamp(polar, lo, hi);
    }
  }

  const l = q.get('l');
  if (l != null) {
    const on = new Set(l.split(',').filter((s) => s !== ''));
    const layers: Record<LayerName, boolean> = {
      currents: false,
      buoys: false,
      aircraft: false,
    };
    for (const name of LAYER_NAMES) {
      layers[name] = on.has(name);
    }
    out.layers = layers;
  }

  const x = num(q.get('x'));
  if (x != null) {
    out.exaggeration = Math.round(clamp(x, 1, 50));
  }

  const ci = num(q.get('ci'));
  if (ci != null && CONTOUR_CHOICES.includes(ci)) {
    out.contourInterval = ci;
  }

  const s = (q.get('s') ?? '').split(',');
  if (s.length === 2) {
    const az = num(s[0] ?? null);
    const alt = num(s[1] ?? null);
    if (az != null) {
      // Wrap rather than clamp: azimuth is a compass bearing, so 370 is 10.
      out.sunAzimuth = ((Math.round(az) % 360) + 360) % 360;
    }
    if (alt != null) {
      out.sunAltitude = Math.round(clamp(alt, 5, 85));
    }
  }

  const u = q.get('u');
  if (isDepthUnit(u)) {
    out.units = u;
  }

  return out;
}

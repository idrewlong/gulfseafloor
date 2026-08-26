import { formatValidZ } from './oceanUi.ts';
import { msToKnots } from './windBarb.ts';

export const AIRCRAFT_RANK = 20;

export type Aircraft = {
  icao24: string;
  callsign?: string;
  lon: number;
  lat: number;
  altBaroM?: number;
  trackDeg?: number;
  gsMps?: number;
  onGround?: boolean;
};

export type AircraftSnapshot = {
  source: 'opensky' | 'adsb.lol';
  fetchedAt: string;
  aircraft: Aircraft[];
};

export const AIRCRAFT_POLL_MS = 10_000;
export const AIRCRAFT_REPROBE_MS = 60_000;
export const AIRCRAFT_MAX_DEAD_RECKON_SEC = 20;

export function aircraftAvailable(status: number): boolean {
  return status === 200;
}

export function aircraftChromeHidden(mode: 'globe' | 'bathymetry'): boolean {
  return mode === 'globe';
}

export function shouldPollAircraft(opts: {
  mode: 'globe' | 'bathymetry';
  layerOn: boolean;
  documentHidden: boolean;
  available: boolean;
}): boolean {
  return opts.mode === 'bathymetry' && opts.layerOn && !opts.documentHidden && opts.available;
}

export function shouldReprobeAircraft(opts: {
  mode: 'globe' | 'bathymetry';
  documentHidden: boolean;
  available: boolean;
  primed: boolean;
}): boolean {
  return opts.primed && !opts.available && opts.mode === 'bathymetry' && !opts.documentHidden;
}

export function aircraftPollIntervalMs(available: boolean): number {
  return available ? AIRCRAFT_POLL_MS : AIRCRAFT_REPROBE_MS;
}

export function aircraftCaption(source: string | null, fetchedAt: string | null): string {
  if (source == null || fetchedAt == null) {
    return '';
  }
  const sourceName = source === 'opensky' ? 'OpenSky' : source;
  const compactTime = formatValidZ(fetchedAt);
  const time = compactTime.replace(/^(\d{2})Z$/, '$1:00Z');
  return `Aircraft ${sourceName} ${time}`;
}

export function aircraftReadout(a: Aircraft): string {
  const lines = [a.callsign || a.icao24];
  if (a.callsign) {
    lines.push(a.icao24);
  }
  if (a.altBaroM != null) {
    lines.push(`${Math.round(a.altBaroM)} m`);
  }
  if (a.trackDeg != null) {
    lines.push(`${Math.round(a.trackDeg)}°`);
  }
  if (a.gsMps != null) {
    lines.push(`${msToKnots(a.gsMps).toFixed(1)} kt`);
  }
  return lines.join('\n');
}

export function deadReckon(a: Aircraft, dtSec: number): { lon: number; lat: number } {
  if (
    a.onGround !== false ||
    a.trackDeg == null ||
    a.gsMps == null ||
    dtSec === 0
  ) {
    return { lon: a.lon, lat: a.lat };
  }

  const dt = Math.min(Math.max(dtSec, 0), AIRCRAFT_MAX_DEAD_RECKON_SEC);
  const trackRad = (a.trackDeg * Math.PI) / 180;
  const eastM = a.gsMps * Math.sin(trackRad) * dt;
  const northM = a.gsMps * Math.cos(trackRad) * dt;
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((a.lat * Math.PI) / 180);
  return {
    lon: a.lon + eastM / mPerDegLon,
    lat: a.lat + northM / mPerDegLat,
  };
}

import { bboxContains, type BBox } from '../geo.ts';
import {
  MIN_LABEL_PX,
  visibleLabelIds,
  type LabelCandidate,
} from '../ui/labelLayout.ts';
import {
  AIRCRAFT_RANK,
  type Aircraft,
  type AircraftSnapshot,
} from './aircraftUi.ts';

export const AIRCRAFT_ID_BASE = 2000;

export type AircraftProjectFn = (
  lon: number,
  lat: number,
  elev: number,
) => { x: number; y: number } | null;

function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function parseAircraftJson(raw: unknown): AircraftSnapshot | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const snapshot = raw as { source?: unknown; fetchedAt?: unknown; aircraft?: unknown };
  if (
    (snapshot.source !== 'opensky' && snapshot.source !== 'adsb.lol') ||
    typeof snapshot.fetchedAt !== 'string' ||
    snapshot.fetchedAt === '' ||
    !Array.isArray(snapshot.aircraft)
  ) {
    return null;
  }

  const aircraft: Aircraft[] = [];
  for (const rawRow of snapshot.aircraft) {
    if (rawRow == null || typeof rawRow !== 'object') {
      continue;
    }
    const row = rawRow as Record<string, unknown>;
    if (
      typeof row.icao24 !== 'string' ||
      row.icao24 === '' ||
      typeof row.lon !== 'number' ||
      !Number.isFinite(row.lon) ||
      typeof row.lat !== 'number' ||
      !Number.isFinite(row.lat)
    ) {
      continue;
    }

    const parsed: Aircraft = { icao24: row.icao24, lon: row.lon, lat: row.lat };
    const callsign = optionalString(row.callsign);
    if (callsign != null) {
      parsed.callsign = callsign;
    }
    const altBaroM = optionalFinite(row.altBaroM);
    if (altBaroM != null) {
      parsed.altBaroM = altBaroM;
    }
    const trackDeg = optionalFinite(row.trackDeg);
    if (trackDeg != null) {
      parsed.trackDeg = trackDeg;
    }
    const gsMps = optionalFinite(row.gsMps);
    if (gsMps != null) {
      parsed.gsMps = gsMps;
    }
    if (typeof row.onGround === 'boolean') {
      parsed.onGround = row.onGround;
    }
    aircraft.push(parsed);
  }

  return {
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    aircraft,
  };
}

export function layoutAircraftVisibility(
  extra: LabelCandidate[],
  rows: readonly Aircraft[],
  project: AircraftProjectFn,
  width: number,
  height: number,
  aoi?: BBox,
): {
  visible: Set<number>;
  candidates: LabelCandidate[];
  positions: Array<{ x: number; y: number } | null>;
} {
  const candidates = [...extra];
  const positions: Array<{ x: number; y: number } | null> = [];

  for (let i = 0; i < rows.length; i++) {
    const aircraft = rows[i];
    if (!aircraft || (aoi && !bboxContains(aoi, aircraft.lon, aircraft.lat))) {
      positions.push(null);
      continue;
    }
    const position = project(aircraft.lon, aircraft.lat, aircraft.altBaroM ?? 0);
    const onScreen =
      position !== null &&
      position.x > 8 &&
      position.x < width - 8 &&
      position.y > 8 &&
      position.y < height - 8;
    if (!onScreen || position == null) {
      positions.push(null);
      continue;
    }
    positions.push(position);
    candidates.push({
      id: AIRCRAFT_ID_BASE + i,
      x: position.x,
      y: position.y,
      rank: AIRCRAFT_RANK,
    });
  }

  return {
    visible: visibleLabelIds(candidates, MIN_LABEL_PX),
    candidates,
    positions,
  };
}

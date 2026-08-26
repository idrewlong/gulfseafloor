import { bboxContains, type BBox } from '../geo.ts';
import { setAircraftReadout } from '../ui/controls.ts';
import {
  MIN_LABEL_PX,
  visibleLabelIds,
  type LabelCandidate,
} from '../ui/labelLayout.ts';
import {
  AIRCRAFT_RANK,
  aircraftReadout,
  type Aircraft,
  type AircraftSnapshot,
} from './aircraftUi.ts';

export const AIRCRAFT_ID_BASE = 2000;

export type AircraftProjectFn = (
  lon: number,
  lat: number,
  elev: number,
) => { x: number; y: number } | null;

export type AircraftHandle = {
  layout(
    project: AircraftProjectFn,
    width: number,
    height: number,
    extraCandidates: LabelCandidate[],
  ): void;
  setEnabled(on: boolean): void;
  setAircraft(rows: Aircraft[]): void;
  candidates(project: AircraftProjectFn, width: number, height: number): LabelCandidate[];
};

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
    const position = project(aircraft.lon, aircraft.lat, 0);
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

type EngagedAircraftMark = {
  aircraft: Aircraft;
  matches: (selector: string) => boolean;
};

function usesSquare(aircraft: Aircraft): boolean {
  return aircraft.trackDeg == null;
}

function syncAircraftReadout(marks: readonly EngagedAircraftMark[]): void {
  const el = document.getElementById('readout');
  if (!el) {
    return;
  }
  let focused: Aircraft | null = null;
  let hovered: Aircraft | null = null;
  for (const mark of marks) {
    if (mark.matches(':hover')) {
      hovered = mark.aircraft;
      break;
    }
    if (focused == null && mark.matches(':focus')) {
      focused = mark.aircraft;
    }
  }
  const engaged = hovered ?? focused;
  setAircraftReadout(el, engaged ? aircraftReadout(engaged) : null);
}

function applyMarkContent(btn: HTMLButtonElement, aircraft: Aircraft): void {
  btn.dataset.icao24 = aircraft.icao24;
  btn.classList.toggle('is-square', usesSquare(aircraft));
  btn.setAttribute('aria-label', aircraftReadout(aircraft));
  const glyph = btn.querySelector<HTMLElement>('.aircraft-glyph');
  if (glyph) {
    glyph.style.transform =
      aircraft.trackDeg != null ? `rotate(${aircraft.trackDeg}deg)` : '';
  }
  const label = btn.querySelector('.aircraft-id');
  if (label) {
    label.textContent = aircraft.callsign || aircraft.icao24;
  }
}

function makeMark(aircraft: Aircraft): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'aircraft-mark';
  const glyph = document.createElement('span');
  glyph.className = 'aircraft-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  const id = document.createElement('span');
  id.className = 'aircraft-id';
  btn.append(glyph, id);
  applyMarkContent(btn, aircraft);
  btn.hidden = true;
  return btn;
}

export function mountAircraft(root: HTMLElement, aoi?: BBox): AircraftHandle {
  let rows: Aircraft[] = [];
  let buttons: HTMLButtonElement[] = [];
  let enabled = true;

  const marks = (): EngagedAircraftMark[] =>
    buttons.flatMap((btn, i) => {
      const aircraft = rows[i];
      return aircraft ? [{ aircraft, matches: (selector: string) => btn.matches(selector) }] : [];
    });

  const sync = (): void => {
    syncAircraftReadout(marks());
  };

  const bind = (btn: HTMLButtonElement): void => {
    btn.addEventListener('pointerenter', sync);
    btn.addEventListener('focus', sync);
    btn.addEventListener('pointerleave', sync);
    btn.addEventListener('blur', sync);
  };

  const rebuild = (next: Aircraft[]): void => {
    root.replaceChildren();
    rows = next;
    buttons = next.map((aircraft) => {
      const btn = makeMark(aircraft);
      bind(btn);
      root.append(btn);
      return btn;
    });
  };

  const sameIdentity = (next: Aircraft[]): boolean =>
    next.length === rows.length && next.every((aircraft, i) => aircraft.icao24 === rows[i]?.icao24);

  rebuild([]);

  return {
    layout(project, width, height, extraCandidates) {
      const { visible, positions } = layoutAircraftVisibility(
        extraCandidates,
        rows,
        project,
        width,
        height,
        aoi,
      );
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const pos = positions[i];
        if (!btn) {
          continue;
        }
        const on = enabled && pos !== null && visible.has(AIRCRAFT_ID_BASE + i);
        btn.hidden = !on;
        if (on && pos) {
          btn.style.left = `${pos.x}px`;
          btn.style.top = `${pos.y}px`;
        }
      }
    },
    candidates(project, width, height) {
      return layoutAircraftVisibility([], rows, project, width, height, aoi).candidates;
    },
    setEnabled(on) {
      enabled = on;
      root.hidden = !on;
      if (!on) {
        for (const btn of buttons) {
          btn.hidden = true;
        }
        const el = document.getElementById('readout');
        if (el) {
          setAircraftReadout(el, null);
        }
      }
    },
    setAircraft(next) {
      if (sameIdentity(next)) {
        const metaChanged = next.some((aircraft, i) => {
          const prev = rows[i];
          return (
            prev == null ||
            prev.callsign !== aircraft.callsign ||
            prev.trackDeg !== aircraft.trackDeg ||
            prev.altBaroM !== aircraft.altBaroM ||
            prev.gsMps !== aircraft.gsMps ||
            prev.onGround !== aircraft.onGround
          );
        });
        rows = next;
        if (metaChanged) {
          for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const aircraft = next[i];
            if (btn && aircraft) {
              applyMarkContent(btn, aircraft);
            }
          }
        }
        return;
      }
      rebuild(next);
    },
  };
}

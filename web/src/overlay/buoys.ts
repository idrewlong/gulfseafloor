import { bboxContains, type BBox } from '../geo.ts';
import { type LabelCandidate } from '../ui/labelLayout.ts';
import { setBuoyReadout } from '../ui/controls.ts';
import { barbSvg } from './windBarb.ts';
import { BUOY_RANK, buoyReadout } from './oceanUi.ts';

export const BUOY_ID_BASE = 1000;

export type BuoyStation = {
  id: string;
  name?: string;
  lon: number;
  lat: number;
  obsTime?: string;
  wdir?: number;
  wspd?: number;
  gst?: number;
  wvht?: number;
  wtmp?: number;
};

export type ProjectFn = (
  lon: number,
  lat: number,
  elev: number,
) => { x: number; y: number } | null;

export type BuoysHandle = {
  layout(project: ProjectFn, width: number, height: number, placeCandidates: LabelCandidate[]): void;
  setEnabled(on: boolean): void;
  candidates(project: ProjectFn, width: number, height: number): LabelCandidate[];
};

function optionalFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function parseBuoysJson(raw: unknown): { validTime: string; stations: BuoyStation[] } | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const o = raw as { validTime?: unknown; stations?: unknown };
  if (typeof o.validTime !== 'string' || o.validTime === '' || !Array.isArray(o.stations)) {
    return null;
  }
  const stations: BuoyStation[] = [];
  for (const row of o.stations) {
    if (row == null || typeof row !== 'object') {
      continue;
    }
    const s = row as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id === '') {
      continue;
    }
    if (typeof s.lon !== 'number' || typeof s.lat !== 'number' || !Number.isFinite(s.lon) || !Number.isFinite(s.lat)) {
      continue;
    }
    const st: BuoyStation = { id: s.id, lon: s.lon, lat: s.lat };
    const name = optionalString(s.name);
    if (name) {
      st.name = name;
    }
    const obsTime = optionalString(s.obsTime);
    if (obsTime) {
      st.obsTime = obsTime;
    }
    const wdir = optionalFinite(s.wdir);
    if (wdir != null) {
      st.wdir = wdir;
    }
    const wspd = optionalFinite(s.wspd);
    if (wspd != null) {
      st.wspd = wspd;
    }
    const gst = optionalFinite(s.gst);
    if (gst != null) {
      st.gst = gst;
    }
    const wvht = optionalFinite(s.wvht);
    if (wvht != null) {
      st.wvht = wvht;
    }
    const wtmp = optionalFinite(s.wtmp);
    if (wtmp != null) {
      st.wtmp = wtmp;
    }
    stations.push(st);
  }
  return { validTime: o.validTime, stations };
}

/** Stations whose lon/lat lie on the chart clip. Off-AOI glyphs sit in empty space. */
export function stationsOnChart(stations: readonly BuoyStation[], aoi: BBox): BuoyStation[] {
  return stations.filter((s) => bboxContains(aoi, s.lon, s.lat));
}

export function layoutBuoyVisibility(
  _placeCandidates: LabelCandidate[],
  stations: readonly BuoyStation[],
  project: ProjectFn,
  width: number,
  height: number,
  aoi?: BBox,
): {
  visible: Set<number>;
  candidates: LabelCandidate[];
  positions: Array<{ x: number; y: number } | null>;
} {
  const candidates: LabelCandidate[] = [];
  const positions: Array<{ x: number; y: number } | null> = [];
  const visible = new Set<number>();
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    if (!st) {
      positions.push(null);
      continue;
    }
    if (aoi && !bboxContains(aoi, st.lon, st.lat)) {
      positions.push(null);
      continue;
    }
    const pos = project(st.lon, st.lat, 0);
    const on =
      pos !== null && pos.x > 8 && pos.x < width - 8 && pos.y > 8 && pos.y < height - 8;
    if (on && pos) {
      positions.push(pos);
      candidates.push({ id: BUOY_ID_BASE + i, x: pos.x, y: pos.y, rank: BUOY_RANK });
      visible.add(BUOY_ID_BASE + i);
    } else {
      positions.push(null);
    }
  }
  return { visible, candidates, positions };
}

/** Buoy readout wins while the mark is hovered or focused. */
export function buoyMarkEngaged(btn: Pick<Element, 'matches'>): boolean {
  return btn.matches(':hover') || btn.matches(':focus');
}

export type EngagedBuoyMark = {
  station: BuoyStation;
  matches: (selector: string) => boolean;
};

/** Hover wins over leftover focus. Null only when no mark is hovered or focused. */
export function engagedBuoyStation(marks: readonly EngagedBuoyMark[]): BuoyStation | null {
  let focused: BuoyStation | null = null;
  for (const mark of marks) {
    if (mark.matches(':hover')) {
      return mark.station;
    }
    if (focused == null && mark.matches(':focus')) {
      focused = mark.station;
    }
  }
  return focused;
}

function syncBuoyReadout(marks: readonly EngagedBuoyMark[]): void {
  const el = document.getElementById('readout');
  if (!el) {
    return;
  }
  const station = engagedBuoyStation(marks);
  setBuoyReadout(el, station ? buoyReadout(station) : null);
}

function makeMark(station: BuoyStation): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'buoy-mark';
  btn.setAttribute('aria-label', buoyReadout(station));
  if (station.wdir != null && station.wspd != null) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('buoy-barb');
    svg.innerHTML = barbSvg(station.wdir, station.wspd);
    btn.append(svg);
  }
  const id = document.createElement('span');
  id.className = 'buoy-id';
  id.textContent = station.id;
  btn.append(id);
  btn.hidden = true;
  return btn;
}

export function mountBuoys(root: HTMLElement, stations: BuoyStation[], aoi?: BBox): BuoysHandle {
  root.replaceChildren();
  const buttons = stations.map((st) => {
    const btn = makeMark(st);
    root.append(btn);
    return btn;
  });

  const marks = (): EngagedBuoyMark[] =>
    buttons.flatMap((btn, i) => {
      const station = stations[i];
      return station ? [{ station, matches: (selector: string) => btn.matches(selector) }] : [];
    });

  const sync = (): void => {
    syncBuoyReadout(marks());
  };
  for (const btn of buttons) {
    btn.addEventListener('pointerenter', sync);
    btn.addEventListener('focus', sync);
    btn.addEventListener('pointerleave', sync);
    btn.addEventListener('blur', sync);
  }

  let enabled = true;

  const apply = (
    project: ProjectFn,
    width: number,
    height: number,
    placeCandidates: LabelCandidate[],
  ): void => {
    const { visible, positions } = layoutBuoyVisibility(
      placeCandidates,
      stations,
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
      const on = enabled && pos !== null && visible.has(BUOY_ID_BASE + i);
      btn.hidden = !on;
      if (on && pos) {
        btn.style.left = `${pos.x}px`;
        btn.style.top = `${pos.y}px`;
      }
    }
  };

  return {
    layout: apply,
    candidates(project, width, height) {
      return layoutBuoyVisibility([], stations, project, width, height, aoi).candidates;
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
          setBuoyReadout(el, null);
        }
      }
    },
  };
}

import { type BBox } from '../geo.ts';
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

const SVG_NS = 'http://www.w3.org/2000/svg';

export const AIRCRAFT_ID_BASE = 2000;

/**
 * Degrees of slack around the chart before a mark is dropped. Dead reckoning
 * walks a position between polls, so a track leaving across the edge would
 * otherwise blink out a frame before it left the screen.
 */
export const AIRCRAFT_EDGE_PAD_DEG = 0.15;

/** A leader shorter than this is a top-down view, not an altitude — draw no line. */
const MIN_LEADER_PX = 3;

export type AircraftPlacement = {
  /** The aircraft itself, lifted to its barometric altitude. */
  air: { x: number; y: number } | null;
  /** Sea level directly beneath it — the foot of the altitude leader. */
  ground: { x: number; y: number } | null;
};

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
  /** Pixel size of the leader SVG. Must track the canvas. */
  resize(width: number, height: number): void;
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
    snapshot.fetchedAt === ''
  ) {
    return null;
  }
  const rawAircraft = snapshot.aircraft == null ? [] : snapshot.aircraft;
  if (!Array.isArray(rawAircraft)) {
    return null;
  }

  const aircraft: Aircraft[] = [];
  for (const rawRow of rawAircraft) {
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

function nearChart(aoi: BBox | undefined, lon: number, lat: number): boolean {
  if (!aoi) {
    return true;
  }
  return (
    lon >= aoi.west - AIRCRAFT_EDGE_PAD_DEG &&
    lon <= aoi.east + AIRCRAFT_EDGE_PAD_DEG &&
    lat >= aoi.south - AIRCRAFT_EDGE_PAD_DEG &&
    lat <= aoi.north + AIRCRAFT_EDGE_PAD_DEG
  );
}

/**
 * Place every aircraft the view can see, then declutter the callsigns only.
 *
 * Occupancy decides which *labels* are legible, never which aircraft exist: a
 * plane suppressed by a nearby place name used to vanish from the chart
 * altogether, which emptied the layer at the zooms where the whole Bight is in
 * frame and every mark has a neighbour inside the 56 px radius.
 */
export function layoutAircraftVisibility(
  extra: LabelCandidate[],
  rows: readonly Aircraft[],
  project: AircraftProjectFn,
  width: number,
  height: number,
  aoi?: BBox,
): {
  labelled: Set<number>;
  candidates: LabelCandidate[];
  placements: AircraftPlacement[];
} {
  const candidates = [...extra];
  const placements: AircraftPlacement[] = [];

  for (let i = 0; i < rows.length; i++) {
    const aircraft = rows[i];
    if (!aircraft || !nearChart(aoi, aircraft.lon, aircraft.lat)) {
      placements.push({ air: null, ground: null });
      continue;
    }
    // Aircraft ride true altitude, so the projection is handed metres above
    // sea level. Vertical exaggeration bends the seafloor, not the sky.
    const air = project(aircraft.lon, aircraft.lat, aircraft.altBaroM ?? 0);
    const onScreen =
      air !== null &&
      air.x > 8 &&
      air.x < width - 8 &&
      air.y > 8 &&
      air.y < height - 8;
    if (!onScreen || air == null) {
      placements.push({ air: null, ground: null });
      continue;
    }
    placements.push({ air, ground: project(aircraft.lon, aircraft.lat, 0) });
    candidates.push({
      id: AIRCRAFT_ID_BASE + i,
      x: air.x,
      y: air.y,
      rank: AIRCRAFT_RANK,
    });
  }

  return {
    labelled: visibleLabelIds(candidates, MIN_LABEL_PX),
    candidates,
    placements,
  };
}

type EngagedAircraftMark = {
  aircraft: Aircraft;
  matches: (selector: string) => boolean;
};

/**
 * Top-down airliner planform, nose up the +Y axis so a plain rotate() by the
 * ADS-B track puts the nose on the reported bearing. Deliberately stubby: the
 * mark is ~18 px on the chart, and a true-scale wing goes to wisps down there.
 */
const PLANE_PATH =
  'M12 1.6 14 5.6 14 9.6 22.4 14.4 22.4 16.9 14 14.2 14 18.2 17.8 20.8 17.8 22.6 ' +
  '12 21 6.2 22.6 6.2 20.8 10 18.2 10 14.2 1.6 16.9 1.6 14.4 10 9.6 10 5.6Z';

/** No track — a plane silhouette would assert a heading the feed never sent. */
function usesDot(aircraft: Aircraft): boolean {
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

export function planAircraftMarkReuse(
  existingIcaos: readonly string[],
  nextIcaos: readonly string[],
): { reuse: string[]; create: string[]; remove: string[] } {
  const existing = new Set(existingIcaos);
  const next = new Set(nextIcaos);
  return {
    reuse: nextIcaos.filter((id) => existing.has(id)),
    create: nextIcaos.filter((id) => !existing.has(id)),
    remove: existingIcaos.filter((id) => !next.has(id)),
  };
}

function applyMarkContent(btn: HTMLButtonElement, aircraft: Aircraft): void {
  btn.dataset.icao24 = aircraft.icao24;
  btn.classList.toggle('is-trackless', usesDot(aircraft));
  btn.setAttribute('aria-label', aircraftReadout(aircraft));
  const glyph = btn.querySelector<SVGElement>('.aircraft-glyph');
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

  const glyph = document.createElementNS(SVG_NS, 'svg');
  glyph.setAttribute('class', 'aircraft-glyph');
  glyph.setAttribute('viewBox', '0 0 24 24');
  glyph.setAttribute('aria-hidden', 'true');
  const plane = document.createElementNS(SVG_NS, 'path');
  plane.setAttribute('class', 'aircraft-plane');
  plane.setAttribute('d', PLANE_PATH);
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'aircraft-dot');
  dot.setAttribute('cx', '12');
  dot.setAttribute('cy', '12');
  dot.setAttribute('r', '4.5');
  glyph.append(plane, dot);

  const id = document.createElement('span');
  id.className = 'aircraft-id';
  btn.append(glyph, id);
  applyMarkContent(btn, aircraft);
  btn.hidden = true;
  return btn;
}

/** A ring at sea level under the aircraft, so a tilted view still reads position. */
function makeFootMarker(): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, 'defs');
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'aircraft-foot');
  marker.setAttribute('viewBox', '0 0 6 6');
  marker.setAttribute('refX', '3');
  marker.setAttribute('refY', '3');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('markerUnits', 'userSpaceOnUse');
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('class', 'aircraft-foot');
  ring.setAttribute('cx', '3');
  ring.setAttribute('cy', '3');
  ring.setAttribute('r', '2');
  marker.append(ring);
  defs.append(marker);
  return defs;
}

function makeLeader(): SVGLineElement {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'aircraft-leader');
  // x2/y2 is the sea-level end, so the ring lands on the water, not the plane.
  line.setAttribute('marker-end', 'url(#aircraft-foot)');
  return line;
}

export function mountAircraft(root: HTMLElement, aoi?: BBox): AircraftHandle {
  let rows: Aircraft[] = [];
  let buttons: HTMLButtonElement[] = [];
  let leaders: SVGLineElement[] = [];
  let enabled = true;

  // One SVG for every altitude leader. It sits under the marks so a line never
  // crosses a glyph, and it is inert to the pointer so the buttons stay hittable.
  const leaderLayer = document.createElementNS(SVG_NS, 'svg');
  leaderLayer.setAttribute('class', 'aircraft-leaders');
  leaderLayer.setAttribute('aria-hidden', 'true');
  leaderLayer.setAttribute('preserveAspectRatio', 'none');
  const footDefs = makeFootMarker();

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

  const reconcile = (next: Aircraft[]): void => {
    const plan = planAircraftMarkReuse(
      buttons.map((btn) => btn.dataset.icao24 ?? ''),
      next.map((aircraft) => aircraft.icao24),
    );
    const prevByIcao = new Map(
      buttons.map((btn, i) => [btn.dataset.icao24 ?? '', { btn, leader: leaders[i] }] as const),
    );
    const nextButtons: HTMLButtonElement[] = [];
    const nextLeaders: SVGLineElement[] = [];
    for (const aircraft of next) {
      const existing = prevByIcao.get(aircraft.icao24);
      if (existing && plan.reuse.includes(aircraft.icao24)) {
        applyMarkContent(existing.btn, aircraft);
        nextButtons.push(existing.btn);
        nextLeaders.push(existing.leader ?? makeLeader());
      } else {
        const btn = makeMark(aircraft);
        bind(btn);
        nextButtons.push(btn);
        nextLeaders.push(makeLeader());
      }
    }
    for (const id of plan.remove) {
      prevByIcao.get(id)?.btn.remove();
      prevByIcao.get(id)?.leader?.remove();
    }
    leaderLayer.replaceChildren(footDefs, ...nextLeaders);
    root.replaceChildren(leaderLayer, ...nextButtons);
    rows = next;
    buttons = nextButtons;
    leaders = nextLeaders;
  };

  const sameIdentity = (next: Aircraft[]): boolean =>
    next.length === rows.length && next.every((aircraft, i) => aircraft.icao24 === rows[i]?.icao24);

  const hideLeader = (leader: SVGLineElement | undefined): void => {
    leader?.setAttribute('visibility', 'hidden');
  };

  reconcile([]);

  return {
    resize(width, height) {
      leaderLayer.setAttribute('viewBox', `0 0 ${Math.max(1, width)} ${Math.max(1, height)}`);
    },
    layout(project, width, height, extraCandidates) {
      const { labelled, placements } = layoutAircraftVisibility(
        extraCandidates,
        rows,
        project,
        width,
        height,
        aoi,
      );
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const leader = leaders[i];
        const placement = placements[i];
        if (!btn) {
          continue;
        }
        const air = placement?.air ?? null;
        const on = enabled && air !== null;
        btn.hidden = !on;
        if (!on || !air) {
          hideLeader(leader);
          continue;
        }
        btn.style.left = `${air.x}px`;
        btn.style.top = `${air.y}px`;
        // The callsign is what crowds; the mark itself always stands.
        btn.classList.toggle('is-labelled', labelled.has(AIRCRAFT_ID_BASE + i));

        const ground = placement?.ground ?? null;
        if (!leader || !ground || Math.hypot(ground.x - air.x, ground.y - air.y) < MIN_LEADER_PX) {
          hideLeader(leader);
          continue;
        }
        leader.setAttribute('x1', `${air.x}`);
        leader.setAttribute('y1', `${air.y}`);
        leader.setAttribute('x2', `${ground.x}`);
        leader.setAttribute('y2', `${ground.y}`);
        leader.removeAttribute('visibility');
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
        for (const leader of leaders) {
          hideLeader(leader);
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
      reconcile(next);
    },
  };
}

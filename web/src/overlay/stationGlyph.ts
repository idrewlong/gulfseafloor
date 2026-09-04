/**
 * Platform glyphs for NDBC stations.
 *
 * A wind barb says what the wind is doing; it says nothing about what is
 * holding the instrument. A 3-metre discus buoy riding the shelf and an
 * anemometer bolted to a pier in Gulfport report the same stdmet fields, and
 * drawing them identically invites the reader to treat a harbour reading as
 * an offshore one. The glyph at the station position carries the platform
 * class, which NDBC states outright in station_table.txt's ttype column, so
 * nothing here is inferred from the ID format.
 */

export type StationKind = 'buoy' | 'fixed' | 'rig' | 'dart' | 'other';

const KINDS: readonly StationKind[] = ['buoy', 'fixed', 'rig', 'dart', 'other'];

/** Unknown, absent, or pre-`kind` payloads read as 'other'. */
export function stationKind(raw: unknown): StationKind {
  return typeof raw === 'string' && (KINDS as readonly string[]).includes(raw)
    ? (raw as StationKind)
    : 'other';
}

export function kindLabel(kind: StationKind): string {
  switch (kind) {
    case 'buoy':
      return 'Moored buoy';
    case 'fixed':
      return 'Fixed station';
    case 'rig':
      return 'Platform';
    case 'dart':
      return 'DART';
    case 'other':
      return 'Station';
  }
}

/** Radius the wind staff must clear so it does not cut through the glyph. */
export const GLYPH_RADIUS = 4.6;

const CX = 20;
const CY = 20;
const ATTR = 'stroke="currentColor" stroke-width="1.5"';

/** Keeps float noise ("7.199999999999999") out of the emitted markup. */
function fmt(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * Inner markup for the same `0 0 40 40` viewBox the barb uses, centred on the
 * station position.
 *
 * A moored float reads as a circle and a fixed installation as a square —
 * round for something that rides the water, cornered for something that does
 * not. Buoy and DART are hollow because they float; the shore- and
 * platform-mounted marks are filled because they are anchored to structure.
 */
export function stationGlyphSvg(kind: StationKind): string {
  const r = GLYPH_RADIUS - 1;
  const diamond = `M ${fmt(CX)} ${fmt(CY - r)} L ${fmt(CX + r)} ${fmt(CY)} L ${fmt(CX)} ${fmt(
    CY + r,
  )} L ${fmt(CX - r)} ${fmt(CY)} Z`;
  switch (kind) {
    case 'buoy':
      return `<circle cx="${fmt(CX)}" cy="${fmt(CY)}" r="${fmt(r)}" fill="none" ${ATTR}/>`;
    case 'fixed':
      return `<rect x="${fmt(CX - r)}" y="${fmt(CY - r)}" width="${fmt(r * 2)}" height="${fmt(
        r * 2,
      )}" fill="currentColor" ${ATTR}/>`;
    case 'rig':
      return `<path d="M ${fmt(CX)} ${fmt(CY - r)} L ${fmt(CX + r)} ${fmt(CY + r)} L ${fmt(
        CX - r,
      )} ${fmt(CY + r)} Z" fill="currentColor" ${ATTR}/>`;
    case 'dart':
      return `<path d="${diamond}" fill="none" ${ATTR}/>`;
    case 'other':
      return `<path d="${diamond}" fill="currentColor" ${ATTR}/>`;
  }
}

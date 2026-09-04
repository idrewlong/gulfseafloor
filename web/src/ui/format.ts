/**
 * Coordinate and elevation formatting for the chart readouts.
 *
 * These live apart from controls.ts so the inspector can use them without the
 * two modules importing each other: controls.ts delegates its readout entry
 * points to the inspector, and the inspector needs these formatters.
 */
import { formatDepth, type DepthUnit } from './units.ts';

export function formatLat(lat: number): string {
  const hemi = lat >= 0 ? 'N' : 'S';
  return `${Math.abs(lat).toFixed(4)}°${hemi}`;
}

export function formatLon(lon: number): string {
  const hemi = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lon).toFixed(4)}°${hemi}`;
}

export function formatElevation(metres: number, unit: DepthUnit = 'm'): string {
  return formatDepth(metres, unit);
}

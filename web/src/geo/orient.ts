import { AOI } from '../geo';
import outlines from './sound-outlines.json' with { type: 'json' };

export type LonLat = readonly [lon: number, lat: number];

export type Place = {
  name: string;
  lon: number;
  lat: number;
  /** Metres; 0 is the waterline. */
  elev: number;
  kind: 'city' | 'feature' | 'water';
};

type Ring = number[][];

function asLonLat(ring: Ring): LonLat[] {
  return ring.map(([lon, lat]) => [lon, lat] as LonLat);
}

export const MAINLAND_COAST: readonly LonLat[] = asLonLat(outlines.coast);

export const BARRIER_ISLANDS: readonly (readonly LonLat[])[] = (
  ['cat', 'westShip', 'eastShip', 'horn', 'petitBois', 'dauphin', 'deer', 'round'] as const
).map((key) => {
  const ring = outlines.islands[key];
  const pts = asLonLat(ring);
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
      pts.push(first);
    }
  }
  return pts;
});

export const PLACES: readonly Place[] = [
  { name: 'Bay St. Louis', lon: -89.33, lat: 30.31, elev: 3, kind: 'city' },
  { name: 'Gulfport', lon: -89.09, lat: 30.367, elev: 4, kind: 'city' },
  { name: 'Biloxi', lon: -88.89, lat: 30.396, elev: 4, kind: 'city' },
  { name: 'Pascagoula', lon: -88.56, lat: 30.365, elev: 3, kind: 'city' },
  { name: 'Cat Island', lon: -89.12, lat: 30.232, elev: 2, kind: 'feature' },
  { name: 'Horn Island', lon: -88.67, lat: 30.238, elev: 2, kind: 'feature' },
  { name: 'Dauphin Island', lon: -88.13, lat: 30.250, elev: 2, kind: 'feature' },
];

/** Schematic Gulf of Mexico outline for the locator (lon, lat). */
export const GULF_OUTLINE: readonly LonLat[] = [
  [-97.4, 27.8],
  [-97.2, 25.9],
  [-96.9, 23.5],
  [-97.4, 21.5],
  [-94.8, 18.6],
  [-90.8, 19.8],
  [-88.2, 21.6],
  [-86.8, 21.4],
  [-84.4, 22.0],
  [-81.8, 23.2],
  [-81.1, 25.2],
  [-81.5, 27.3],
  [-82.7, 29.2],
  [-84.0, 30.0],
  [-85.5, 30.2],
  [-87.5, 30.4],
  [-88.5, 30.4],
  [-89.2, 30.4],
  [-90.0, 30.2],
  [-91.4, 29.6],
  [-92.6, 29.7],
  [-93.8, 29.7],
  [-95.0, 29.4],
  [-96.4, 28.6],
  [-97.4, 27.8],
];

export const LOCATOR_AOI = AOI;

import { AOI } from '../geo.ts';
import outlines from './sound-outlines.json' with { type: 'json' };

export type LonLat = readonly [lon: number, lat: number];

export type PlaceKind = 'city' | 'feature' | 'water' | 'state';

export type Place = {
  name: string;
  lon: number;
  lat: number;
  /** Metres; 0 is the waterline. */
  elev: number;
  kind: PlaceKind;
  /** Lower wins when two labels occupy the same screen space. */
  rank?: number;
};

export type StateLine = {
  name: string;
  path: readonly LonLat[];
};

export function placeRank(place: Place): number {
  if (typeof place.rank === 'number') {
    return place.rank;
  }
  switch (place.kind) {
    case 'state':
      return 0;
    case 'city':
      return 1;
    case 'feature':
      return 2;
    case 'water':
      return 3;
  }
}

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
  { name: 'Louisiana', lon: -89.85, lat: 30.35, elev: 6, kind: 'state' },
  { name: 'Mississippi', lon: -89.02, lat: 30.485, elev: 8, kind: 'state' },
  { name: 'Alabama', lon: -87.72, lat: 30.50, elev: 6, kind: 'state' },
  { name: 'New Orleans', lon: -90.07, lat: 29.96, elev: 4, kind: 'city' },
  { name: 'Pearlington', lon: -89.603, lat: 30.247, elev: 3, kind: 'city', rank: 2 },
  { name: 'Waveland', lon: -89.377, lat: 30.293, elev: 3, kind: 'city', rank: 2 },
  { name: 'Bay St. Louis', lon: -89.33, lat: 30.31, elev: 3, kind: 'city' },
  { name: 'Pass Christian', lon: -89.247, lat: 30.316, elev: 3, kind: 'city', rank: 2 },
  { name: 'Long Beach', lon: -89.153, lat: 30.351, elev: 4, kind: 'city', rank: 2 },
  { name: 'Gulfport', lon: -89.09, lat: 30.367, elev: 4, kind: 'city' },
  { name: 'Biloxi', lon: -88.89, lat: 30.396, elev: 4, kind: 'city' },
  { name: 'Ocean Springs', lon: -88.798, lat: 30.411, elev: 4, kind: 'city', rank: 2 },
  { name: 'Gautier', lon: -88.612, lat: 30.386, elev: 3, kind: 'city', rank: 2 },
  { name: 'Pascagoula', lon: -88.56, lat: 30.365, elev: 3, kind: 'city' },
  { name: 'Moss Point', lon: -88.534, lat: 30.417, elev: 4, kind: 'city', rank: 2 },
  { name: 'Grand Bay', lon: -88.342, lat: 30.476, elev: 5, kind: 'city', rank: 2 },
  { name: 'Bayou La Batre', lon: -88.248, lat: 30.403, elev: 3, kind: 'city', rank: 2 },
  { name: 'Coden', lon: -88.239, lat: 30.383, elev: 2, kind: 'city', rank: 3 },
  { name: 'Fort Morgan', lon: -87.991, lat: 30.228, elev: 3, kind: 'city', rank: 2 },
  { name: 'Gulf Shores', lon: -87.701, lat: 30.246, elev: 3, kind: 'city', rank: 2 },
  { name: 'Orange Beach', lon: -87.57, lat: 30.33, elev: 3, kind: 'city' },
  { name: 'Mobile', lon: -88.04, lat: 30.69, elev: 8, kind: 'city' },
  { name: 'Cat Island', lon: -89.12, lat: 30.232, elev: 2, kind: 'feature', rank: 1 },
  { name: 'West Ship Island', lon: -88.972, lat: 30.211, elev: 2, kind: 'feature', rank: 1 },
  { name: 'East Ship Island', lon: -88.885, lat: 30.238, elev: 2, kind: 'feature' },
  { name: 'Horn Island', lon: -88.67, lat: 30.238, elev: 2, kind: 'feature', rank: 1 },
  { name: 'Petit Bois Island', lon: -88.45, lat: 30.203, elev: 2, kind: 'feature', rank: 1 },
  { name: 'Dauphin Island', lon: -88.13, lat: 30.250, elev: 2, kind: 'feature', rank: 1 },
  { name: 'Deer Island', lon: -88.85, lat: 30.365, elev: 2, kind: 'feature' },
  { name: 'Round Island', lon: -88.586, lat: 30.292, elev: 2, kind: 'feature' },
  { name: 'Lake Borgne', lon: -89.55, lat: 30.08, elev: 0, kind: 'water' },
  { name: 'Mississippi Sound', lon: -88.74, lat: 30.29, elev: 0, kind: 'water', rank: 2 },
  { name: 'Mobile Bay', lon: -87.98, lat: 30.40, elev: 0, kind: 'water' },
];

/** Pearl River (LA–MS) and the Ellicott meridian (MS–AL), clipped past the AOI. */
export const STATE_LINES: readonly StateLine[] = [
  {
    name: 'Louisiana',
    path: [
      [-89.518, 30.12],
      [-89.532, 30.168],
      [-89.548, 30.192],
      [-89.572, 30.218],
      [-89.594, 30.236],
      [-89.603, 30.247],
      [-89.612, 30.268],
      [-89.62, 30.292],
      [-89.632, 30.322],
      [-89.648, 30.355],
      [-89.662, 30.388],
      [-89.676, 30.422],
      [-89.692, 30.458],
      [-89.706, 30.492],
      [-89.718, 30.53],
      [-89.728, 30.56],
    ],
  },
  {
    name: 'Alabama',
    path: [
      [-88.394, 29.93],
      [-88.394, 30.58],
    ],
  },
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

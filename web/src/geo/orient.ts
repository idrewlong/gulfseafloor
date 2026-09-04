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
  [
    'cat',
    'westShip',
    'eastShip',
    'horn',
    'petitBois',
    'dauphin',
    'deer',
    'round',
    'grandIsle',
    'pointAuFer',
  ] as const
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
  { name: 'Louisiana', lon: -89.85, lat: 30.35, elev: 2, kind: 'state' },
  { name: 'Mississippi', lon: -89.02, lat: 30.485, elev: 8, kind: 'state' },
  { name: 'Alabama', lon: -87.72, lat: 30.50, elev: 6, kind: 'state' },
  { name: 'New Orleans', lon: -90.07, lat: 29.96, elev: 1, kind: 'city' },
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
  // Plaquemines Parish down the river to the Birdfoot, plus the Lafourche
  // coast west of it. Everything below is new with the delta extension; the
  // delta is barely above sea level, so these elevations are 1-3 m, not the
  // 3-8 m the Mississippi coastal ridge carries.
  { name: 'Belle Chasse', lon: -89.99, lat: 29.853, elev: 2, kind: 'city', rank: 2 },
  { name: 'Port Sulphur', lon: -89.694, lat: 29.481, elev: 1, kind: 'city', rank: 2 },
  { name: 'Empire', lon: -89.601, lat: 29.393, elev: 1, kind: 'city', rank: 2 },
  { name: 'Buras', lon: -89.526, lat: 29.352, elev: 1, kind: 'city', rank: 2 },
  { name: 'Venice', lon: -89.354, lat: 29.277, elev: 1, kind: 'city' },
  { name: 'Pilottown', lon: -89.259, lat: 29.179, elev: 1, kind: 'city', rank: 3 },
  { name: 'Grand Isle', lon: -89.957, lat: 29.237, elev: 2, kind: 'city' },
  { name: 'Golden Meadow', lon: -90.259, lat: 29.378, elev: 2, kind: 'city', rank: 3 },
  { name: 'Port Fourchon', lon: -90.199, lat: 29.104, elev: 1, kind: 'city', rank: 2 },
  { name: 'Head of Passes', lon: -89.245, lat: 29.153, elev: 1, kind: 'feature' },
  { name: 'Southwest Pass', lon: -89.42, lat: 28.97, elev: 0, kind: 'feature', rank: 1 },
  { name: 'South Pass', lon: -89.14, lat: 29.02, elev: 0, kind: 'feature', rank: 2 },
  { name: 'Pass a Loutre', lon: -89.05, lat: 29.198, elev: 0, kind: 'feature', rank: 2 },
  // No Breton or Chandeleur label here on purpose: OSM has those chains only
  // as points, so they carry no polygon and render as open water. Labelling
  // them would put a place name on a patch of sea.
  { name: 'Barataria Bay', lon: -89.95, lat: 29.42, elev: 0, kind: 'water' },
  { name: 'Breton Sound', lon: -89.30, lat: 29.68, elev: 0, kind: 'water' },
  { name: 'Timbalier Bay', lon: -90.42, lat: 29.10, elev: 0, kind: 'water', rank: 2 },
  { name: 'Mississippi Canyon', lon: -89.20, lat: 28.66, elev: 0, kind: 'water' },
  { name: 'Gulf of Mexico', lon: -88.30, lat: 28.85, elev: 0, kind: 'water', rank: 1 },
  // West of Barataria: the Atchafalaya and Terrebonne coast, added when the
  // chart was widened to a 16:9 box so the canyon clears the fold on load.
  { name: 'Morgan City', lon: -91.207, lat: 29.699, elev: 2, kind: 'city', rank: 2 },
  { name: 'Berwick', lon: -91.237, lat: 29.694, elev: 2, kind: 'city', rank: 3 },
  { name: 'Houma', lon: -90.72, lat: 29.596, elev: 3, kind: 'city' },
  { name: 'Cocodrie', lon: -90.661, lat: 29.245, elev: 1, kind: 'city', rank: 3 },
  { name: 'Point au Fer', lon: -91.33, lat: 29.32, elev: 1, kind: 'feature', rank: 3 },
  { name: 'Atchafalaya Bay', lon: -91.30, lat: 29.42, elev: 0, kind: 'water' },
  { name: 'Terrebonne Bay', lon: -90.55, lat: 29.17, elev: 0, kind: 'water', rank: 2 },
  { name: 'Ship Shoal', lon: -91.10, lat: 28.90, elev: 0, kind: 'water', rank: 3 },
  // East of Perdido: the Florida panhandle shore and the DeSoto Canyon head.
  { name: 'Pensacola', lon: -87.217, lat: 30.421, elev: 6, kind: 'city' },
  { name: 'Gulf Breeze', lon: -87.163, lat: 30.357, elev: 4, kind: 'city', rank: 3 },
  { name: 'Pensacola Beach', lon: -87.139, lat: 30.334, elev: 2, kind: 'city', rank: 3 },
  { name: 'Navarre', lon: -86.862, lat: 30.402, elev: 4, kind: 'city', rank: 2 },
  { name: 'Perdido Key', lon: -87.45, lat: 30.303, elev: 2, kind: 'feature', rank: 2 },
  { name: 'Santa Rosa Island', lon: -86.95, lat: 30.345, elev: 2, kind: 'feature', rank: 1 },
  { name: 'Pensacola Bay', lon: -87.145, lat: 30.46, elev: 0, kind: 'water' },
  { name: 'DeSoto Canyon', lon: -86.90, lat: 29.15, elev: 0, kind: 'water' },
  { name: 'Florida', lon: -86.80, lat: 30.62, elev: 8, kind: 'state' },
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



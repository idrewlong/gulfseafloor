/** Mississippi Bight AOI, WGS84 — New Orleans to Orange Beach, south to 42354. */
export const AOI = {
  west: -90.2,
  south: 29.5,
  east: -87.45,
  north: 30.78,
} as const;

export const ORIGIN = { lon: -88.82, lat: 30.14 } as const;

export const DEFAULT_MIN_ZOOM = 6;
export const DEFAULT_MAX_ZOOM = 14;

const METRES_PER_DEG_LAT = 111_320;
const EARTH_RADIUS_M = 6_371_000;

export type BBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type TileCoord = {
  z: number;
  x: number;
  y: number;
};

export function tileKey(t: TileCoord): string {
  return `${t.z}/${t.x}/${t.y}`;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

/** Overlap of two boxes, or null when they miss. Matches Go `tiles.Intersect`. */
export function intersectBBox(a: BBox, b: BBox): BBox | null {
  const west = Math.max(a.west, b.west);
  const south = Math.max(a.south, b.south);
  const east = Math.min(a.east, b.east);
  const north = Math.min(a.north, b.north);
  if (west >= east || south >= north) {
    return null;
  }
  return { west, south, east, north };
}

export type HeightUvRect = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
};

/** Texture UV that maps a clipped box onto a tile. v=0 is south. */
export function heightUvRect(tile: BBox, clip: BBox): HeightUvRect {
  const tw = tile.east - tile.west;
  const th = tile.north - tile.south;
  if (tw === 0 || th === 0) {
    return { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
  }
  return {
    offsetX: (clip.west - tile.west) / tw,
    offsetY: (clip.south - tile.south) / th,
    scaleX: (clip.east - clip.west) / tw,
    scaleY: (clip.north - clip.south) / th,
  };
}

export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(
      0,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  return { z, x, y };
}

export function tileBounds(t: TileCoord): BBox {
  const n = 2 ** t.z;
  const west = (t.x / n) * 360 - 180;
  const east = ((t.x + 1) / n) * 360 - 180;
  return {
    west,
    south: yToLat((t.y + 1) / n),
    east,
    north: yToLat(t.y / n),
  };
}

export function covering(bbox: BBox, z: number): TileCoord[] {
  const nw = lonLatToTile(bbox.west, bbox.north, z);
  const se = lonLatToTile(bbox.east, bbox.south, z);
  const minX = Math.min(nw.x, se.x);
  const maxX = Math.max(nw.x, se.x);
  const minY = Math.min(nw.y, se.y);
  const maxY = Math.max(nw.y, se.y);
  const out: TileCoord[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      out.push({ z, x, y });
    }
  }
  return out;
}

export function childrenOf(t: TileCoord): TileCoord[] {
  return [
    { z: t.z + 1, x: t.x * 2, y: t.y * 2 },
    { z: t.z + 1, x: t.x * 2 + 1, y: t.y * 2 },
    { z: t.z + 1, x: t.x * 2, y: t.y * 2 + 1 },
    { z: t.z + 1, x: t.x * 2 + 1, y: t.y * 2 + 1 },
  ];
}

/** East–west ground span at the tile centre latitude (matches Go `tiles.SpanMetres`). */
export function spanMetres(t: TileCoord): number {
  const b = tileBounds(t);
  const midLat = (b.north + b.south) / 2;
  return haversineMetres(b.west, midLat, b.east, midLat);
}

/** North–south ground span at the tile centre longitude. */
export function spanNorthMetres(t: TileCoord): number {
  const b = tileBounds(t);
  const midLon = (b.west + b.east) / 2;
  return haversineMetres(midLon, b.south, midLon, b.north);
}

export function yToLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

export function latToY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}

/** Local metric plane: X east, Y north, metres from the AOI origin. */
export function lonLatToLocal(lon: number, lat: number): { x: number; y: number } {
  const mPerDegLon = METRES_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
  return {
    x: (lon - ORIGIN.lon) * mPerDegLon,
    y: (lat - ORIGIN.lat) * METRES_PER_DEG_LAT,
  };
}

export function localToLonLat(x: number, y: number): { lon: number; lat: number } {
  const mPerDegLon = METRES_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
  return {
    lon: ORIGIN.lon + x / mPerDegLon,
    lat: ORIGIN.lat + y / METRES_PER_DEG_LAT,
  };
}

export function bboxContains(b: BBox, lon: number, lat: number): boolean {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

export function uvToLonLat(t: TileCoord, u: number, v: number): { lon: number; lat: number } {
  const n = 2 ** t.z;
  const lon = ((t.x + u) / n) * 360 - 180;
  const lat = yToLat((t.y + (1 - v)) / n);
  return { lon, lat };
}

/** Geometry UV on an AOI-clipped tile → WGS84. v=0 is south. */
export function uvToLonLatOnBounds(b: BBox, u: number, v: number): { lon: number; lat: number } {
  const lon = b.west + u * (b.east - b.west);
  const ySouth = latToY(b.south);
  const yNorth = latToY(b.north);
  const lat = yToLat(ySouth + v * (yNorth - ySouth));
  return { lon, lat };
}

function haversineMetres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const dφ = ((lat2 - lat1) * Math.PI) / 180;
  const dλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dφ / 2) * Math.sin(dφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) * Math.sin(dλ / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

import { GULF_OUTLINE, LOCATOR_AOI, type LonLat } from '../geo/orient';

const WEST = -98;
const EAST = -80;
const SOUTH = 18.2;
const NORTH = 31.2;
const W = 132;
const H = 96;

function xy(lon: number, lat: number): { x: number; y: number } {
  return {
    x: ((lon - WEST) / (EAST - WEST)) * W,
    y: ((NORTH - lat) / (NORTH - SOUTH)) * H,
  };
}

function pathD(ring: readonly LonLat[]): string {
  return ring
    .map(([lon, lat], i) => {
      const p = xy(lon, lat);
      return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(' ');
}

export function mountLocator(root: HTMLElement): void {
  const nw = xy(LOCATOR_AOI.west, LOCATOR_AOI.north);
  const se = xy(LOCATOR_AOI.east, LOCATOR_AOI.south);
  const x = nw.x;
  const y = nw.y;
  const w = Math.max(2, se.x - nw.x);
  const h = Math.max(2, se.y - nw.y);

  root.innerHTML = `
    <p class="locator-kicker">Where this is</p>
    <svg class="locator-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Locator map: Mississippi Sound on the northern Gulf of Mexico">
      <path class="locator-gulf" d="${pathD(GULF_OUTLINE)} Z" />
      <rect class="locator-aoi" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" />
      <text class="locator-n" x="${W - 14}" y="14">N</text>
    </svg>
    <p class="locator-caption">Northern Gulf · box is the Sound</p>
  `;
}

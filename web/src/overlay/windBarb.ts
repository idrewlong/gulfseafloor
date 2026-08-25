export function msToKnots(ms: number): number {
  return ms * 1.94384;
}

export type BarbCounts = {
  pennants: number;
  full: number;
  half: boolean;
  calm: boolean;
};

/** Round to nearest 5 kt. Below 2.5 kt is calm (circle, no staff). */
export function barbCounts(knots: number): BarbCounts {
  if (knots < 2.5) {
    return { pennants: 0, full: 0, half: false, calm: true };
  }
  let kt = Math.round(knots / 5) * 5;
  const pennants = Math.floor(kt / 50);
  kt -= pennants * 50;
  const full = Math.floor(kt / 10);
  kt -= full * 10;
  return { pennants, full, half: kt >= 5, calm: false };
}

const CX = 20;
const CY = 20;
const STAFF_LEN = 12;
const BARB_LEN = 6;
const HALF_LEN = 3.5;
const STEP = 3.2;
const ATTR = 'fill="none" stroke="currentColor" stroke-width="1.5"';

function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * SVG inner markup for a 0 0 40 40 viewBox. Staff points into the wind
 * (meteorological from). Northern-hemisphere barbs sit on the left of
 * the staff when heading along `wdirFromDeg`.
 */
export function barbSvg(wdirFromDeg: number, wspdMs: number): string {
  const counts = barbCounts(msToKnots(wspdMs));
  if (counts.calm) {
    return `<circle cx="${CX}" cy="${CY}" r="4" ${ATTR}/>`;
  }

  const rad = (wdirFromDeg * Math.PI) / 180;
  const hx = Math.sin(rad);
  const hy = -Math.cos(rad);
  const lx = hy;
  const ly = -hx;

  const tipX = CX + hx * STAFF_LEN;
  const tipY = CY + hy * STAFF_LEN;
  const parts: string[] = [`M ${fmt(CX)} ${fmt(CY)} L ${fmt(tipX)} ${fmt(tipY)}`];

  const point = (along: number): { x: number; y: number } => ({
    x: tipX - hx * along,
    y: tipY - hy * along,
  });

  let along = 0;
  for (let i = 0; i < counts.pennants; i++) {
    const a = point(along);
    const b = point(along + STEP);
    const apexX = a.x + lx * BARB_LEN;
    const apexY = a.y + ly * BARB_LEN;
    parts.push(`M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(apexX)} ${fmt(apexY)} L ${fmt(b.x)} ${fmt(b.y)} Z`);
    along += STEP + 1;
  }
  if (counts.pennants > 0 && (counts.full > 0 || counts.half)) {
    along += 0.6;
  }
  for (let i = 0; i < counts.full; i++) {
    const a = point(along);
    const ex = a.x + lx * BARB_LEN - hx * (STEP * 0.45);
    const ey = a.y + ly * BARB_LEN - hy * (STEP * 0.45);
    parts.push(`M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(ex)} ${fmt(ey)}`);
    along += STEP;
  }
  if (counts.half) {
    if (counts.pennants === 0 && counts.full === 0) {
      along += STEP;
    }
    const a = point(along);
    const ex = a.x + lx * HALF_LEN - hx * (STEP * 0.25);
    const ey = a.y + ly * HALF_LEN - hy * (STEP * 0.25);
    parts.push(`M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(ex)} ${fmt(ey)}`);
  }

  return `<path d="${parts.join(' ')}" ${ATTR}/>`;
}

import * as THREE from 'three';

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

function mix3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [mix(a[0]!, b[0]!, t), mix(a[1]!, b[1]!, t), mix(a[2]!, b[2]!, t)];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Unlit terrain.frag.glsl `base` colour at elevation metres (WGS84 up). */
export function unlitBaseColor(elev: number, depthMin = -30): [number, number, number] {
  const depth = Math.max(-elev, 0);
  const land = smoothstep(-0.25, 0.45, elev);

  const sandWet = [0.55, 0.47, 0.34];
  const sandDry = [0.89, 0.8, 0.58];
  const dune = [0.76, 0.66, 0.45];
  const scrub = [0.38, 0.44, 0.3];
  let beach = mix3(sandWet, sandDry, smoothstep(-0.15, 0.9, elev));
  beach = mix3(beach, dune, smoothstep(0.6, 2.0, elev));
  const ground = mix3(beach, scrub, smoothstep(1.5, 3.3, elev));

  const gulf = smoothstep(2.0, Math.max(12.0, -depthMin * 0.45), depth);
  const scatter = mix3(
    mix3([0.42, 0.62, 0.58], [0.2, 0.4, 0.42], smoothstep(1.0, 8.0, depth)),
    [0.12, 0.3, 0.4],
    gulf,
  );
  const absorb = 1 - Math.exp(-mix(0.5, 0.1, gulf) * depth);
  let water = mix3([0.62, 0.58, 0.42], scatter, absorb);
  const foam = (1 - land) * (1 - smoothstep(-0.45, 0.12, elev));
  water = mix3(water, [0.88, 0.91, 0.9], foam * 0.22);

  return mix3(water, ground, land);
}

function cssRgb(color: readonly number[]): string {
  const r = Math.round(color[0]! * 255);
  const g = Math.round(color[1]! * 255);
  const b = Math.round(color[2]! * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Vertical CSS ramp: `min` metres at the bottom, `max` at the top. */
export function legendGradientCss(min: number, max: number, depthMin = -30): string {
  const steps = 20;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const elev = min + (max - min) * t;
    stops.push(`${cssRgb(unlitBaseColor(elev, depthMin))} ${(t * 100).toFixed(0)}%`);
  }
  return `linear-gradient(to top, ${stops.join(', ')})`;
}

/** Natural Sound ramp for the legend: gulf → turbid shallows → sand → dune. */
const STOPS: readonly { t: number; hex: string }[] = [
  { t: 0.0, hex: '#0A2E3C' },
  { t: 0.22, hex: '#1A4F4A' },
  { t: 0.48, hex: '#3D7A68' },
  { t: 0.70, hex: '#C4A56A' },
  { t: 0.88, hex: '#DCC592' },
  { t: 1.0, hex: '#6B7A52' },
];

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleRamp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < STOPS.length - 2 && x > STOPS[i + 1]!.t) {
    i += 1;
  }
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  const span = b.t - a.t;
  const u = span > 0 ? (x - a.t) / span : 0;
  const [ar, ag, ab] = hexToRgb(a.hex);
  const [br, bg, bb] = hexToRgb(b.hex);
  return [lerp(ar, br, u), lerp(ag, bg, u), lerp(ab, bb, u)];
}

/** 256×1 CanvasTexture of the ENC depth ramp. Shared across all terrain materials. */
export function createHypsometricLUT(): THREE.CanvasTexture {
  const width = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas unavailable — cannot build hypsometric LUT');
  }
  const img = ctx.createImageData(width, 1);
  for (let x = 0; x < width; x++) {
    const [r, g, b] = sampleRamp(x / (width - 1));
    const i = x * 4;
    img.data[i] = Math.round(r);
    img.data[i + 1] = Math.round(g);
    img.data[i + 2] = Math.round(b);
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

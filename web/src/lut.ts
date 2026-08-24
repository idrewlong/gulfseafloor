import * as THREE from 'three';

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

export const LUT_CSS_GRADIENT =
  'linear-gradient(to top, #0A2E3C 0%, #1A4F4A 22%, #3D7A68 48%, #C4A56A 70%, #DCC592 88%, #6B7A52 100%)';

import * as THREE from 'three';
import { lonLatToLocal } from '../geo.ts';
import {
  FLOW_SCALE,
  PARTICLE_COUNT,
  TRAIL_LAG_SEC,
  advect,
  staticArrows,
  type VelocityGrid,
} from './currentsField.ts';
import { speedColor } from './speedRamp.ts';

export function detectFloatOk(renderer: { extensions: { has(name: string): boolean } }): boolean {
  try {
    return (
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('WEBGL_color_buffer_float')
    );
  } catch {
    return false;
  }
}

/** Vertices per trail. More segments buy curvature, at 2 vertices each. */
export const TRAIL_SEGMENTS = 8;

export function makeTrailGeometry(): THREE.BufferGeometry {
  const verts = PARTICLE_COUNT * TRAIL_SEGMENTS * 2;
  const ids = new Float32Array(verts);
  const ts = new Float32Array(verts);
  let o = 0;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    for (let s = 0; s < TRAIL_SEGMENTS; s++) {
      ids[o] = i;
      ts[o] = s / TRAIL_SEGMENTS;
      o++;
      ids[o] = i;
      ts[o] = (s + 1) / TRAIL_SEGMENTS;
      o++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  geo.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
  geo.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
  geo.setDrawRange(0, verts);
  return geo;
}

export function makePointGeometry(): THREE.BufferGeometry {
  const ids = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    ids[i] = i;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3));
  geo.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
  geo.setDrawRange(0, PARTICLE_COUNT);
  return geo;
}

/** Arrows sit above the terrain so they never z-fight the seabed. */
const ARROW_LIFT_Z = 18;
/** Below this the arrow is noise, not signal. */
const ARROW_MIN_MS = 0.02;
const ARROW_HEAD_FRAC = 0.3;

/**
 * Baked-geometry arrows: the reduced-motion and no-float-texture fallback for
 * the particle sim. Speed sets length and ramp color; a 2-segment arrowhead
 * makes direction legible without a shader.
 */
export function makeStaticArrows(grid: VelocityGrid): THREE.Group {
  const group = new THREE.Group();
  group.name = 'currents-arrows';
  const pts: number[] = [];
  const cols: number[] = [];
  for (const a of staticArrows(grid)) {
    const speed = Math.hypot(a.u, a.v);
    if (speed < ARROW_MIN_MS) {
      continue;
    }
    const rgb = speedColor(speed);
    const a0 = lonLatToLocal(a.lon, a.lat);
    const next = advect(a.lon, a.lat, a.u, a.v, TRAIL_LAG_SEC, FLOW_SCALE);
    const a1 = lonLatToLocal(next.lon, next.lat);
    const dx = a1.x - a0.x;
    const dy = a1.y - a0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = len * ARROW_HEAD_FRAC;
    const push = (x0: number, y0: number, x1: number, y1: number): void => {
      pts.push(x0, y0, ARROW_LIFT_Z, x1, y1, ARROW_LIFT_Z);
      cols.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    };
    push(a0.x, a0.y, a1.x, a1.y);
    // Two barbs at +/-150 degrees from the shaft make it read as an arrow.
    for (const sign of [1, -1]) {
      const ang = Math.atan2(uy, ux) + sign * (Math.PI * 5) / 6;
      push(a1.x, a1.y, a1.x + Math.cos(ang) * head, a1.y + Math.sin(ang) * head);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 4;
  group.add(lines);
  return group;
}

export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.geometry || mesh.material == null) {
      return;
    }
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) {
        m.dispose();
      }
    } else {
      mat.dispose();
    }
  });
}

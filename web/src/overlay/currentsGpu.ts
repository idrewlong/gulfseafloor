import * as THREE from 'three';
import { PARTICLE_COUNT } from './currentsField.ts';

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

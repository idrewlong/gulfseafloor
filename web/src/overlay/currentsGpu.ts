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

export function makeTrailGeometry(): THREE.BufferGeometry {
  const verts = PARTICLE_COUNT * 2;
  const ids = new Float32Array(verts);
  const ends = new Float32Array(verts);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    ids[i * 2] = i;
    ids[i * 2 + 1] = i;
    ends[i * 2] = 0;
    ends[i * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  geo.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
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

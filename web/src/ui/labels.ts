import * as THREE from 'three';
import { lonLatToLocal } from '../geo';
import { PLACES } from '../geo/orient';

export type LabelsHandle = {
  update(camera: THREE.PerspectiveCamera, exaggeration: number, width: number, height: number): void;
};

export function mountLabels(root: HTMLElement): LabelsHandle {
  root.innerHTML = PLACES.map(
    (p) =>
      `<span class="geo-label geo-label-${p.kind}" data-place="${p.name}" hidden>${p.name}</span>`,
  ).join('');
  const nodes = [...root.querySelectorAll<HTMLElement>('.geo-label')];
  const scratch = new THREE.Vector3();

  return {
    update(camera, exaggeration, width, height) {
      for (let i = 0; i < PLACES.length; i++) {
        const place = PLACES[i];
        const el = nodes[i];
        if (!place || !el) {
          continue;
        }
        const p = lonLatToLocal(place.lon, place.lat);
        scratch.set(p.x, p.y, place.elev * exaggeration + 60);
        scratch.project(camera);
        const behind = scratch.z > 1;
        const x = (scratch.x * 0.5 + 0.5) * width;
        const y = (-scratch.y * 0.5 + 0.5) * height;
        const on = !behind && x > 8 && x < width - 8 && y > 8 && y < height - 8;
        el.hidden = !on;
        if (on) {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
      }
    },
  };
}

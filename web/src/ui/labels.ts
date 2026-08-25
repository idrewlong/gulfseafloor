import * as THREE from 'three';
import { lonLatToLocal } from '../geo';
import { PLACES, placeRank } from '../geo/orient';
import { visibleLabelIds, MIN_LABEL_PX } from './labelLayout';
import type { LabelCandidate } from './labelLayout';

const BUOY_ID_BASE = 1000;

export type ProjectFn = (
  lon: number,
  lat: number,
  elev: number,
) => { x: number; y: number } | null;

export type LabelsHandle = {
  update(
    camera: THREE.PerspectiveCamera,
    exaggeration: number,
    width: number,
    height: number,
    buoyCandidates?: LabelCandidate[],
  ): Set<number>;
  layout(
    project: ProjectFn,
    width: number,
    height: number,
    buoyCandidates?: LabelCandidate[],
  ): Set<number>;
  placeCandidates(): LabelCandidate[];
};

export function screenProject(
  camera: THREE.PerspectiveCamera,
  exaggeration: number,
  width: number,
  height: number,
  scratch: THREE.Vector3 = new THREE.Vector3(),
): ProjectFn {
  return (lon, lat, elev) => {
    const p = lonLatToLocal(lon, lat);
    scratch.set(p.x, p.y, elev * exaggeration + 60);
    scratch.project(camera);
    if (scratch.z > 1) {
      return null;
    }
    return {
      x: (scratch.x * 0.5 + 0.5) * width,
      y: (-scratch.y * 0.5 + 0.5) * height,
    };
  };
}

export function mountLabels(root: HTMLElement): LabelsHandle {
  root.innerHTML = PLACES.map(
    (p) =>
      `<span class="geo-label geo-label-${p.kind}" data-place="${p.name}" hidden>${p.name}</span>`,
  ).join('');
  const nodes = [...root.querySelectorAll<HTMLElement>('.geo-label')];
  const scratch = new THREE.Vector3();
  let lastPlaces: LabelCandidate[] = [];

  const layout: LabelsHandle['layout'] = (project, width, height, buoyCandidates = []) => {
    const candidates: LabelCandidate[] = [];
    const positions: Array<{ x: number; y: number } | null> = [];
    for (let i = 0; i < PLACES.length; i++) {
      const place = PLACES[i];
      const el = nodes[i];
      if (!place || !el) {
        positions.push(null);
        continue;
      }
      const pos = project(place.lon, place.lat, place.elev);
      const on =
        pos !== null && pos.x > 8 && pos.x < width - 8 && pos.y > 8 && pos.y < height - 8;
      if (on && pos) {
        positions.push(pos);
        candidates.push({ id: i, x: pos.x, y: pos.y, rank: placeRank(place) });
      } else {
        positions.push(null);
      }
    }
    lastPlaces = candidates;
    const visible = visibleLabelIds([...candidates, ...buoyCandidates], MIN_LABEL_PX);
    for (let i = 0; i < PLACES.length; i++) {
      const el = nodes[i];
      const pos = positions[i];
      if (!el) {
        continue;
      }
      const on = pos !== null && visible.has(i);
      el.hidden = !on;
      if (on && pos) {
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
      }
    }
    const buoyVisible = new Set<number>();
    for (const id of visible) {
      if (id >= BUOY_ID_BASE) {
        buoyVisible.add(id);
      }
    }
    return buoyVisible;
  };

  return {
    layout,
    placeCandidates: () => lastPlaces,
    update(camera, exaggeration, width, height, buoyCandidates = []) {
      return layout(screenProject(camera, exaggeration, width, height, scratch), width, height, buoyCandidates);
    },
  };
}

import * as THREE from 'three';
import { lonLatToLocal } from '../geo';
import { BARRIER_ISLANDS, MAINLAND_COAST, type LonLat } from '../geo/orient';

function lineFrom(path: readonly LonLat[], yLift: number): THREE.Line {
  const pts = path.map(([lon, lat]) => {
    const p = lonLatToLocal(lon, lat);
    return new THREE.Vector3(p.x, p.y, yLift);
  });
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({
    color: 0xd8c9a4,
    transparent: true,
    opacity: 0.38,
    depthTest: true,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 2;
  return line;
}

/** Coastline at the waterline (world z ≈ 0). */
export function addCoastOverlay(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  group.name = 'coast';
  group.add(lineFrom(MAINLAND_COAST, 18));
  for (const island of BARRIER_ISLANDS) {
    group.add(lineFrom(island, 18));
  }
  scene.add(group);
  return group;
}

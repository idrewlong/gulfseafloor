import * as THREE from 'three';
import { lonLatToLocal } from '../geo';
import { BARRIER_ISLANDS, MAINLAND_COAST, STATE_LINES, type LonLat } from '../geo/orient';

function pointsFrom(path: readonly LonLat[], yLift: number): THREE.Vector3[] {
  return path.map(([lon, lat]) => {
    const p = lonLatToLocal(lon, lat);
    return new THREE.Vector3(p.x, p.y, yLift);
  });
}

function coastLine(path: readonly LonLat[], yLift: number): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(pointsFrom(path, yLift));
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

function stateLine(path: readonly LonLat[], yLift: number): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(pointsFrom(path, yLift));
  const mat = new THREE.LineDashedMaterial({
    color: 0xc0006e,
    dashSize: 1400,
    gapSize: 900,
    transparent: true,
    opacity: 0.55,
    depthTest: true,
  });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  line.frustumCulled = false;
  line.renderOrder = 3;
  return line;
}

/** Coastline at the waterline (world z ≈ 0), plus LA / AL bounds. */
export function addCoastOverlay(scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  group.name = 'coast';
  group.add(coastLine(MAINLAND_COAST, 18));
  for (const island of BARRIER_ISLANDS) {
    group.add(coastLine(island, 18));
  }
  for (const border of STATE_LINES) {
    group.add(stateLine(border.path, 24));
  }
  scene.add(group);
  return group;
}

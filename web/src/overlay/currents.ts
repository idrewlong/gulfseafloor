import * as THREE from 'three';
import { AOI, ORIGIN, lonLatToLocal } from '../geo';
import {
  FLOW_SCALE,
  PARTICLE_COUNT,
  PARTICLE_MAX_AGE,
  advect,
  staticArrows,
  type VelocityGrid,
} from './currentsField';
import advectFrag from './shaders/advect.frag.glsl?raw';
import trailVert from './shaders/trail.vert.glsl?raw';
import trailFrag from './shaders/trail.frag.glsl?raw';

const STATE_W = 128;
const STATE_H = 64;
const LIFT_Z = 18;
const TRAIL_CYAN = 0x8cc7d1;

const ADVECT_VERT = `precision highp float;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export type CurrentsHandle = {
  setEnabled(on: boolean): void;
  tick(dtSec: number): void;
  setReducedMotion(on: boolean): void;
  destroy(): void;
};

type GpuSim = {
  velTex: THREE.DataTexture;
  ping: THREE.WebGLRenderTarget;
  pong: THREE.WebGLRenderTarget;
  read: THREE.WebGLRenderTarget;
  write: THREE.WebGLRenderTarget;
  simScene: THREE.Scene;
  simCamera: THREE.OrthographicCamera;
  simMat: THREE.ShaderMaterial;
  trails: THREE.LineSegments;
  trailMat: THREE.ShaderMaterial;
  trailGeo: THREE.BufferGeometry;
  initialized: boolean;
};

function metresPerDegree(): { lon: number; lat: number } {
  const east = lonLatToLocal(ORIGIN.lon + 1, ORIGIN.lat);
  const north = lonLatToLocal(ORIGIN.lon, ORIGIN.lat + 1);
  return { lon: east.x, lat: north.y };
}

function velocityTexture(grid: VelocityGrid): THREE.DataTexture {
  const { nx, ny } = grid;
  const data = new Float32Array(nx * ny * 4);
  for (let i = 0; i < nx * ny; i++) {
    const u = grid.u[i];
    const v = grid.v[i];
    const o = i * 4;
    if (u == null || v == null) {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
    } else {
      data[o] = u;
      data[o + 1] = v;
      data[o + 2] = 1;
      data[o + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat, THREE.FloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // Packed south-to-north (iy=0 first). flipY false so WebGL v=0 is that first row.
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeStateRT(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(STATE_W, STATE_H, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: 2,
    colorSpace: THREE.NoColorSpace,
  });
  for (const tex of rt.textures) {
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
  }
  return rt;
}

function makeTrailGeometry(): THREE.BufferGeometry {
  const ids = new Float32Array(PARTICLE_COUNT * 2);
  const ends = new Float32Array(PARTICLE_COUNT * 2);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    ids[i * 2] = i;
    ids[i * 2 + 1] = i;
    ends[i * 2] = 0;
    ends[i * 2 + 1] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aId', new THREE.BufferAttribute(ids, 1));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  return geo;
}

function makeStaticArrows(grid: VelocityGrid): THREE.Group {
  const group = new THREE.Group();
  group.name = 'currents-arrows';
  const pts: number[] = [];
  for (const a of staticArrows(grid)) {
    const a0 = lonLatToLocal(a.lon, a.lat);
    const next = advect(a.lon, a.lat, a.u, a.v, 0.2, FLOW_SCALE);
    const a1 = lonLatToLocal(next.lon, next.lat);
    pts.push(a0.x, a0.y, LIFT_Z, a1.x, a1.y, LIFT_Z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: TRAIL_CYAN,
    transparent: true,
    opacity: 0.55,
    depthTest: true,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 4;
  group.add(lines);
  return group;
}

function makeGpu(grid: VelocityGrid): GpuSim {
  const mPerDeg = metresPerDegree();
  const velTex = velocityTexture(grid);
  const ping = makeStateRT();
  const pong = makeStateRT();
  const simMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uVelTex: { value: velTex },
      uStatePos: { value: ping.textures[0] },
      uStateLife: { value: ping.textures[1] },
      uStateSize: { value: new THREE.Vector2(STATE_W, STATE_H) },
      uVelSize: { value: new THREE.Vector2(grid.nx, grid.ny) },
      uOriginLon: { value: ORIGIN.lon },
      uOriginLat: { value: ORIGIN.lat },
      uMPerDegLon: { value: mPerDeg.lon },
      uMPerDegLat: { value: mPerDeg.lat },
      uAoiWest: { value: AOI.west },
      uAoiSouth: { value: AOI.south },
      uAoiEast: { value: AOI.east },
      uAoiNorth: { value: AOI.north },
      uGridWest: { value: grid.bbox.west },
      uGridSouth: { value: grid.bbox.south },
      uGridEast: { value: grid.bbox.east },
      uGridNorth: { value: grid.bbox.north },
      uDt: { value: 0 },
      // Visual exaggeration so ~0.5 m/s shelf flow is readable; not a physical dt.
      uFlowScale: { value: FLOW_SCALE },
      uMaxAge: { value: PARTICLE_MAX_AGE },
      uInit: { value: 1 },
    },
    vertexShader: ADVECT_VERT,
    fragmentShader: advectFrag,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const simScene = new THREE.Scene();
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat);
  quad.frustumCulled = false;
  simScene.add(quad);

  const trailGeo = makeTrailGeometry();
  const trailMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uStatePos: { value: ping.textures[0] },
      uStateSize: { value: new THREE.Vector2(STATE_W, STATE_H) },
    },
    vertexShader: trailVert,
    fragmentShader: trailFrag,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const trails = new THREE.LineSegments(trailGeo, trailMat);
  trails.name = 'currents-trails';
  trails.frustumCulled = false;
  trails.renderOrder = 4;

  return {
    velTex,
    ping,
    pong,
    read: ping,
    write: pong,
    simScene,
    simCamera,
    simMat,
    trails,
    trailMat,
    trailGeo,
    initialized: false,
  };
}

function disposeGpu(gpu: GpuSim): void {
  gpu.trails.onBeforeRender = (): void => {};
  gpu.velTex.dispose();
  gpu.ping.dispose();
  gpu.pong.dispose();
  gpu.simMat.dispose();
  gpu.trailMat.dispose();
  gpu.trailGeo.dispose();
  const quad = gpu.simScene.children[0];
  if (quad instanceof THREE.Mesh) {
    quad.geometry.dispose();
  }
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) {
        for (const m of mat) {
          m.dispose();
        }
      } else {
        mat.dispose();
      }
    }
  });
}

export function mountCurrents(
  scene: THREE.Scene,
  grid: VelocityGrid,
  opts: { reducedMotion: boolean; floatOk: boolean },
): CurrentsHandle {
  const group = new THREE.Group();
  group.name = 'currents';
  const arrows = makeStaticArrows(grid);
  group.add(arrows);

  const gpu = opts.floatOk ? makeGpu(grid) : null;
  if (gpu) {
    group.add(gpu.trails);
  }

  let enabled = true;
  let reducedMotion = opts.reducedMotion;
  let pendingDt = 0;

  const useStatic = (): boolean => reducedMotion || !opts.floatOk || gpu == null;

  const syncVisibility = (): void => {
    arrows.visible = useStatic();
    if (gpu) {
      gpu.trails.visible = !useStatic();
    }
  };
  syncVisibility();

  const runSim = (renderer: THREE.WebGLRenderer, dtSec: number, init: boolean): void => {
    if (!gpu) {
      return;
    }
    gpu.simMat.uniforms.uStatePos.value = gpu.read.textures[0];
    gpu.simMat.uniforms.uStateLife.value = gpu.read.textures[1];
    gpu.simMat.uniforms.uDt.value = dtSec;
    gpu.simMat.uniforms.uInit.value = init ? 1 : 0;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(gpu.write);
    renderer.render(gpu.simScene, gpu.simCamera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    const tmp = gpu.read;
    gpu.read = gpu.write;
    gpu.write = tmp;
    gpu.trailMat.uniforms.uStatePos.value = gpu.read.textures[0];
    gpu.initialized = true;
  };

  if (gpu) {
    gpu.trails.onBeforeRender = (renderer) => {
      if (!enabled || !group.visible || useStatic()) {
        pendingDt = 0;
        return;
      }
      if (!gpu.initialized) {
        runSim(renderer, 0, true);
      } else if (pendingDt > 0) {
        runSim(renderer, pendingDt, false);
      }
      pendingDt = 0;
    };
  }

  scene.add(group);

  return {
    setEnabled(on: boolean): void {
      enabled = on;
      group.visible = on;
      if (!on) {
        pendingDt = 0;
      }
    },
    tick(dtSec: number): void {
      if (!enabled || !group.visible || useStatic()) {
        pendingDt = 0;
        return;
      }
      pendingDt = dtSec;
    },
    setReducedMotion(on: boolean): void {
      reducedMotion = on;
      syncVisibility();
      if (useStatic()) {
        pendingDt = 0;
      }
    },
    destroy(): void {
      scene.remove(group);
      if (gpu) {
        disposeGpu(gpu);
      }
      disposeObject3D(group);
    },
  };
}

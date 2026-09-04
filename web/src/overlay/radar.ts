/**
 * The radar loop drawn as a sheet over the chart.
 *
 * The frames are colour-mapped pictures from NOAA, not values, so this layer
 * draws and animates them and deliberately offers nothing to the inspector —
 * there is no dBZ behind a pixel here to report.
 */
import * as THREE from 'three';
import { lonLatToLocal } from '../geo';
import type { RadarBlend, RadarSet } from './radarFrames';

/**
 * Height of the sheet above sea level, in metres.
 *
 * Deliberately not scaled by the exaggeration slider, for the same reason
 * aircraft are not: stretching the seafloor 50x must not fling the weather
 * into the far plane. High enough to clear the +113 m of land in this box.
 */
const SHEET_ALTITUDE = 1200;

/** Frames kept decoded on the GPU. A sweep is sequential, so LRU fits. */
const TEXTURE_BUDGET = 12;

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Crossfading two frames rather than cutting between them is what makes a
// five-minute scan interval read as motion instead of a slide show.
const FRAG = `
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uMix;
uniform float uOpacity;
uniform float uHasB;
varying vec2 vUv;
void main() {
  vec4 a = texture2D(uA, vUv);
  vec4 b = uHasB > 0.5 ? texture2D(uB, vUv) : a;
  vec4 c = mix(a, b, uMix);
  if (c.a < 0.02) discard;
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
}`;

export type RadarHandle = {
  setEnabled(on: boolean): void;
  /** Show the loop at a blend; a blend outside the loop hides the sheet. */
  show(set: RadarSet, blend: RadarBlend): void;
  setOpacity(v: number): void;
  destroy(): void;
};

export type RadarOptions = {
  /** Resolves a frame filename to a URL. */
  frameURL: (file: string) => string;
};

export function mountRadar(scene: THREE.Scene, set: RadarSet, opts: RadarOptions): RadarHandle {
  const sw = lonLatToLocal(set.bbox.west, set.bbox.south);
  const ne = lonLatToLocal(set.bbox.east, set.bbox.north);
  const width = ne.x - sw.x;
  const height = ne.y - sw.y;

  const geo = new THREE.PlaneGeometry(width, height);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;

  const uniforms = {
    uA: { value: blank as THREE.Texture },
    uB: { value: blank as THREE.Texture },
    uMix: { value: 0 },
    uOpacity: { value: 0.72 },
    uHasB: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    // The sheet floats over the terrain; writing depth would let it occlude
    // aircraft leaders and station glyphs that are legitimately above it.
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(sw.x + width / 2, sw.y + height / 2, SHEET_ALTITUDE);
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  const loader = new THREE.TextureLoader();
  const cache = new Map<string, THREE.Texture>();
  const pending = new Set<string>();
  let disposed = false;

  const touch = (file: string, tex: THREE.Texture): void => {
    // Map preserves insertion order, so re-inserting marks it most recent.
    cache.delete(file);
    cache.set(file, tex);
    while (cache.size > TEXTURE_BUDGET) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      cache.get(oldest)?.dispose();
      cache.delete(oldest);
    }
  };

  const textureFor = (file: string): THREE.Texture | null => {
    const hit = cache.get(file);
    if (hit) {
      touch(file, hit);
      return hit;
    }
    if (!pending.has(file)) {
      pending.add(file);
      loader.load(
        opts.frameURL(file),
        (tex) => {
          pending.delete(file);
          if (disposed) {
            tex.dispose();
            return;
          }
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          touch(file, tex);
        },
        undefined,
        () => {
          // A frame that will not load leaves a hole in the loop rather
          // than stalling it; the next tick simply shows its neighbour.
          pending.delete(file);
        },
      );
    }
    return null;
  };

  let enabled = false;

  const show = (s: RadarSet, blend: RadarBlend): void => {
    if (!enabled || !blend.inside) {
      mesh.visible = false;
      return;
    }
    const a = textureFor(s.files[blend.i0]!);
    if (!a) {
      // Nothing decoded yet for this instant. Drawing the previous frame
      // here would be showing one time under another.
      mesh.visible = false;
      return;
    }
    uniforms.uA.value = a;
    const bFile = s.files[blend.i1]!;
    const b = blend.i1 === blend.i0 ? null : textureFor(bFile);
    uniforms.uB.value = b ?? a;
    uniforms.uHasB.value = b ? 1 : 0;
    uniforms.uMix.value = b ? blend.mix : 0;
    mesh.visible = true;

    // Warm the next frame so a sweep does not blink at every step.
    const ahead = s.files[Math.min(blend.i1 + 1, s.files.length - 1)];
    if (ahead) {
      textureFor(ahead);
    }
  };

  return {
    setEnabled(on) {
      enabled = on;
      if (!on) {
        mesh.visible = false;
      }
    },
    show,
    setOpacity(v) {
      uniforms.uOpacity.value = v;
    },
    destroy() {
      disposed = true;
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      blank.dispose();
      for (const tex of cache.values()) {
        tex.dispose();
      }
      cache.clear();
    },
  };
}

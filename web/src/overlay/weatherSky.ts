/**
 * Clouds, cloud shadow, and rain.
 *
 * All three are *renderings of a forecast*, not observations. The cloud
 * shapes are procedural noise; what the NWS grid supplies is how much of the
 * sky is covered, how likely precipitation is, and which way the wind blows.
 * So the deck thickens where the forecast says overcast and drifts downwind
 * at the forecast speed, and rain falls where precipitation is forecast —
 * but no individual cloud here is a real cloud, and the About panel says so.
 */
import * as THREE from 'three';
import { lonLatToLocal } from '../geo';
import type { Cell, FieldStep, WeatherField } from './weatherField';

const CLOUD_ALTITUDE = 3400;
const SHADOW_ALTITUDE = 40;
const RAIN_COUNT = 24000;
/**
 * The rain volume is a box that follows the camera rather than covering the
 * AOI. Spread over the whole chart — 450 km across — twenty-four thousand
 * drops work out to one per five square kilometres, which is invisible at
 * every zoom. Sizing the box to the view instead keeps the density constant
 * on screen. Height is a fraction of that span for the same reason: a
 * physically-scaled 2 km column is a hairline from chart altitude.
 */
const RAIN_SPAN_FRACTION = 0.42;
/** Column height as a fraction of the box span; mirrored in RAIN_VERT. */
const RAIN_HEIGHT_FRACTION = 0.1;

/** Shared value noise + fbm, in the sheet's own uv space. */
const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}`;

const SHEET_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// uField: r = sky cover 0..1, g = precip probability 0..1, b/a = wind, and
// uMask marks cells the forecast had no value for so they stay empty rather
// than reading as clear sky.
const CLOUD_FRAG = `
uniform sampler2D uField;
uniform sampler2D uMask;
uniform float uTime;
uniform vec2 uDrift;
uniform float uOpacity;
uniform vec3 uColor;
uniform float uScale;
varying vec2 vUv;
${NOISE}
void main() {
  float known = texture2D(uMask, vUv).r;
  if (known < 0.5) discard;
  float cover = texture2D(uField, vUv).r;
  if (cover <= 0.01) discard;
  vec2 p = vUv * uScale + uDrift * uTime;
  float d = fbm(p);
  // Coverage raises the noise floor rather than scaling it, so an overcast
  // forecast fills in instead of merely brightening the same few puffs.
  float a = smoothstep(1.0 - cover * 0.85, 1.0 - cover * 0.25, d);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a * uOpacity);
}`;

const RAIN_VERT = `
#define RAIN_HEIGHT_FRACTION_JS ${RAIN_HEIGHT_FRACTION.toFixed(3)}
uniform sampler2D uField;
uniform sampler2D uMask;
uniform float uTime;
uniform vec2 uExtent;
uniform vec2 uOrigin;
uniform vec2 uFocus;
uniform float uSpan;
uniform vec2 uWind;
attribute float aSeed;
varying float vAlpha;
void main() {
  // position.xy is a unit cell; the drop is placed into the box currently
  // under the camera, so density stays constant however far out the chart is.
  float top = uSpan * RAIN_HEIGHT_FRACTION_JS;
  vec3 p;
  p.xy = uFocus + (position.xy - 0.5) * uSpan;
  float fall = top * (0.22 + aSeed * 0.12);
  float h = mod(position.z * top - uTime * fall, top);
  float fallen = top - h;
  p.z = h;
  // Wind shears the column. Scaled to the box so the lean reads the same at
  // every zoom rather than vanishing when the chart is pulled back.
  p.xy += uWind * (fallen / max(fall, 1.0)) * (uSpan / 40000.0);

  vec2 uv = (p.xy - uOrigin) / uExtent;
  float known = texture2D(uMask, uv).r;
  float pop = texture2D(uField, uv).g;
  // Below a coin-flip the forecast is not really calling for rain; drawing
  // drops there would turn "possible showers" into weather on the chart.
  vAlpha = known < 0.5 ? 0.0 : smoothstep(0.35, 0.8, pop);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) vAlpha = 0.0;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(1400.0 / -mv.z, 1.6, 5.0);
}`;

const RAIN_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  if (vAlpha < 0.02) discard;
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
}`;

export type WeatherSkyHandle = {
  setEnabled(on: boolean): void;
  /** Push the forecast field for the displayed instant. */
  update(field: WeatherField, step: FieldStep, tMs: number): void;
  /** Advance the drift/fall animation by real seconds. */
  tick(dtSec: number): void;
  /**
   * Put the rain volume under what the camera is looking at. `spanMetres` is
   * the width of the visible chart, so drop density stays constant on screen.
   */
  setFocus(x: number, y: number, spanMetres: number): void;
  setReducedMotion(on: boolean): void;
  destroy(): void;
};

function fillFieldTexture(
  field: WeatherField,
  step: FieldStep,
  data: Uint8Array,
  mask: Uint8Array,
): { windU: number; windV: number } {
  const n = field.nx * field.ny;
  let uSum = 0;
  let vSum = 0;
  let uCount = 0;
  const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
  const put = (c: Cell, i: number, scale: number): number => {
    const v = c[i];
    return v == null ? 0 : Math.round(clamp01(v / scale) * 255);
  };
  for (let i = 0; i < n; i++) {
    const known = step.sky[i] != null || step.pop[i] != null;
    mask[i] = known ? 255 : 0;
    data[i * 4 + 0] = put(step.sky, i, 100);
    data[i * 4 + 1] = put(step.pop, i, 100);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
    const wu = step.windU[i];
    const wv = step.windV[i];
    if (wu != null && wv != null) {
      uSum += wu;
      vSum += wv;
      uCount++;
    }
  }
  // One drift vector for the whole deck. Per-cell advection would need a
  // real flow solve; the honest simplification is the area mean, and the
  // About panel calls the cloud shapes procedural.
  return uCount === 0 ? { windU: 0, windV: 0 } : { windU: uSum / uCount, windV: vSum / uCount };
}

export function mountWeatherSky(scene: THREE.Scene, field: WeatherField): WeatherSkyHandle {
  const sw = lonLatToLocal(field.bbox.west, field.bbox.south);
  const ne = lonLatToLocal(field.bbox.east, field.bbox.north);
  const width = ne.x - sw.x;
  const height = ne.y - sw.y;
  const cx = sw.x + width / 2;
  const cy = sw.y + height / 2;

  const n = field.nx * field.ny;
  const fieldData = new Uint8Array(n * 4);
  const maskData = new Uint8Array(n);
  const fieldTex = new THREE.DataTexture(fieldData, field.nx, field.ny, THREE.RGBAFormat);
  fieldTex.minFilter = THREE.LinearFilter;
  fieldTex.magFilter = THREE.LinearFilter;
  fieldTex.wrapS = THREE.ClampToEdgeWrapping;
  fieldTex.wrapT = THREE.ClampToEdgeWrapping;
  const maskTex = new THREE.DataTexture(maskData, field.nx, field.ny, THREE.RedFormat);
  maskTex.minFilter = THREE.LinearFilter;
  maskTex.magFilter = THREE.LinearFilter;
  maskTex.wrapS = THREE.ClampToEdgeWrapping;
  maskTex.wrapT = THREE.ClampToEdgeWrapping;

  const group = new THREE.Group();
  group.name = 'weather-sky';
  group.visible = false;
  scene.add(group);

  const sheet = (altitude: number, color: number, opacity: number, scale: number): THREE.Mesh => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uField: { value: fieldTex },
        uMask: { value: maskTex },
        uTime: { value: 0 },
        uDrift: { value: new THREE.Vector2(0, 0) },
        uOpacity: { value: opacity },
        uColor: { value: new THREE.Color(color) },
        uScale: { value: scale },
      },
      vertexShader: SHEET_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    mesh.position.set(cx, cy, altitude);
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  // Deliberately light. This is a bathymetric chart with weather over it,
  // not a weather map: at full strength the deck buries the seafloor the
  // viewer exists to show.
  const clouds = sheet(CLOUD_ALTITUDE, 0xf2f0ea, 0.42, 7.0);
  clouds.renderOrder = 8;
  // The shadow is the same field one altitude down, dark and weaker: it is
  // what makes a passing deck read as passing *over* the water.
  const shadow = sheet(SHADOW_ALTITUDE, 0x0b2a3d, 0.17, 7.0);
  shadow.renderOrder = 4;

  const count = RAIN_COUNT;
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // A unit cell, not world metres: the shader places it under the camera.
    pos[i * 3 + 0] = Math.random();
    pos[i * 3 + 1] = Math.random();
    pos[i * 3 + 2] = Math.random();
    seed[i] = Math.random();
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const rainMat = new THREE.ShaderMaterial({
    uniforms: {
      uField: { value: fieldTex },
      uMask: { value: maskTex },
      uTime: { value: 0 },
      uExtent: { value: new THREE.Vector2(width, height) },
      uOrigin: { value: new THREE.Vector2(sw.x, sw.y) },
      uFocus: { value: new THREE.Vector2(cx, cy) },
      uSpan: { value: Math.max(width, height) * RAIN_SPAN_FRACTION },
      uWind: { value: new THREE.Vector2(0, 0) },
      uColor: { value: new THREE.Color(0xdce8f0) },
      uOpacity: { value: 0.72 },
    },
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const rain = new THREE.Points(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.renderOrder = 7;
  group.add(rain);

  let clock = 0;
  let reduced = false;
  const cloudMat = clouds.material as THREE.ShaderMaterial;
  const shadowMat = shadow.material as THREE.ShaderMaterial;

  return {
    setEnabled(on) {
      group.visible = on;
    },
    update(f, step) {
      const { windU, windV } = fillFieldTexture(f, step, fieldData, maskData);
      fieldTex.needsUpdate = true;
      maskTex.needsUpdate = true;
      // Drift is in uv per second, so it has to be divided by the box size;
      // the factor keeps a 10 m/s wind visible without looking like a gale.
      const dx = (windU / width) * 12;
      const dy = (windV / height) * 12;
      cloudMat.uniforms.uDrift.value.set(dx, dy);
      shadowMat.uniforms.uDrift.value.set(dx, dy);
      rainMat.uniforms.uWind.value.set(windU * 0.7, windV * 0.7);
    },
    setFocus(x, y, spanMetres) {
      rainMat.uniforms.uFocus.value.set(x, y);
      rainMat.uniforms.uSpan.value = Math.max(spanMetres, 1) * RAIN_SPAN_FRACTION;
    },
    tick(dtSec) {
      if (reduced) {
        return;
      }
      clock += dtSec;
      cloudMat.uniforms.uTime.value = clock;
      shadowMat.uniforms.uTime.value = clock;
      rainMat.uniforms.uTime.value = clock;
    },
    setReducedMotion(on) {
      reduced = on;
    },
    destroy() {
      scene.remove(group);
      clouds.geometry.dispose();
      cloudMat.dispose();
      shadow.geometry.dispose();
      shadowMat.dispose();
      rainGeo.dispose();
      rainMat.dispose();
      fieldTex.dispose();
      maskTex.dispose();
    },
  };
}

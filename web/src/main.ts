import './style.css';
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import {
  AOI,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  ORIGIN,
  lonLatToLocal,
  type BBox,
} from './geo';
import { createHypsometricLUT } from './lut';
import { QuadtreeLOD } from './terrain/QuadtreeLOD';
import type { SharedTerrainUniforms } from './terrain/TerrainTile';
import {
  CAMERA_MAX_POLAR,
  CAMERA_MIN_POLAR,
  DEFAULT_EXAGGERATION,
} from './viewerConfig';
import { addCoastOverlay } from './overlay/coast';
import {
  mountAbout,
  mountControls,
  mountNavHelp,
  setReadout,
  setStatus,
  sunDirection,
  type ViewerControls,
} from './ui/controls';
import { mountLabels } from './ui/labels';
import { mountLegend } from './ui/legend';
import { mountLocator } from './ui/locator';
import { mountGlobe, type GlobeHandle } from './globe/mountGlobe';

const DEFAULT_DEPTH_MIN = -30;
const DEFAULT_DEPTH_MAX = 4;
const DEPTH_LIMIT_MIN = -80;
const DEPTH_LIMIT_MAX = 12;
const DEFAULT_IMAGERY_OPACITY = 0.88;
const DEFAULT_CONTOUR_INTERVAL = 10;

type ManifestRegion = {
  id?: string;
  name?: string;
  bbox?: [number, number, number, number] | BBox;
  minZoom?: number;
  maxZoom?: number;
  encoding?: string;
  synthetic?: boolean;
};

type Manifest = {
  regions?: ManifestRegion[];
  region?: string;
  name?: string;
  minZoom?: number;
  maxZoom?: number;
  bbox?: BBox;
  encoding?: string;
  tiles?: boolean;
  tileCount?: number;
  synthetic?: boolean;
  dataVersion?: string;
};

function bboxFromManifest(raw: ManifestRegion['bbox'] | BBox | undefined): BBox | null {
  if (!raw) {
    return null;
  }
  if (Array.isArray(raw) && raw.length === 4) {
    return { west: raw[0], south: raw[1], east: raw[2], north: raw[3] };
  }
  if (!Array.isArray(raw) && typeof raw.west === 'number') {
    return raw;
  }
  return null;
}

function regionFromManifest(m: Manifest): ManifestRegion {
  return m.regions?.[0] ?? m;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function fetchManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch('/api/manifest');
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`#${id} is missing`);
  }
  return el as T;
}

function applySun(dir: THREE.Vector3, azimuth: number, altitude: number): void {
  const s = sunDirection(azimuth, altitude);
  dir.set(s.x, s.y, s.z).normalize();
}

function poseCamera(
  camera: THREE.PerspectiveCamera,
  controls: MapControls,
  animate: boolean,
): void {
  const origin = lonLatToLocal(ORIGIN.lon, ORIGIN.lat);
  const target = new THREE.Vector3(origin.x, origin.y, 0);
  const end = new THREE.Vector3(origin.x + 8_000, origin.y - 115_000, 48_000);

  controls.target.copy(target);
  if (!animate) {
    camera.position.copy(end);
    camera.lookAt(target);
    controls.update();
    return;
  }

  const start = new THREE.Vector3(origin.x + 4_000, origin.y - 55_000, 72_000);
  camera.position.copy(start);
  camera.lookAt(target);

  const duration = 1400;
  const t0 = performance.now();
  const tick = (now: number): void => {
    const u = Math.min(1, (now - t0) / duration);
    const s = u * u * (3 - 2 * u);
    camera.position.lerpVectors(start, end, s);
    controls.target.copy(target);
    controls.update();
    if (u < 1) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

function fitProjection(camera: THREE.PerspectiveCamera, controls: MapControls): void {
  const dist = camera.position.distanceTo(controls.target);
  camera.near = Math.max(20, dist / 800);
  camera.far = Math.max(400_000, dist * 20);
  camera.updateProjectionMatrix();
}

/** Keep the look-at on the AOI so pan cannot walk off the chart. */
function clampLookAt(
  camera: THREE.PerspectiveCamera,
  controls: MapControls,
  aoi: BBox,
): void {
  const sw = lonLatToLocal(aoi.west, aoi.south);
  const ne = lonLatToLocal(aoi.east, aoi.north);
  const t = controls.target;
  const nx = Math.min(ne.x, Math.max(sw.x, t.x));
  const ny = Math.min(ne.y, Math.max(sw.y, t.y));
  const dx = nx - t.x;
  const dy = ny - t.y;
  if (dx === 0 && dy === 0) {
    return;
  }
  t.x = nx;
  t.y = ny;
  camera.position.x += dx;
  camera.position.y += dy;
}

async function start(): Promise<void> {
  const canvas = requireEl<HTMLCanvasElement>('terrain');
  const globeRoot = requireEl<HTMLElement>('cesium');
  const app = requireEl<HTMLElement>('app');
  const statusEl = requireEl<HTMLElement>('status');
  const readoutEl = requireEl<HTMLElement>('readout');
  const regionEl = requireEl<HTMLElement>('region-line');
  const form = requireEl<HTMLFormElement>('controls');
  const about = requireEl<HTMLDialogElement>('about');
  const aboutToggle = requireEl<HTMLButtonElement>('about-toggle');
  const navHelp = requireEl<HTMLElement>('nav-help');
  const navHelpToggle = requireEl<HTMLButtonElement>('nav-help-toggle');
  const legendRoot = requireEl<HTMLElement>('legend');
  const locatorRoot = requireEl<HTMLElement>('locator');
  const labelsRoot = requireEl<HTMLElement>('geo-labels');
  const captionEl = requireEl<HTMLElement>('caption');
  const creditsEl = requireEl<HTMLElement>('credits');
  const modeField = requireEl<HTMLFieldSetElement>('view-mode');

  const reduced = prefersReducedMotion();
  const manifest = await fetchManifest();

  const regionInfo = manifest ? regionFromManifest(manifest) : {};
  const minZoom = regionInfo.minZoom ?? manifest?.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = regionInfo.maxZoom ?? manifest?.maxZoom ?? DEFAULT_MAX_ZOOM;
  const aoi = bboxFromManifest(regionInfo.bbox) ?? bboxFromManifest(manifest?.bbox) ?? AOI;
  const region = regionInfo.name ?? manifest?.region ?? manifest?.name ?? 'Mississippi Sound';
  const encoding = regionInfo.encoding ?? manifest?.encoding ?? 'Terrarium RGB';
  const synthetic = (regionInfo.synthetic ?? manifest?.synthetic) !== false;
  regionEl.textContent = synthetic
    ? `${region} · synthetic seed · ${encoding} · z ${minZoom}–${maxZoom}`
    : `${region} · ${encoding} · z ${minZoom}–${maxZoom}`;

  if (manifest?.tiles === false || manifest?.tileCount === 0) {
    setStatus(statusEl, 'No tiles on disk — run `make tiles`', true);
  }

  type ViewMode = 'globe' | 'bathymetry';
  let viewMode: ViewMode = 'bathymetry';
  let wantMode: ViewMode = 'bathymetry';
  let bathymetryRunning = true;
  let globe: GlobeHandle | null = null;
  let globeStarting = false;

  const lut = createHypsometricLUT();
  const sunDir = new THREE.Vector3();
  applySun(sunDir, 315, 38);

  const fogColor = new THREE.Color(0xb4c6cc);
  const shared: SharedTerrainUniforms = {
    uColorLUT: { value: lut },
    uSunDir: { value: sunDir },
    uContourInterval: { value: DEFAULT_CONTOUR_INTERVAL },
    uDepthMin: { value: DEFAULT_DEPTH_MIN },
    uDepthMax: { value: DEFAULT_DEPTH_MAX },
    uExaggeration: { value: DEFAULT_EXAGGERATION },
    uFogColor: { value: fogColor },
    uFogDensity: { value: 0.0000032 },
    uImageryOpacity: { value: 0 },
  };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setClearColor(0x9eb6be, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  THREE.Texture.DEFAULT_ANISOTROPY = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, canvas.clientWidth / canvas.clientHeight, 200, 1_200_000);
  camera.up.set(0, 0, 1);

  const controls = new MapControls(camera, canvas);
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 2_500;
  controls.maxDistance = 520_000;
  controls.minPolarAngle = CAMERA_MIN_POLAR;
  controls.maxPolarAngle = CAMERA_MAX_POLAR;
  controls.zoomToCursor = false;
  controls.listenToKeyEvents(canvas);
  canvas.addEventListener('pointerdown', () => {
    canvas.focus({ preventScroll: true });
  });
  poseCamera(camera, controls, !reduced);

  const lod = new QuadtreeLOD({
    scene,
    shared,
    aoi,
    minZoom,
    maxZoom,
    dataVersion: manifest?.dataVersion,
  });
  lod.setImageryOpacity(0);
  addCoastOverlay(scene);
  mountLocator(locatorRoot);
  const labels = mountLabels(labelsRoot);

  const setMode = (next: ViewMode): void => {
    viewMode = next;
    bathymetryRunning = next === 'bathymetry';
    app.classList.toggle('is-globe', next === 'globe');
    app.classList.toggle('is-bathymetry', next === 'bathymetry');
    const globeRadio = modeField.querySelector<HTMLInputElement>('input[name="view-mode"][value="globe"]');
    const bathyRadio = modeField.querySelector<HTMLInputElement>('input[name="view-mode"][value="bathymetry"]');
    if (globeRadio && bathyRadio) {
      globeRadio.checked = next === 'globe';
      bathyRadio.checked = next === 'bathymetry';
    }
    if (next === 'globe') {
      globe?.setActive(true);
      globe?.resize();
    } else {
      globe?.setActive(false);
      setReadout(readoutEl, null);
    }
    creditsEl.hidden = next !== 'globe' || Number(form.querySelector<HTMLInputElement>('input[name="imagery"]:checked')?.value) <= 0;
  };
  setMode(viewMode);

  const setCaption = (exag: number): void => {
    captionEl.textContent =
      viewMode === 'globe'
        ? `Globe · Mississippi Sound · Cesium · ${exag}× vertical`
        : `Looking north · Mississippi Sound · synthetic depths · ${exag}× vertical`;
  };
  setCaption(DEFAULT_EXAGGERATION);

  mountLegend({
    root: legendRoot,
    minLimit: DEPTH_LIMIT_MIN,
    maxLimit: DEPTH_LIMIT_MAX,
    initial: { min: DEFAULT_DEPTH_MIN, max: DEFAULT_DEPTH_MAX },
    onChange: (w) => {
      shared.uDepthMin.value = w.min;
      shared.uDepthMax.value = w.max;
    },
  });

  let exaggeration = DEFAULT_EXAGGERATION;
  mountControls(
    form,
    { exaggeration: DEFAULT_EXAGGERATION, contourInterval: DEFAULT_CONTOUR_INTERVAL, sunAzimuth: 315, sunAltitude: 38, imageryOpacity: DEFAULT_IMAGERY_OPACITY, currents: false, buoys: false },
    (state: ViewerControls) => {
      exaggeration = state.exaggeration;
      shared.uExaggeration.value = state.exaggeration;
      shared.uContourInterval.value = state.contourInterval;
      lod.setImageryOpacity(0);
      applySun(sunDir, state.sunAzimuth, state.sunAltitude);
      globe?.setExaggeration(state.exaggeration);
      globe?.setImageryOn(state.imageryOpacity > 0);
      globe?.setSun(state.sunAzimuth, state.sunAltitude);
      creditsEl.hidden = viewMode !== 'globe' || state.imageryOpacity <= 0;
      setCaption(state.exaggeration);
    },
  );

  mountNavHelp(navHelp, navHelpToggle);
  mountAbout(about, aboutToggle);

  let lodReady = false;
  const ensureBathymetry = async (): Promise<void> => {
    if (lodReady) {
      return;
    }
    setStatus(statusEl, 'Loading tiles…', false);
    await lod.bootstrap();
    lodReady = true;
    if (!lod.hasTiles()) {
      setStatus(statusEl, 'No tiles on disk — run `make tiles`', true);
    } else {
      setStatus(statusEl, null);
    }
  };

  const ensureGlobe = async (): Promise<boolean> => {
    if (globe) {
      return true;
    }
    if (globeStarting) {
      return false;
    }
    globeStarting = true;
    setStatus(statusEl, 'Loading globe…', false);
    try {
      globe = await mountGlobe(globeRoot, {
        aoi,
        minZoom,
        maxZoom,
        dataVersion: manifest?.dataVersion,
        exaggeration,
        imageryOn: Number(form.querySelector<HTMLInputElement>('input[name="imagery"]:checked')?.value) > 0,
        sunAzimuth: Number(form.querySelector<HTMLInputElement>('#sun-azimuth')?.value) || 315,
        sunAltitude: Number(form.querySelector<HTMLInputElement>('#sun-altitude')?.value) || 38,
        onPick: (sample) => {
          if (viewMode === 'globe') {
            setReadout(readoutEl, sample);
          }
        },
      });
      globe.setActive(viewMode === 'globe');
      setStatus(statusEl, null);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Globe failed to start';
      setStatus(statusEl, msg, true);
      return false;
    } finally {
      globeStarting = false;
    }
  };

  modeField.addEventListener('change', () => {
    const checked = modeField.querySelector<HTMLInputElement>('input[name="view-mode"]:checked');
    wantMode = checked?.value === 'globe' ? 'globe' : 'bathymetry';
    void (async () => {
      if (wantMode === 'bathymetry') {
        await ensureBathymetry();
        if (wantMode === 'bathymetry') {
          setMode('bathymetry');
          setCaption(exaggeration);
        }
        return;
      }
      const ok = await ensureGlobe();
      if (wantMode !== 'globe') {
        return;
      }
      if (!ok) {
        setMode('bathymetry');
        setCaption(exaggeration);
        return;
      }
      setMode('globe');
      setCaption(exaggeration);
    })();
  });

  await ensureBathymetry();

  const pointer = new THREE.Vector2(-2, -2);
  const raycaster = new THREE.Raycaster();
  let hovering = false;

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    hovering = true;
  });

  canvas.addEventListener('pointerleave', () => {
    hovering = false;
    setReadout(readoutEl, null);
  });

  const onResize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    globe?.resize();
  };
  window.addEventListener('resize', onResize);
  onResize();

  const tick = (): void => {
    requestAnimationFrame(tick);
    if (!bathymetryRunning) {
      return;
    }
    camera.up.set(0, 0, 1);
    controls.update();
    clampLookAt(camera, controls, aoi);
    fitProjection(camera, controls);
    lod.update(camera, canvas.clientHeight);
    labels.update(camera, exaggeration, canvas.clientWidth, canvas.clientHeight);

    if (hovering) {
      raycaster.setFromCamera(pointer, camera);
      setReadout(readoutEl, lod.pick(raycaster));
    }

    renderer.render(scene, camera);
  };
  tick();
}

void start().catch((err: unknown) => {
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.classList.add('is-warn');
    statusEl.textContent = err instanceof Error ? err.message : 'Viewer failed to start';
  }
});

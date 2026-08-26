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
  DEFAULT_DEPTH_MAX,
  DEFAULT_DEPTH_MIN,
  DEFAULT_EXAGGERATION,
} from './viewerConfig';
import { addCoastOverlay } from './overlay/coast';
import { detectFloatOk, mountCurrents, type CurrentsHandle } from './overlay/currents';
import { velocityGridFromJson } from './overlay/currentsField';
import { mountBuoys, parseBuoysJson, stationsOnChart, type BuoysHandle } from './overlay/buoys';
import { mountAircraft, parseAircraftJson, type AircraftHandle } from './overlay/aircraft';
import {
  aircraftAvailable,
  aircraftCaption,
  aircraftPollIntervalMs,
  deadReckon,
  shouldPollAircraft,
  shouldReprobeAircraft,
  type Aircraft,
} from './overlay/aircraftUi';
import { availabilityFromHttp, defaultOn, oceanCaption, unavailableOceanResponse } from './overlay/oceanUi';
import {
  mountAbout,
  mountControls,
  mountNavHelp,
  setReadout,
  setStatus,
  sunDirection,
  type ViewerControls,
} from './ui/controls';
import { mountLabels, screenProject } from './ui/labels';
import { mountLegend } from './ui/legend';
import { mountLocator } from './ui/locator';

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

async function fetchOk(url: string): Promise<Response> {
  try {
    return await fetch(url);
  } catch {
    return unavailableOceanResponse();
  }
}

function setOceanRadios(
  form: HTMLFormElement,
  name: 'currents' | 'buoys' | 'aircraft',
  avail: boolean,
  on: boolean,
): void {
  for (const input of form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    input.disabled = !avail;
  }
  const choice = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${on ? '1' : '0'}"]`);
  if (choice) {
    choice.checked = true;
  }
}

function oceanValidTime(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'validTime' in raw) {
    const t = (raw as { validTime: unknown }).validTime;
    return typeof t === 'string' && t !== '' ? t : null;
  }
  return null;
}

function hycomDatasetId(currentsRaw: unknown): string | null {
  if (currentsRaw && typeof currentsRaw === 'object' && 'source' in currentsRaw) {
    const dataset = (currentsRaw as { source?: { dataset?: unknown } }).source?.dataset;
    if (typeof dataset === 'string' && dataset !== '') {
      return dataset;
    }
  }
  return null;
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
  const end = new THREE.Vector3(origin.x + 12_000, origin.y - 175_000, 78_000);

  controls.target.copy(target);
  if (!animate) {
    camera.position.copy(end);
    camera.lookAt(target);
    controls.update();
    return;
  }

  const start = new THREE.Vector3(origin.x + 6_000, origin.y - 80_000, 110_000);
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
  const buoyMarks = requireEl<HTMLElement>('buoy-marks');
  const aircraftMarks = requireEl<HTMLElement>('aircraft-marks');
  const captionEl = requireEl<HTMLElement>('caption');

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

  const floatOk = detectFloatOk(renderer);
  const oceanFetches = Promise.all([
    fetchOk('/api/ocean/currents'),
    fetchOk('/api/ocean/buoys'),
  ]);

  let currentsHandle: CurrentsHandle | null = null;
  let buoysHandle: BuoysHandle | null = null;
  let aircraftHandle: AircraftHandle | null = null;
  let currentsValid: string | null = null;
  let buoysValid: string | null = null;
  let oceanOn = { currents: false, buoys: false };
  let aircraftOn = false;
  let aircraftAvailableStatus = false;
  let aircraftSource: string | null = null;
  let aircraftFetchedAt: string | null = null;
  let aircraftReport: { t: number; rows: Aircraft[] } | null = null;
  let aircraftTimer: number | undefined;
  let aircraftPrimed = false;
  setOceanRadios(form, 'currents', false, false);
  setOceanRadios(form, 'buoys', false, false);
  setOceanRadios(form, 'aircraft', false, false);
  buoyMarks.hidden = true;
  aircraftMarks.hidden = true;
  aircraftHandle = mountAircraft(aircraftMarks, aoi);
  aircraftHandle.setEnabled(false);

  const applyAircraftUnavailable = (): void => {
    aircraftAvailableStatus = false;
    aircraftOn = false;
    aircraftPrimed = true;
    aircraftSource = null;
    aircraftFetchedAt = null;
    aircraftReport = null;
    setOceanRadios(form, 'aircraft', false, false);
    aircraftHandle?.setAircraft([]);
    aircraftHandle?.setEnabled(false);
    aircraftMarks.hidden = true;
  };

  const aircraftPollOpts = (): {
    mode: 'globe' | 'bathymetry';
    layerOn: boolean;
    documentHidden: boolean;
    available: boolean;
    primed: boolean;
  } => ({
    mode: 'bathymetry',
    layerOn: aircraftOn,
    documentHidden: document.hidden,
    available: aircraftAvailableStatus,
    primed: aircraftPrimed,
  });

  const scheduleAircraftTimer = (): void => {
    if (aircraftTimer !== undefined) {
      window.clearInterval(aircraftTimer);
      aircraftTimer = undefined;
    }
    const opts = aircraftPollOpts();
    if (shouldPollAircraft(opts) || shouldReprobeAircraft(opts)) {
      aircraftTimer = window.setInterval(() => {
        void pullAircraft();
      }, aircraftPollIntervalMs(aircraftAvailableStatus));
    }
  };

  const pullAircraft = async (): Promise<void> => {
    try {
      const res = await fetchOk('/api/aircraft');
      if (!aircraftAvailable(res.status)) {
        applyAircraftUnavailable();
        setCaption(exaggeration);
        scheduleAircraftTimer();
        return;
      }
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
      const parsed = parseAircraftJson(raw);
      if (!parsed) {
        applyAircraftUnavailable();
        setCaption(exaggeration);
        scheduleAircraftTimer();
        return;
      }
      const recovering = !aircraftAvailableStatus;
      aircraftAvailableStatus = true;
      if (!aircraftPrimed || recovering) {
        aircraftOn = true;
        aircraftPrimed = true;
      }
      setOceanRadios(form, 'aircraft', true, aircraftOn);
      aircraftSource = parsed.source;
      aircraftFetchedAt = parsed.fetchedAt;
      aircraftReport = { t: performance.now(), rows: parsed.aircraft };
      aircraftHandle?.setAircraft(parsed.aircraft);
      const show = aircraftOn;
      aircraftHandle?.setEnabled(show);
      aircraftMarks.hidden = !show;
      setCaption(exaggeration);
      scheduleAircraftTimer();
    } catch {
      applyAircraftUnavailable();
      setCaption(exaggeration);
      scheduleAircraftTimer();
    }
  };

  const restartAircraftPoll = (): void => {
    if (aircraftTimer !== undefined) {
      window.clearInterval(aircraftTimer);
      aircraftTimer = undefined;
    }
    const opts = aircraftPollOpts();
    if (shouldPollAircraft(opts) || shouldReprobeAircraft(opts)) {
      void pullAircraft();
    }
  };
  document.addEventListener('visibilitychange', restartAircraftPoll);

  const setCaption = (exag: number): void => {
    const base = `Looking north · Mississippi Sound · synthetic depths · ${exag}× vertical`;
    const ocean = oceanCaption(
      oceanOn.currents ? currentsValid : null,
      oceanOn.buoys ? buoysValid : null,
    );
    const air = aircraftOn ? aircraftCaption(aircraftSource, aircraftFetchedAt) : '';
    const parts = [base];
    if (ocean) {
      parts.push(ocean);
    }
    if (air) {
      parts.push(air);
    }
    captionEl.textContent = parts.join(' · ');
  };
  setCaption(DEFAULT_EXAGGERATION);

  mountLegend({
    root: legendRoot,
    min: DEFAULT_DEPTH_MIN,
    max: DEFAULT_DEPTH_MAX,
  });

  let exaggeration = DEFAULT_EXAGGERATION;
  mountControls(
    form,
    {
      exaggeration: DEFAULT_EXAGGERATION,
      contourInterval: DEFAULT_CONTOUR_INTERVAL,
      sunAzimuth: 315,
      sunAltitude: 38,
      currents: oceanOn.currents,
      buoys: oceanOn.buoys,
      aircraft: false,
    },
    (state: ViewerControls) => {
      exaggeration = state.exaggeration;
      shared.uExaggeration.value = state.exaggeration;
      shared.uContourInterval.value = state.contourInterval;
      lod.setImageryOpacity(0);
      applySun(sunDir, state.sunAzimuth, state.sunAltitude);
      oceanOn = { currents: state.currents, buoys: state.buoys };
      const aircraftWasOn = aircraftOn;
      aircraftOn = state.aircraft;
      currentsHandle?.setEnabled(state.currents);
      if (buoysHandle) {
        buoyMarks.hidden = !state.buoys;
        buoysHandle.setEnabled(state.buoys);
      }
      if (aircraftHandle) {
        aircraftMarks.hidden = !state.aircraft;
        aircraftHandle.setEnabled(state.aircraft);
      }
      if (aircraftWasOn !== aircraftOn) {
        restartAircraftPoll();
      }
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

  void (async () => {
    const [currentsRes, buoysRes] = await oceanFetches;
    const httpAvail = availabilityFromHttp(currentsRes.status, buoysRes.status);
    let currentsRaw: unknown = null;
    let buoysRaw: unknown = null;
    if (httpAvail.currents) {
      try {
        currentsRaw = await currentsRes.json();
      } catch {
        currentsRaw = null;
      }
    }
    if (httpAvail.buoys) {
      try {
        buoysRaw = await buoysRes.json();
      } catch {
        buoysRaw = null;
      }
    }
    const grid = velocityGridFromJson(currentsRaw);
    const buoysParsed = parseBuoysJson(buoysRaw);
    const avail = { currents: grid != null, buoys: buoysParsed != null };
    const layersOn = defaultOn(avail);
    setOceanRadios(form, 'currents', avail.currents, layersOn.currents);
    setOceanRadios(form, 'buoys', avail.buoys, layersOn.buoys);

    if (grid) {
      currentsHandle = mountCurrents(scene, grid, { reducedMotion: reduced, floatOk });
      currentsHandle.setEnabled(layersOn.currents);
    }
    if (buoysParsed) {
      buoysHandle = mountBuoys(buoyMarks, stationsOnChart(buoysParsed.stations, aoi), aoi);
      buoysHandle.setEnabled(layersOn.buoys);
      buoyMarks.hidden = !layersOn.buoys;
    } else {
      buoyMarks.hidden = true;
    }

    currentsValid = grid ? oceanValidTime(currentsRaw) : null;
    buoysValid = buoysParsed?.validTime ?? null;
    const datasetId = hycomDatasetId(currentsRaw);
    if (datasetId) {
      const dsEl = document.getElementById('hycom-dataset');
      if (dsEl) {
        dsEl.textContent = datasetId;
      }
    }
    oceanOn = { currents: layersOn.currents, buoys: layersOn.buoys };
    setCaption(exaggeration);
  })();

  void pullAircraft();

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
  };
  window.addEventListener('resize', onResize);
  onResize();

  const clock = new THREE.Clock();
  const overlayScratch = new THREE.Vector3();
  const tick = (): void => {
    requestAnimationFrame(tick);
    camera.up.set(0, 0, 1);
    controls.update();
    clampLookAt(camera, controls, aoi);
    fitProjection(camera, controls);
    lod.update(camera, canvas.clientHeight);

    camera.updateMatrixWorld();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    labels.update(camera, exaggeration, w, h);
    const overlayProject = screenProject(camera, exaggeration, w, h, overlayScratch, 18);
    if (oceanOn.buoys && buoysHandle) {
      buoysHandle.layout(overlayProject, w, h, labels.placeCandidates());
    }
    if (aircraftOn && aircraftHandle) {
      if (aircraftReport) {
        const dt = reduced ? 0 : (performance.now() - aircraftReport.t) / 1000;
        aircraftHandle.setAircraft(
          aircraftReport.rows.map((row) => {
            const pos = deadReckon(row, dt);
            return { ...row, lon: pos.lon, lat: pos.lat };
          }),
        );
      }
      const extra = [...labels.placeCandidates()];
      if (oceanOn.buoys && buoysHandle) {
        extra.push(...buoysHandle.candidates(overlayProject, w, h));
      }
      aircraftHandle.layout(overlayProject, w, h, extra);
    }

    currentsHandle?.tick(clock.getDelta());

    if (hovering && readoutEl.dataset.buoy !== '1' && readoutEl.dataset.aircraft !== '1') {
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

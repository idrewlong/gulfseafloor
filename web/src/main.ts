import './style.css';
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import {
  AOI,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  localToLonLat,
  lonLatToLocal,
  type BBox,
} from './geo';
import {
  clampToFootprint,
  coverDistance,
  maxPolarForCoverage,
  viewFootprint,
  type Extent,
} from './cameraFrame';
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
import { velocityStackFromJson, type VelocityStack } from './overlay/currentsField';
import { interpolateGrid } from './overlay/currentsTime';
import { mountBuoys, parseBuoysJson, stationsOnChart, type BuoysHandle } from './overlay/buoys';
import { mountAircraft, type AircraftHandle } from './overlay/aircraft';
import { createAircraftLayer } from './overlay/aircraftLayer';
import { mountRadar, type RadarHandle } from './overlay/radar';
import { blendAt, parseRadarJson, radarSpan, type RadarSet } from './overlay/radarFrames';
import { mountWeatherSky, type WeatherSkyHandle } from './overlay/weatherSky';
import {
  fieldAt,
  forecastSpan,
  parseForecastJson,
  type WeatherField,
} from './overlay/weatherField';
import { dailyOutlook, parsePeriods } from './ui/outlook';
import { aircraftCaption } from './overlay/aircraftUi';
import {
  availabilityFromHttp,
  currentsCaption,
  defaultOn,
  formatValidZ,
  unavailableOceanResponse,
} from './overlay/oceanUi';
import { speedLegendTicks, speedRampCss } from './overlay/speedRamp';
import { createPoller, type LoadResult } from './overlay/poller';
import {
  decodeViewState,
  encodeViewState,
  type LayerName,
  type ViewState,
} from './viewState';
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
import { mountLegend, setLegendUnit } from './ui/legend';
import { mountInspector, setInspectorUnit } from './ui/inspector';
import { loadDepthUnit, saveDepthUnit } from './ui/units';
import { mountTimeline, type TimelineHandle } from './ui/timeline';
import { covers, createAxis, register, scrubTo, unregister } from './time/axis';

const DEFAULT_CONTOUR_INTERVAL = 10;

/** Opening sun position: north-west and fairly low, the chart convention. */
const DEFAULT_SUN_AZIMUTH = 315;
const DEFAULT_SUN_ALTITUDE = 38;

/**
 * Aircraft are drawn at true altitude — metres above sea level, 1:1 with the
 * chart's horizontal scale. The exaggeration slider deliberately does not
 * reach them: at 50x a 45,000 ft airliner would sit 685 km up, outside the
 * far plane, and a 600 ft helicopter would fly at 9 km. The seafloor is what
 * gets stretched; the sky stays honest.
 */
const AIRCRAFT_ALTITUDE_SCALE = 1;

/**
 * The intro zooms out to the covering distance from a little closer in. It
 * never starts further out than that: the chart has to fill the frame the
 * whole way, or the opening shot shows its edges.
 */
const INTRO_PUSH_IN = 0.78;

type ManifestRegion = {
  id?: string;
  name?: string;
  bbox?: [number, number, number, number] | BBox;
  minZoom?: number;
  maxZoom?: number;
  encoding?: string;
  synthetic?: boolean;
  depthSource?: string;
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
  depthSource?: string;
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

/**
 * Why a layer has nothing behind it, named per layer.
 *
 * A disabled checkbox with no explanation is the same to the reader whether
 * the server was built without the layer, the snapshot has not been seeded,
 * or an upstream is down. Each of those has a different fix, and the About
 * dialog explains all three — but the control itself said nothing, so there
 * was no way to tell which one applied.
 */
const LAYER_UNAVAILABLE: Record<LayerName, string> = {
  radar: 'No radar loop on this server. Seed one with `make weather`, or it is disabled by GULF_WEATHER_REFRESH=0.',
  sky: 'No gridded forecast on this server. Seed one with `make weather`, or it is disabled by GULF_WEATHER_REFRESH=0.',
  currents: 'No HYCOM snapshot on this server. Seed one with `make ocean`, or it is disabled by GULF_OCEAN_REFRESH=0.',
  buoys: 'No NDBC snapshot on this server. Seed one with `make ocean`, or it is disabled by GULF_OCEAN_REFRESH=0.',
  aircraft: 'Live ADS-B is unavailable — disabled by GULF_AIRCRAFT=0, or the upstream feed is not answering.',
};

// A layer the server has nothing for is disabled rather than hidden, so the
// panel still says the layer exists and simply has no data behind it — and
// now says why, on the control rather than only in the About dialog.
function setLayerToggle(
  form: HTMLFormElement,
  name: LayerName,
  avail: boolean,
  on: boolean,
): void {
  const box = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!box) {
    return;
  }
  box.disabled = !avail;
  box.checked = on;

  // The reason goes on the label as well as the input: the input is a 13px
  // box, and the label is what a pointer actually lands on.
  const label = box.closest('label');
  const reason = avail ? '' : LAYER_UNAVAILABLE[name];
  box.title = reason;
  if (label) {
    label.title = reason;
  }

  // Screen readers do not announce `title` reliably, so the same sentence is
  // carried in a hidden note the input points at. It is removed when the
  // layer comes back, rather than left describing a control that now works.
  const noteId = `layer-note-${name}`;
  let note = form.querySelector<HTMLElement>(`#${noteId}`);
  if (avail) {
    note?.remove();
    box.removeAttribute('aria-describedby');
    return;
  }
  if (!note) {
    note = document.createElement('span');
    note.id = noteId;
    note.className = 'visually-hidden';
    label?.append(note);
  }
  note.textContent = reason;
  box.setAttribute('aria-describedby', noteId);
}

type GridShape = { nx: number; ny: number; bbox: BBox };

function gridShapeOf(grid: { nx: number; ny: number; bbox: BBox }): GridShape {
  return { nx: grid.nx, ny: grid.ny, bbox: grid.bbox };
}

/** True when a polled stack can reuse the mounted GPU grid via setGrid. */
function sameGridShape(a: GridShape | null, b: GridShape): boolean {
  if (a == null) {
    return false;
  }
  return (
    a.nx === b.nx &&
    a.ny === b.ny &&
    a.bbox.west === b.bbox.west &&
    a.bbox.south === b.bbox.south &&
    a.bbox.east === b.bbox.east &&
    a.bbox.north === b.bbox.north
  );
}

function currentsLegendHtml(): string {
  return `
    <p class="legend-title">Current speed (kt)</p>
    <div class="legend-ramp" style="background: ${speedRampCss()};"></div>
    <ul class="legend-ticks">${speedLegendTicks()
      .map((tick) => `<li>${tick.label}</li>`)
      .join('')}</ul>
  `;
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

/** Local-plane box the chart occupies. */
function aoiExtent(aoi: BBox): Extent {
  const sw = lonLatToLocal(aoi.west, aoi.south);
  const ne = lonLatToLocal(aoi.east, aoi.north);
  return { minX: sw.x, minY: sw.y, maxX: ne.x, maxY: ne.y };
}

/** Distance at which the chart covers the viewport with no edge showing. */
function chartCover(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  extent: Extent,
): number {
  return coverDistance({
    extent,
    fovDeg: camera.fov,
    viewportWidth: canvas.clientWidth,
    viewportHeight: canvas.clientHeight,
  });
}

/**
 * Open dead top-down on the fitted chart. Resolves once the intro settles.
 *
 * `at` restores a shared view: a URL carrying a camera skips the intro sweep
 * and lands on the pose it names. Someone following a link wants the view
 * they were sent, not a fly-in to it.
 */
function poseCamera(
  camera: THREE.PerspectiveCamera,
  controls: MapControls,
  extent: Extent,
  cover: number,
  animate: boolean,
  at?: { x: number; y: number; dist: number } | null,
): Promise<void> {
  if (at) {
    const target = new THREE.Vector3(at.x, at.y, 0);
    controls.target.copy(target);
    camera.position.set(at.x, at.y, Math.min(at.dist, cover));
    camera.lookAt(target);
    controls.update();
    return Promise.resolve();
  }
  const cx = (extent.minX + extent.maxX) / 2;
  const cy = (extent.minY + extent.maxY) / 2;
  const target = new THREE.Vector3(cx, cy, 0);
  const end = new THREE.Vector3(cx, cy, cover);

  controls.target.copy(target);
  if (!animate) {
    camera.position.copy(end);
    camera.lookAt(target);
    controls.update();
    return Promise.resolve();
  }

  const from = new THREE.Vector3(cx, cy, cover * INTRO_PUSH_IN);
  camera.position.copy(from);
  camera.lookAt(target);

  return new Promise((resolve) => {
    const duration = 1400;
    const t0 = performance.now();
    const step = (now: number): void => {
      const u = Math.min(1, (now - t0) / duration);
      const s = u * u * (3 - 2 * u);
      camera.position.lerpVectors(from, end, s);
      controls.target.copy(target);
      controls.update();
      if (u < 1) {
        requestAnimationFrame(step);
        return;
      }
      resolve();
    };
    requestAnimationFrame(step);
  });
}

function fitProjection(camera: THREE.PerspectiveCamera, controls: MapControls): void {
  const dist = camera.position.distanceTo(controls.target);
  camera.near = Math.max(20, dist / 800);
  camera.far = Math.max(400_000, dist * 20);
  camera.updateProjectionMatrix();
}

const forwardScratch = new THREE.Vector3();

/**
 * Keep the chart under every pixel of the view. Clamping the look-at alone is
 * not enough — it lets the reader pan until the edge sits mid-screen with void
 * beyond it — so this clamps the ground footprint of the view instead.
 */
function clampChart(
  camera: THREE.PerspectiveCamera,
  controls: MapControls,
  extent: Extent,
): void {
  camera.getWorldDirection(forwardScratch);
  const footprint = viewFootprint({
    distance: camera.position.distanceTo(controls.target),
    fovDeg: camera.fov,
    aspect: camera.aspect,
    polar: controls.getPolarAngle(),
    azimuth: Math.atan2(forwardScratch.x, forwardScratch.y),
  });
  const t = controls.target;
  const next = clampToFootprint({ x: t.x, y: t.y }, extent, footprint);
  const dx = next.x - t.x;
  const dy = next.y - t.y;
  if (dx === 0 && dy === 0) {
    return;
  }
  t.x = next.x;
  t.y = next.y;
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
  const currentsLegend = requireEl<HTMLElement>('currents-legend');
  const labelsRoot = requireEl<HTMLElement>('geo-labels');
  const buoyMarks = requireEl<HTMLElement>('buoy-marks');
  const aircraftMarks = requireEl<HTMLElement>('aircraft-marks');
  const captionEl = requireEl<HTMLElement>('caption');
  const timelineRoot = requireEl<HTMLElement>('timeline');

  const reduced = prefersReducedMotion();
  // Read once, at boot. Everything below treats this as the reader's
  // intent where it supplies a value, and falls back to the built-in
  // default where it does not.
  const shared0 = decodeViewState(window.location.hash);
  const manifest = await fetchManifest();

  const regionInfo = manifest ? regionFromManifest(manifest) : {};
  const minZoom = regionInfo.minZoom ?? manifest?.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = regionInfo.maxZoom ?? manifest?.maxZoom ?? DEFAULT_MAX_ZOOM;
  const aoi = bboxFromManifest(regionInfo.bbox) ?? bboxFromManifest(manifest?.bbox) ?? AOI;
  const region = regionInfo.name ?? manifest?.region ?? manifest?.name ?? 'North-Central Gulf';
  const encoding = regionInfo.encoding ?? manifest?.encoding ?? 'terrain-rgb';
  const synthetic = (regionInfo.synthetic ?? manifest?.synthetic) !== false;
  // Cite the grid the tiles were actually cut from rather than a literal, so
  // the caption cannot drift from the heightfield the server built.
  const depthSource = regionInfo.depthSource ?? manifest?.depthSource ?? 'synthetic depths';
  regionEl.textContent = synthetic
    ? `${region} · synthetic seed · ${encoding} · z ${minZoom}–${maxZoom}`
    : `${region} · ${encoding} · z ${minZoom}–${maxZoom}`;

  if (manifest?.tiles === false || manifest?.tileCount === 0) {
    setStatus(statusEl, 'No tiles on disk — run `make tiles`', true);
  }

  const lut = createHypsometricLUT();
  const sunDir = new THREE.Vector3();
  applySun(sunDir, DEFAULT_SUN_AZIMUTH, DEFAULT_SUN_ALTITUDE);

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

  const extent = aoiExtent(aoi);
  let coverDist = chartCover(camera, canvas, extent);

  const controls = new MapControls(camera, canvas);
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 2_500;
  // Zoom-out stops where the chart still covers the frame; tilt starts locked
  // and the frame loop widens it as the reader zooms in.
  controls.maxDistance = coverDist;
  controls.minPolarAngle = CAMERA_MIN_POLAR;
  controls.maxPolarAngle = CAMERA_MIN_POLAR;
  // North stays up. Azimuth 0 puts the camera due south of the look-at, which
  // is the pose the labels and the "looking north" caption assume.
  controls.minAzimuthAngle = 0;
  controls.maxAzimuthAngle = 0;
  controls.zoomToCursor = false;
  controls.listenToKeyEvents(canvas);
  canvas.addEventListener('pointerdown', () => {
    canvas.focus({ preventScroll: true });
  });

  // A shared link lands on its pose directly; only a fresh visit gets the
  // intro sweep.
  const sharedPose =
    shared0.lon != null && shared0.lat != null && shared0.dist != null
      ? { ...lonLatToLocal(shared0.lon, shared0.lat), dist: shared0.dist }
      : null;
  if (shared0.polar != null) {
    const polar = (shared0.polar * Math.PI) / 180;
    controls.minPolarAngle = polar;
    controls.maxPolarAngle = polar;
  }

  let framed = false;
  void poseCamera(camera, controls, extent, coverDist, !reduced, sharedPose).then(() => {
    framed = true;
    controls.maxDistance = coverDist;
    // Hand tilt back to the frame loop, which widens the ceiling as the
    // reader zooms in. Restoring a shared tilt above pinned it.
    controls.minPolarAngle = CAMERA_MIN_POLAR;
  });

  const lod = new QuadtreeLOD({
    scene,
    shared,
    aoi,
    minZoom,
    maxZoom,
    dataVersion: manifest?.dataVersion,
  });
  addCoastOverlay(scene);
  const labels = mountLabels(labelsRoot);

  const floatOk = detectFloatOk(renderer);
  const oceanFetches = Promise.all([
    fetchOk('/api/ocean/currents'),
    fetchOk('/api/ocean/buoys'),
  ]);

  let currentsHandle: CurrentsHandle | null = null;
  let buoysHandle: BuoysHandle | null = null;
  let aircraftHandle: AircraftHandle | null = null;

  /**
   * The clock every layer reads, quantised to the second.
   *
   * Quantising matters: while the axis is live its head is re-pinned to this
   * value every frame, and a millisecond-resolution clock would make the head
   * change sixty times a second, waking every subscriber to rebuild captions
   * for a time nobody can read that finely.
   */
  const now = (): number => Math.floor(Date.now() / 1000) * 1000;
  const axis = createAxis(now());
  // A shared link that names a time must come off live, or the timeline's
  // own tick re-pins the head to the wall clock on the next frame and the
  // restored moment is gone before it is ever drawn.
  if (shared0.timeMs != null) {
    const at = shared0.timeMs;
    axis.update((st) => scrubTo(st, at));
  }
  let timeline: TimelineHandle | null = null;
  // The time cursor (repaint the field toward "now") and the ETag poll (fetch
  // a fresh forecast stack) are deliberately separate cadences.
  const CURRENTS_POLL_MS = 15 * 60 * 1000;
  const BUOYS_POLL_MS = 5 * 60 * 1000;
  const CURSOR_MS = 30 * 1000;
  // Real-time floor on field repaints. The cursor throttle above is measured
  // in displayed time, which one frame of a play sweep crosses in a stride.
  const PAINT_MIN_MS = 100;
  // How long an observation speaks for: NDBC's own reporting cadence, and
  // ADS-B's. Outside it the layer drops off the chart rather than being drawn
  // under a timestamp it cannot support.
  const BUOY_STALE_MS = 60 * 60 * 1000;
  const AIRCRAFT_STALE_MS = 60 * 1000;
  let skyHandle: WeatherSkyHandle | null = null;
  let weatherField: WeatherField | null = null;
  let skyOn = false;
  const FORECAST_POLL_MS = 30 * 60 * 1000;
  let radarHandle: RadarHandle | null = null;
  let radarSet: RadarSet | null = null;
  let radarOn = false;
  /** Whether the first radar manifest has landed and set the toggle once. */
  let radarPrimed = false;
  const RADAR_POLL_MS = 5 * 60 * 1000;
  let currentsStack: VelocityStack | null = null;
  let currentsEtag: string | null = null;
  let lastPaintedHead = Number.NEGATIVE_INFINITY;
  let lastPaintReal = 0;
  // Shape currentsHandle is currently mounted at. setGrid re-uploads in
  // place assuming nx/ny/bbox never change; a polled stack that disagrees
  // must remount instead (F6) rather than write past the GPU buffer.
  let currentsGridShape: GridShape | null = null;
  let buoysValid: string | null = null;
  let buoysEtag: string | null = null;
  let oceanOn = { currents: false, buoys: false };
  setLayerToggle(form, 'currents', false, false);
  setLayerToggle(form, 'buoys', false, false);
  setLayerToggle(form, 'aircraft', false, false);
  buoyMarks.hidden = true;
  aircraftMarks.hidden = true;
  aircraftHandle = mountAircraft(aircraftMarks, aoi);
  aircraftHandle.setEnabled(false);

  // The shading dials, seeded from the URL where it supplies them.
  //
  // Declared before any layer that can fire a callback: the aircraft layer
  // below registers a visibilitychange listener at construction, and that
  // path reaches setCaption(exaggeration). A tab switch during the first few
  // milliseconds of startup would otherwise hit the temporal dead zone.
  const initialExaggeration = shared0.exaggeration ?? DEFAULT_EXAGGERATION;
  const initialContour = shared0.contourInterval ?? DEFAULT_CONTOUR_INTERVAL;
  const initialSunAz = shared0.sunAzimuth ?? DEFAULT_SUN_AZIMUTH;
  const initialSunAlt = shared0.sunAltitude ?? DEFAULT_SUN_ALTITUDE;

  let exaggeration = initialExaggeration;
  // The sun is applied straight into a normalised direction vector, which
  // cannot be inverted back to a bearing, so the two dials are kept here for
  // the URL to read.
  let currentSunAzimuth = initialSunAz;
  let currentSunAltitude = initialSunAlt;
  shared.uExaggeration.value = initialExaggeration;
  shared.uContourInterval.value = initialContour;
  applySun(sunDir, initialSunAz, initialSunAlt);

  const aircraft = createAircraftLayer({
    fetchOk,
    setAircraft: (rows) => aircraftHandle?.setAircraft(rows),
    setEnabled: (isOn) => {
      aircraftHandle?.setEnabled(isOn);
      aircraftMarks.hidden = !isOn;
    },
    setToggle: (avail, isOn) => setLayerToggle(form, 'aircraft', avail, isOn),
    declare: (at) => registerInstant('aircraft', 'Aircraft', at, AIRCRAFT_STALE_MS),
    withdraw: () => axis.update((st) => unregister(st, 'aircraft')),
    onChange: () => {
      applyLayerVisibility();
      setCaption(exaggeration);
    },
    initiallyOn: shared0.layers?.aircraft ?? true,
  });

  /** Declare the forecast window the loaded stack can speak for. */
  const registerCurrents = (stack: VelocityStack | null): void => {
    if (!stack || stack.times.length === 0) {
      return;
    }
    axis.update((st) =>
      register(st, {
        id: 'currents',
        label: 'Currents',
        kind: 'span',
        t0: stack.times[0]!,
        t1: stack.times[stack.times.length - 1]!,
      }),
    );
  };

  /** Declare an observation instant. Ignores an unparseable timestamp. */
  const registerInstant = (id: string, label: string, iso: string | null, staleAfterMs: number): void => {
    if (iso == null) {
      return;
    }
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) {
      return;
    }
    axis.update((st) => register(st, { id, label, kind: 'instant', t0: t, t1: t, staleAfterMs }));
  };

  /**
   * A layer draws when the viewer asked for it *and* the axis head is inside
   * the window that layer declared. Scrubbing past a layer's data hides it
   * rather than holding the last frame under a timestamp it cannot support.
   */
  const layerShown = (id: string): boolean => {
    const st = axis.state();
    return covers(st.coverage, id, st.headMs);
  };

  const applyLayerVisibility = (): void => {
    if (radarHandle && radarSet) {
      radarHandle.setEnabled(radarOn);
      radarHandle.show(radarSet, blendAt(radarSet, axis.head(), RADAR_GRACE_MS));
    }
    if (skyHandle && weatherField) {
      const show = skyOn && layerShown('forecast');
      skyHandle.setEnabled(show);
      if (show) {
        skyHandle.update(weatherField, fieldAt(weatherField, axis.head()), axis.head());
      }
    }
    const showCurrents = oceanOn.currents && layerShown('currents');
    currentsHandle?.setEnabled(showCurrents);
    currentsLegend.hidden = !showCurrents;
    if (buoysHandle) {
      const show = oceanOn.buoys && layerShown('buoys');
      buoysHandle.setEnabled(show);
      buoyMarks.hidden = !show;
    }
    if (aircraftHandle) {
      const show = aircraft.on() && layerShown('aircraft');
      aircraftHandle.setEnabled(show);
      aircraftMarks.hidden = !show;
    }
  };

  const setCaption = (exag: number): void => {
    const base = `Looking north · ${region} · ${depthSource} · ${exag}× vertical`;
    const headMs = axis.head();
    // A layer outside its window contributes nothing to the caption: naming a
    // bracketing forecast hour for a time the stack does not reach would put a
    // timestamp on data that is not there.
    const showCurrents = oceanOn.currents && layerShown('currents');
    const currentsPart = currentsCaption(showCurrents ? currentsStack : null, headMs);
    const showBuoys = oceanOn.buoys && layerShown('buoys');
    const buoysPart = showBuoys && buoysValid ? `Buoys NDBC ${formatValidZ(buoysValid)}` : '';
    // Radar frames are observations minutes old by the time they arrive.
    // Naming the scan is the difference between showing the latest picture
    // and implying it is the present one.
    let radarPart = '';
    if (radarOn && radarSet && layerShown('radar')) {
      const b = blendAt(radarSet, headMs, RADAR_GRACE_MS);
      if (b.inside) {
        const scan = radarSet.times[b.i0]!;
        const ageMin = Math.max(0, Math.round((headMs - scan) / 60000));
        radarPart = `Radar NOAA ${formatValidZ(new Date(scan).toISOString())}`;
        if (ageMin >= 1) {
          radarPart += ` (${ageMin} min old)`;
        }
      }
    }
    const ocean = [radarPart, currentsPart, buoysPart].filter(Boolean).join(' · ');
    const air =
      aircraft.on() && layerShown('aircraft')
        ? aircraftCaption(aircraft.source(), aircraft.fetchedAt())
        : '';
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

  /**
   * Re-upload the velocity field for the current head.
   *
   * Two throttles, because the head moves for two different reasons. Live, it
   * tracks the wall clock, and CURSOR_MS keeps that to one repaint every
   * thirty seconds — the cadence this viewer has always used. Under a scrub or
   * a play sweep the head can cross hours in one frame, so PAINT_MIN_MS caps
   * the GPU uploads in real time as well.
   */
  const repaintField = (): void => {
    if (!currentsStack || !currentsHandle) {
      return;
    }
    const headMs = axis.head();
    const real = performance.now();
    if (Math.abs(headMs - lastPaintedHead) < CURSOR_MS || real - lastPaintReal < PAINT_MIN_MS) {
      return;
    }
    lastPaintedHead = headMs;
    lastPaintReal = real;
    currentsHandle.setGrid(interpolateGrid(currentsStack, headMs));
  };



  const initialUnit = shared0.units ?? loadDepthUnit();
  mountLegend({
    root: legendRoot,
    min: DEFAULT_DEPTH_MIN,
    max: DEFAULT_DEPTH_MAX,
    unit: initialUnit,
  });

  // Same range as the legend, so the inspector's depth tick and the legend
  // rail on the right-hand side are reading off one scale.
  mountInspector({
    root: readoutEl,
    depthMin: DEFAULT_DEPTH_MIN,
    depthMax: DEFAULT_DEPTH_MAX,
    unit: initialUnit,
  });

  let shownUnit = initialUnit;

  // One subscription drives everything the head touches: the field on the
  // GPU, which layers are allowed to draw, and the caption that names them.
  axis.subscribe(() => {
    repaintField();
    applyLayerVisibility();
    setCaption(exaggeration);
    syncUrl();
  });
  timeline = mountTimeline({ root: timelineRoot, axis, now });
  mountControls(
    form,
    {
      exaggeration: initialExaggeration,
      contourInterval: initialContour,
      sunAzimuth: initialSunAz,
      sunAltitude: initialSunAlt,
      radar: radarOn,
      sky: skyOn,
      currents: oceanOn.currents,
      buoys: oceanOn.buoys,
      aircraft: false,
      units: initialUnit,
    },
    (state: ViewerControls) => {
      exaggeration = state.exaggeration;
      shared.uExaggeration.value = state.exaggeration;
      shared.uContourInterval.value = state.contourInterval;
      applySun(sunDir, state.sunAzimuth, state.sunAltitude);
      currentSunAzimuth = state.sunAzimuth;
      currentSunAltitude = state.sunAltitude;
      radarOn = state.radar;
      skyOn = state.sky;
      oceanOn = { currents: state.currents, buoys: state.buoys };
      aircraft.setOn(state.aircraft);
      applyLayerVisibility();
      if (state.units !== shownUnit) {
        shownUnit = state.units;
        saveDepthUnit(shownUnit);
        setLegendUnit(legendRoot, shownUnit);
        setInspectorUnit(readoutEl, shownUnit);
      }
      setCaption(state.exaggeration);
      syncUrl();
    },
  );

  mountNavHelp(navHelp, navHelpToggle);
  mountAbout(about, aboutToggle);

  /*
   * Mirror the view into the URL so it can be shared or bookmarked.
   *
   * replaceState, never pushState: panning a chart is a continuous gesture,
   * and pushing an entry per frame would bury the reader's real history
   * under thousands of near-identical steps and make Back useless.
   *
   * The write is throttled and skipped when nothing changed. It is also
   * deliberately not run before the intro settles — writing during the
   * opening sweep would replace a shared link's own camera with the frames
   * of the animation flying to it.
   */
  const URL_WRITE_MS = 400;
  const viewDefaults = {
    exaggeration: DEFAULT_EXAGGERATION,
    contourInterval: DEFAULT_CONTOUR_INTERVAL,
    sunAzimuth: DEFAULT_SUN_AZIMUTH,
    sunAltitude: DEFAULT_SUN_ALTITUDE,
    units: 'm' as const,
  };
  let lastHash = '';
  let lastUrlWrite = 0;

  const currentViewState = (): ViewState => {
    const t = controls.target;
    const ll = localToLonLat(t.x, t.y);
    const st = axis.state();
    const layers: Record<LayerName, boolean> = {
      radar: radarOn,
      sky: skyOn,
      currents: oceanOn.currents,
      buoys: oceanOn.buoys,
      aircraft: aircraft.on(),
    };
    return {
      lon: ll.lon,
      lat: ll.lat,
      dist: camera.position.distanceTo(t),
      polar: (controls.getPolarAngle() * 180) / Math.PI,
      timeMs: st.live ? null : st.headMs,
      layers,
      exaggeration,
      contourInterval: shared.uContourInterval.value,
      sunAzimuth: currentSunAzimuth,
      sunAltitude: currentSunAltitude,
      units: shownUnit,
    };
  };

  const syncUrl = (): void => {
    if (!framed) {
      return;
    }
    const real = performance.now();
    if (real - lastUrlWrite < URL_WRITE_MS) {
      return;
    }
    lastUrlWrite = real;
    const hash = encodeViewState(currentViewState(), viewDefaults);
    if (hash === lastHash) {
      return;
    }
    lastHash = hash;
    window.history.replaceState(null, '', hash);
  };

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
    currentsStack = velocityStackFromJson(currentsRaw);
    currentsEtag = currentsRes.headers.get('ETag');
    registerCurrents(currentsStack);
    const grid = currentsStack ? interpolateGrid(currentsStack, axis.head()) : null;
    const buoysParsed = parseBuoysJson(buoysRaw);
    const avail = { currents: grid != null, buoys: buoysParsed != null };
    // A shared link states which layers the reader was looking at. It can
    // only turn a layer on where the server actually has it — a URL cannot
    // conjure a snapshot that is not there.
    const wanted = shared0.layers;
    const layersOn = wanted
      ? { currents: avail.currents && wanted.currents, buoys: avail.buoys && wanted.buoys }
      : defaultOn(avail);
    setLayerToggle(form, 'currents', avail.currents, layersOn.currents);
    setLayerToggle(form, 'buoys', avail.buoys, layersOn.buoys);

    if (grid) {
      currentsHandle = mountCurrents(scene, grid, { reducedMotion: reduced, floatOk });
      currentsGridShape = gridShapeOf(grid);
      currentsHandle.setEnabled(layersOn.currents);
      lastPaintedHead = axis.head();
      currentsLegend.innerHTML = currentsLegendHtml();
      currentsLegend.hidden = !layersOn.currents;
    }
    if (buoysParsed) {
      buoysHandle = mountBuoys(buoyMarks, stationsOnChart(buoysParsed.stations, aoi), aoi);
      buoysHandle.setEnabled(layersOn.buoys);
      buoyMarks.hidden = !layersOn.buoys;
    } else {
      buoyMarks.hidden = true;
    }

    buoysValid = buoysParsed?.validTime ?? null;
    registerInstant('buoys', 'Buoys', buoysValid, BUOY_STALE_MS);
    buoysEtag = buoysRes.headers.get('ETag');
    const datasetId = hycomDatasetId(currentsRaw);
    if (datasetId) {
      const dsEl = document.getElementById('hycom-dataset');
      if (dsEl) {
        dsEl.textContent = datasetId;
      }
    }
    oceanOn = { currents: layersOn.currents, buoys: layersOn.buoys };
    applyLayerVisibility();
    setCaption(exaggeration);
  })();

  const radarFrameURL = (file: string): string => `/api/weather/frames/${file}`;

  /**
   * How long the newest scan stands as the current picture.
   *
   * Sized to the real pipeline rather than to the frame step: NOAA's mosaic
   * publishes about nine minutes behind wall clock, and our refresher
   * collects it every five, so a live chart is routinely looking at a scan
   * ten to fifteen minutes old. Twenty minutes covers that without letting a
   * genuinely stalled feed imply weather — past it the layer drops out. The
   * caption states the scan time either way, so the age is never implied.
   */
  const RADAR_GRACE_MS = 20 * 60 * 1000;

  /**
   * Adopt a radar manifest: declare its window on the axis, and mount or
   * remount the sheet.
   *
   * The loop is remounted rather than patched when the geometry changes,
   * because the sheet's plane is built from the manifest's bbox — a bbox
   * that moved would otherwise drape the new frames over the old rectangle.
   */
  const adoptRadar = (next: RadarSet): void => {
    const changed =
      radarSet == null ||
      radarSet.bbox.west !== next.bbox.west ||
      radarSet.bbox.east !== next.bbox.east ||
      radarSet.bbox.south !== next.bbox.south ||
      radarSet.bbox.north !== next.bbox.north;
    radarSet = next;
    const span = radarSpan(next, RADAR_GRACE_MS);
    axis.update((st) =>
      register(st, {
        id: 'radar',
        label: 'Radar',
        kind: 'span',
        track: 'weather',
        t0: span.t0,
        t1: span.t1,
      }),
    );
    if (!radarHandle || changed) {
      radarHandle?.destroy();
      radarHandle = mountRadar(scene, next, { frameURL: radarFrameURL });
    }
    if (!radarPrimed) {
      radarPrimed = true;
      radarOn = shared0.layers?.radar ?? false;
    }
    setLayerToggle(form, 'radar', true, radarOn);
    applyLayerVisibility();
    setCaption(exaggeration);
  };

  // New scans land every couple of minutes upstream; the server rebuilds the
  // loop every five. Polling on that cadence keeps the newest frame roughly
  // current without re-downloading images already cached.
  //
  // A 404 here means the server has no weather snapshot and, under
  // GULF_WEATHER_REFRESH=0, never will — the poller stops rather than asking
  // again every five minutes for the life of the tab.
  createPoller({
    everyMs: RADAR_POLL_MS,
    load: async (): Promise<LoadResult> => {
      const res = await fetch('/api/weather/radar');
      if (res.status === 404) {
        setLayerToggle(form, 'radar', false, false);
        return 'unavailable';
      }
      if (!res.ok) {
        setLayerToggle(form, 'radar', false, false);
        return 'empty';
      }
      const next = parseRadarJson(await res.json());
      if (!next) {
        setLayerToggle(form, 'radar', false, false);
        return 'empty';
      }
      adoptRadar(next);
      return 'ok';
    },
  });

  createPoller({
    everyMs: FORECAST_POLL_MS,
    load: async (): Promise<LoadResult> => {
      const res = await fetch('/api/weather/forecast');
      if (res.status === 404) {
        setLayerToggle(form, 'sky', false, false);
        return 'unavailable';
      }
      if (!res.ok) {
        setLayerToggle(form, 'sky', false, false);
        return 'empty';
      }
      const doc = await res.json();
      const next = parseForecastJson(doc);
      if (!next) {
        setLayerToggle(form, 'sky', false, false);
        return 'empty';
      }
      weatherField = next;
      const span = forecastSpan(next);
      axis.update((st) =>
        register(st, {
          id: 'forecast',
          label: 'Clouds & rain',
          kind: 'span',
          track: 'weather',
          t0: span.t0,
          t1: span.t1,
        }),
      );
      if (!skyHandle) {
        skyHandle = mountWeatherSky(scene, next);
        skyHandle.setReducedMotion(reduced);
        skyOn = shared0.layers?.sky ?? false;
      }
      setLayerToggle(form, 'sky', true, skyOn);

      // The outlook is the timeline's day scale, not a panel of its own.
      timeline?.setOutlook(dailyOutlook(parsePeriods(doc)));
      applyLayerVisibility();
      setCaption(exaggeration);
      return 'ok';
    },
  });

  // Steady state must not re-download the stack: send the ETag and treat a
  // 304 as "nothing changed." A failed poll keeps the stack already loaded.
  const pollCurrents = async (): Promise<LoadResult> => {
    try {
      const headers: HeadersInit = currentsEtag ? { 'If-None-Match': currentsEtag } : {};
      const res = await fetch('/api/ocean/currents', { headers });
      // 304 is the steady state between HYCOM publishes, not an absence.
      if (res.status === 304) {
        return 'ok';
      }
      // A 404 here is the first-boot case, not a disabled layer: the
      // server's own refresher lands ~15s after it starts, and with
      // GULF_OCEAN_REFRESH=0 `make ocean` may seed the snapshot at any
      // time. Keep asking.
      if (!res.ok) {
        return 'empty';
      }
      const next = velocityStackFromJson(await res.json());
      if (!next) {
        return 'empty';
      }
      currentsStack = next;
      currentsEtag = res.headers.get('ETag');
      registerCurrents(next);
      // A fresh stack must repaint whatever the head is showing, however
      // recently the last one did.
      lastPaintedHead = Number.NEGATIVE_INFINITY;
      const grid = interpolateGrid(next, axis.head());
      if (!currentsHandle) {
        // F5: on a fresh deploy the first request 404s before `make ocean`
        // has ever run, and the background refresher lands ~15s after
        // boot — 404-then-200 is the routine first-boot sequence, not an
        // edge case. Mount lazily here, mirroring the bootstrap mount above.
        currentsHandle = mountCurrents(scene, grid, { reducedMotion: reduced, floatOk });
        currentsGridShape = gridShapeOf(grid);
        currentsHandle.setEnabled(oceanOn.currents);
        currentsLegend.innerHTML = currentsLegendHtml();
        currentsLegend.hidden = !oceanOn.currents;
        setLayerToggle(form, 'currents', true, oceanOn.currents);
      } else if (!sameGridShape(currentsGridShape, grid)) {
        // F6: setGrid re-uploads into a Float32Array sized at mount time and
        // never updates the GPU-side grid bounds. A stack whose nx/ny/bbox
        // differ from what is mounted must remount instead, or velocities
        // get written out of bounds (a silent no-op) and sampled through
        // stale bounds.
        currentsHandle.destroy();
        currentsHandle = mountCurrents(scene, grid, { reducedMotion: reduced, floatOk });
        currentsGridShape = gridShapeOf(grid);
        currentsHandle.setEnabled(oceanOn.currents);
      }
      setCaption(exaggeration);
      return 'ok';
    } catch {
      // A failed poll keeps the stack already loaded.
      return 'empty';
    }
  };
  createPoller({ everyMs: CURRENTS_POLL_MS, load: pollCurrents });

  // Buoys were fetched once at page load and never again, so a tab left open
  // showed the observations that happened to be current when it was opened.
  // Same ETag discipline as currents: a 304 costs nothing and is the common
  // case between NDBC publishes.
  const pollBuoys = async (): Promise<LoadResult> => {
    try {
      const headers: HeadersInit = buoysEtag ? { 'If-None-Match': buoysEtag } : {};
      const res = await fetch('/api/ocean/buoys', { headers });
      if (res.status === 304) {
        return 'ok';
      }
      if (!res.ok) {
        return 'empty';
      }
      const parsed = parseBuoysJson(await res.json());
      if (!parsed) {
        return 'empty';
      }
      buoysEtag = res.headers.get('ETag');
      buoysValid = parsed.validTime;
      registerInstant('buoys', 'Buoys', buoysValid, BUOY_STALE_MS);

      // Remounting replaces every mark, which drops hover and focus. Put
      // focus back on the same station id afterwards so a keyboard user
      // reading a station is not thrown out of the layer by a background
      // refresh.
      const focusedId = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest('.buoy-mark')?.querySelector('.buoy-id')?.textContent
        : null;

      buoysHandle?.setEnabled(false);
      buoysHandle = mountBuoys(buoyMarks, stationsOnChart(parsed.stations, aoi), aoi);
      buoysHandle.setEnabled(oceanOn.buoys);
      buoyMarks.hidden = !oceanOn.buoys;
      // F7: a fresh deploy 404s until the first server-side NDBC poll lands,
      // so the layer can become available long after first paint.
      setLayerToggle(form, 'buoys', true, oceanOn.buoys);

      if (focusedId) {
        for (const mark of buoyMarks.querySelectorAll<HTMLElement>('.buoy-mark')) {
          if (mark.querySelector('.buoy-id')?.textContent === focusedId && !mark.hidden) {
            mark.focus();
            break;
          }
        }
      }
      setCaption(exaggeration);
      return 'ok';
    } catch {
      // A failed poll keeps the stations already loaded.
      return 'empty';
    }
  };
  createPoller({ everyMs: BUOYS_POLL_MS, load: pollBuoys });

  void aircraft.refresh();

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
    coverDist = chartCover(camera, canvas, extent);
    aircraftHandle?.resize(w, h);
    if (framed) {
      controls.maxDistance = coverDist;
    }
  };
  window.addEventListener('resize', onResize);
  onResize();

  // Timer, not the deprecated Clock: update() once per frame so getDelta()
  // is stable no matter how many callers read it.
  const timer = new THREE.Timer();
  const overlayScratch = new THREE.Vector3();
  const aircraftScratch = new THREE.Vector3();
  const tick = (): void => {
    requestAnimationFrame(tick);
    camera.up.set(0, 0, 1);
    controls.maxPolarAngle = maxPolarForCoverage({
      distance: camera.position.distanceTo(controls.target),
      fovDeg: camera.fov,
      aspect: camera.aspect,
      extent,
      ceiling: CAMERA_MAX_POLAR,
    });
    controls.update();
    clampChart(camera, controls, extent);
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
    if (aircraft.on() && aircraftHandle) {
      const rows = aircraft.rowsAt(reduced);
      if (rows) {
        aircraftHandle.setAircraft(rows);
      }
      const extra = [...labels.placeCandidates()];
      if (oceanOn.buoys && buoysHandle) {
        extra.push(...buoysHandle.candidates(overlayProject, w, h));
      }
      // Its own projection: true altitude, and no lift off the seabed.
      const aircraftProject = screenProject(
        camera,
        AIRCRAFT_ALTITUDE_SCALE,
        w,
        h,
        aircraftScratch,
        0,
      );
      aircraftHandle.layout(aircraftProject, w, h, extra);
    }

    // Camera movement has no event of its own, so the URL is refreshed from
    // the frame loop. syncUrl throttles itself and no-ops when the encoded
    // view is unchanged, so a still chart costs one string compare a frame.
    syncUrl();

    timer.update();
    const dtSec = timer.getDelta();
    currentsHandle?.tick(dtSec);
    // The particle sim above runs on frame time; the field it advects is a
    // forecast, and which forecast time it shows is the axis's call. Ticking
    // the axis is what repaints it — see repaintField for the throttles.
    timeline?.tick(dtSec * 1000);
    if (skyHandle) {
      // Put the rain volume under the camera each frame. Distance to the
      // orbit target is a good enough stand-in for the visible width, and it
      // costs nothing next to computing the true footprint every frame.
      skyHandle.setFocus(
        controls.target.x,
        controls.target.y,
        camera.position.distanceTo(controls.target),
      );
      skyHandle.tick(dtSec);
    }

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

import { ORIGIN, bboxIntersects, tileBounds, type BBox } from '../geo.ts';
import { PLACES, STATE_LINES, placeRank } from '../geo/orient.ts';
import { sunDirection } from '../ui/controls.ts';
import { heightsFromRgba } from './terrariumHeights.ts';
import type { Viewer } from 'cesium';

const TILE_PX = 256;
const emptyTile = new Float32Array(TILE_PX * TILE_PX);

export type GlobePick = {
  lon: number;
  lat: number;
  elevation: number | null;
};

export type GlobeHandle = {
  setExaggeration(value: number): void;
  setImageryOn(on: boolean): void;
  setSun(azimuth: number, altitude: number): void;
  setActive(on: boolean): void;
  resize(): void;
  destroy(): void;
};

export type GlobeOptions = {
  aoi: BBox;
  minZoom: number;
  maxZoom: number;
  dataVersion?: string;
  exaggeration: number;
  imageryOn: boolean;
  sunAzimuth: number;
  sunAltitude: number;
  onPick: (sample: GlobePick | null) => void;
};

/** Returns `undefined` (parent tile) when z is past our pyramid. Must not be a Promise of undefined. */
function heightsForTile(
  x: number,
  y: number,
  level: number,
  aoi: BBox,
  minZoom: number,
  maxZoom: number,
  version: string,
): Promise<Float32Array> | undefined {
  if (level > maxZoom) {
    return undefined;
  }
  return loadHeights(x, y, level, aoi, minZoom, version);
}

async function loadHeights(
  x: number,
  y: number,
  level: number,
  aoi: BBox,
  minZoom: number,
  version: string,
): Promise<Float32Array> {
  if (level < minZoom) {
    return emptyTile.slice();
  }
  const bounds = tileBounds({ z: level, x, y });
  if (!bboxIntersects(bounds, aoi)) {
    return emptyTile.slice();
  }

  let res: Response;
  try {
    res = await fetch(`/tiles/${level}/${x}/${y}.png${version}`);
  } catch {
    return emptyTile.slice();
  }
  if (!res.ok) {
    return emptyTile.slice();
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    return emptyTile.slice();
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return emptyTile.slice();
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = heightsFromRgba(img.data, img.width, img.height);
  if (img.width === TILE_PX && img.height === TILE_PX) {
    return decoded;
  }
  // Cesium asked for 256²; resample if a tile came in another size.
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let row = 0; row < TILE_PX; row++) {
    const sy = Math.min(img.height - 1, Math.floor((row / TILE_PX) * img.height));
    for (let col = 0; col < TILE_PX; col++) {
      const sx = Math.min(img.width - 1, Math.floor((col / TILE_PX) * img.width));
      out[row * TILE_PX + col] = decoded[sy * img.width + sx] ?? 0;
    }
  }
  return out;
}

export async function mountGlobe(container: HTMLElement, opts: GlobeOptions): Promise<GlobeHandle> {
  (globalThis as typeof globalThis & { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = CESIUM_BASE_URL;
  const Cesium = await import('cesium');
  const {
    Cartesian2,
    Cartesian3,
    Cartographic,
    Color,
    CustomHeightmapTerrainProvider,
    DirectionalLight,
    DistanceDisplayCondition,
    HeightReference,
    ImageryLayer,
    Ion,
    LabelStyle,
    Matrix4,
    NearFarScalar,
    PolylineDashMaterialProperty,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    Transforms,
    UrlTemplateImageryProvider,
    VerticalOrigin,
    Viewer,
    WebMercatorTilingScheme,
  } = Cesium;
  const CesiumMath = Cesium.Math;
  await import('cesium/Build/Cesium/Widgets/widgets.css');

  const lookAtSound = (viewer: Viewer): void => {
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(ORIGIN.lon, ORIGIN.lat - 0.42, 28_000),
      orientation: {
        heading: 0,
        pitch: -0.42,
        roll: 0,
      },
    });
  };

  const applySun = (viewer: Viewer, azimuth: number, altitude: number): void => {
    const origin = Cartesian3.fromDegrees(ORIGIN.lon, ORIGIN.lat, 0);
    const enu = Transforms.eastNorthUpToFixedFrame(origin);
    const s = sunDirection(azimuth, altitude);
    const local = new Cartesian3(s.x, s.y, s.z);
    const world = Matrix4.multiplyByPointAsVector(enu, local, new Cartesian3());
    Cartesian3.normalize(world, world);
    const dir = Cartesian3.negate(world, new Cartesian3());
    viewer.scene.light = new DirectionalLight({ direction: dir });
  };

  Ion.defaultAccessToken = '';

  const version = opts.dataVersion ? `?v=${encodeURIComponent(opts.dataVersion)}` : '';
  const tilingScheme = new WebMercatorTilingScheme();

  const terrainProvider = new CustomHeightmapTerrainProvider({
    width: TILE_PX,
    height: TILE_PX,
    tilingScheme,
    callback: (x, y, level) =>
      heightsForTile(x, y, level, opts.aoi, opts.minZoom, opts.maxZoom, version),
  });

  const imageryProvider = new UrlTemplateImageryProvider({
    url: '/imagery/{z}/{x}/{y}.jpg',
    tilingScheme,
    maximumLevel: opts.maxZoom,
    credit: 'Esri, Maxar, Earthstar Geographics',
  });

  const viewer = new Viewer(container, {
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    terrainProvider,
    baseLayer: new ImageryLayer(imageryProvider),
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: false,
    scene3DOnly: true,
  });

  if (viewer.scene.skyBox) {
    viewer.scene.skyBox.show = false;
  }
  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.show = false;
  }

  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.verticalExaggeration = Math.max(1, opts.exaggeration);
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.00025;
  viewer.imageryLayers.get(0)!.show = opts.imageryOn;
  applySun(viewer, opts.sunAzimuth, opts.sunAltitude);
  lookAtSound(viewer);

  const paper = Color.fromCssColorString('#e8dcc4');
  const drying = Color.fromCssColorString('#7fa8b8');
  const ink = Color.fromCssColorString('#1a1a1a');
  const magenta = Color.fromCssColorString('#c0006e');
  const farForRank = (rank: number): number => {
    if (rank <= 0) {
      return 800_000;
    }
    if (rank === 1) {
      return 420_000;
    }
    if (rank === 2) {
      return 180_000;
    }
    return 80_000;
  };
  const fontFor = (kind: (typeof PLACES)[number]['kind']): string => {
    if (kind === 'state') {
      return '600 16px "Barlow Condensed", sans-serif';
    }
    if (kind === 'city') {
      return '600 13px "Barlow Condensed", sans-serif';
    }
    if (kind === 'water') {
      return '500 13px "Barlow Condensed", sans-serif';
    }
    return '500 12px "Barlow Condensed", sans-serif';
  };
  for (const place of PLACES) {
    const fill = place.kind === 'water' || place.kind === 'feature' ? drying : paper;
    const rank = placeRank(place);
    const marked = place.kind === 'city' || place.kind === 'feature';
    viewer.entities.add({
      name: place.name,
      position: Cartesian3.fromDegrees(place.lon, place.lat),
      point: marked
        ? {
            pixelSize: place.kind === 'city' ? 10 : 8,
            color: fill,
            outlineColor: ink,
            outlineWidth: 2,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, farForRank(rank)),
          }
        : undefined,
      label: {
        text: place.name.toUpperCase(),
        font: fontFor(place.kind),
        fillColor: fill,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, place.kind === 'state' ? -6 : -14),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(8_000, 1.2, 350_000, 0.5),
        distanceDisplayCondition: new DistanceDisplayCondition(0, farForRank(rank)),
      },
    });
  }
  for (const border of STATE_LINES) {
    const flat: number[] = [];
    for (const [lon, lat] of border.path) {
      flat.push(lon, lat);
    }
    viewer.entities.add({
      name: `${border.name} line`,
      polyline: {
        positions: Cartesian3.fromDegreesArray(flat),
        width: 2,
        clampToGround: true,
        material: new PolylineDashMaterialProperty({
          color: magenta.withAlpha(0.85),
          dashLength: 18,
        }),
      },
    });
  }

  const credit = viewer.cesiumWidget.creditContainer as HTMLElement | undefined;
  if (credit) {
    credit.style.display = 'none';
  }

  let active = true;

  const pickAt = (position: InstanceType<typeof Cartesian2>): GlobePick | null => {
    const ray = viewer.camera.getPickRay(position);
    if (!ray) {
      return null;
    }
    const hit = viewer.scene.globe.pick(ray, viewer.scene);
    if (!hit) {
      return null;
    }
    const carto = Cartographic.fromCartesian(hit);
    const lon = CesiumMath.toDegrees(carto.longitude);
    const lat = CesiumMath.toDegrees(carto.latitude);
    const sampled = viewer.scene.globe.getHeight(carto);
    const exaggeration = viewer.scene.verticalExaggeration || 1;
    const elevation = sampled ?? carto.height / exaggeration;
    return { lon, lat, elevation };
  };

  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement: { endPosition: InstanceType<typeof Cartesian2> }) => {
    if (!active) {
      return;
    }
    opts.onPick(pickAt(movement.endPosition));
  }, ScreenSpaceEventType.MOUSE_MOVE);
  viewer.scene.canvas.addEventListener('mouseleave', () => {
    if (active) {
      opts.onPick(null);
    }
  });

  return {
    setExaggeration(value: number): void {
      viewer.scene.verticalExaggeration = Math.max(1, value);
    },
    setImageryOn(on: boolean): void {
      const layer = viewer.imageryLayers.get(0);
      if (layer) {
        layer.show = on;
      }
    },
    setSun(azimuth: number, altitude: number): void {
      applySun(viewer, azimuth, altitude);
    },
    setActive(on: boolean): void {
      active = on;
      viewer.useDefaultRenderLoop = on;
      if (on) {
        viewer.resize();
        viewer.scene.requestRender();
      }
    },
    resize(): void {
      viewer.resize();
    },
    destroy(): void {
      handler.destroy();
      viewer.destroy();
    },
  };
}

import * as THREE from 'three';
import {
  AOI,
  bboxContains,
  covering,
  intersectBBox,
  localToLonLat,
  lonLatToLocal,
  tileBounds,
  tileKey,
  type BBox,
  type TileCoord,
} from '../geo';
import { marchHeightfield } from './pick';
import { frustumLayerReady, satelliteVisible, viewTargetZoom } from './lodPolicy';
import { TerrainTile, type SharedTerrainUniforms } from './TerrainTile';

const MAX_INFLIGHT = 16;
const MAX_IMAGERY_INFLIGHT = 10;
const MAX_IMAGERY_RETRIES = 2;

/**
 * Zooms up to here stay resident for the whole AOI, so there is always a
 * complete coarse surface underneath and panning never opens a hole. ~54 tiles.
 */
const BASE_ZOOM = 10;
/**
 * Textures held above the base pyramid. Each tile costs a height texture, an
 * imagery texture with mipmaps and a CPU copy of the heights for picking, so
 * the whole AOI cannot be resident at the finest zooms — z14 alone is ~8600
 * tiles. Least-recently-wanted tiles are evicted past this.
 */
const TILE_BUDGET = 180;

export type LODConfig = {
  scene: THREE.Scene;
  shared: SharedTerrainUniforms;
  aoi?: BBox;
  minZoom: number;
  maxZoom: number;
  /** Stamped onto tile URLs so a regenerated pyramid is never read from cache. */
  dataVersion?: string;
};

type NodeState = 'pending' | 'loading' | 'ready' | 'missing';

type LodNode = {
  coord: TileCoord;
  key: string;
  state: NodeState;
  tile: TerrainTile | null;
  /** Clipped ground extent, precomputed for the frustum and zoom tests. */
  clip: BBox;
  centre: THREE.Vector3;
  /** Frame counter, drives eviction. */
  lastWanted: number;
};

export type HoverSample = {
  lon: number;
  lat: number;
  elevation: number | null;
};

function sampleVisibleTiles(
  tiles: TerrainTile[],
  x: number,
  y: number,
): HoverSample | null {
  const { lon, lat } = localToLonLat(x, y);
  let best: TerrainTile | null = null;
  for (const tile of tiles) {
    if (!bboxContains(tile.clip, lon, lat)) {
      continue;
    }
    if (!best || tile.coord.z > best.coord.z) {
      best = tile;
    }
  }
  if (!best) {
    return null;
  }
  const uw = best.clip.east - best.clip.west;
  const uh = best.clip.north - best.clip.south;
  if (uw === 0 || uh === 0) {
    return null;
  }
  const u = (lon - best.clip.west) / uw;
  const v = (lat - best.clip.south) / uh;
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    return null;
  }
  return {
    lon,
    lat,
    elevation: best.sampleElevation(u, v),
  };
}

function tileUrl(t: TileCoord, version: string): string {
  return `/tiles/${t.z}/${t.x}/${t.y}.png${version}`;
}

async function fetchTileBitmap(t: TileCoord, version: string): Promise<ImageBitmap | null> {
  let res: Response;
  try {
    res = await fetch(tileUrl(t, version));
  } catch {
    return null;
  }
  if (res.status === 404 || !res.ok) {
    return null;
  }
  try {
    const blob = await res.blob();
    if (blob.size === 0) {
      return null;
    }
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * View-dependent tile pyramid.
 *
 * Zooms through BASE_ZOOM are loaded once and pinned. Above that, the whole
 * frustum uses one zoom — the zoom whose texel is about one screen pixel at
 * the camera's distance to the AOI centre — so east/west tiles do not quilt.
 * A finer zoom is drawn only when every in-view tile at that zoom is ready.
 */
export class QuadtreeLOD {
  readonly group = new THREE.Group();

  private readonly shared: SharedTerrainUniforms;
  private readonly aoi: BBox;
  private readonly aoiCentre: THREE.Vector3;
  private readonly midLat: number;
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly baseZoom: number;
  private readonly layers = new Map<number, LodNode[]>();
  private readonly nodes = new Map<string, LodNode>();
  private inflight = 0;
  private queued: LodNode[] = [];
  private imgInflight = 0;
  private imgQueued: LodNode[] = [];
  private imgQueuedKeys = new Set<string>();
  private readyCount = 0;
  private wantImagery = false;
  private userImageryOpacity = 0;
  private imageryLayerOn = false;
  private imageryRetries = new Map<string, number>();
  private readonly tileVersion: string;

  private frame = 0;
  private visible: LodNode[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly scratchBox = new THREE.Box3();

  constructor(cfg: LODConfig) {
    this.shared = cfg.shared;
    this.aoi = cfg.aoi ?? AOI;
    const origin = lonLatToLocal((this.aoi.west + this.aoi.east) / 2, (this.aoi.south + this.aoi.north) / 2);
    this.aoiCentre = new THREE.Vector3(origin.x, origin.y, 0);
    this.midLat = (this.aoi.south + this.aoi.north) / 2;
    this.minZoom = cfg.minZoom;
    this.maxZoom = cfg.maxZoom;
    this.baseZoom = Math.min(BASE_ZOOM, cfg.maxZoom);
    this.tileVersion = cfg.dataVersion ? `?v=${encodeURIComponent(cfg.dataVersion)}` : '';
    this.group.name = 'terrain-quadtree';
    cfg.scene.add(this.group);

    for (let z = this.minZoom; z <= this.maxZoom; z++) {
      const layer = covering(this.aoi, z).map((coord) => {
        const bounds = tileBounds(coord);
        const clip = intersectBBox(bounds, this.aoi) ?? bounds;
        const sw = lonLatToLocal(clip.west, clip.south);
        const ne = lonLatToLocal(clip.east, clip.north);
        const node: LodNode = {
          coord,
          key: tileKey(coord),
          state: 'pending',
          tile: null,
          clip,
          centre: new THREE.Vector3((sw.x + ne.x) / 2, (sw.y + ne.y) / 2, 0),
          lastWanted: 0,
        };
        this.nodes.set(node.key, node);
        return node;
      });
      this.layers.set(z, layer);
    }
  }

  hasTiles(): boolean {
    return this.readyCount > 0;
  }

  setImageryEnabled(on: boolean): void {
    this.wantImagery = on;
    if (on) {
      // The layer gate now holds the whole drape off while any visible tile has
      // failed, so a tile that burned through MAX_IMAGERY_RETRIES would keep
      // satellite dark for the rest of the session. Toggling the control is an
      // explicit user gesture, not a render loop, so re-arm the budget here.
      this.imageryRetries.clear();
      for (const node of this.nodes.values()) {
        if (node.state === 'ready') {
          this.enqueueImagery(node);
        }
      }
      this.drainImagery();
    }
    this.applyImageryGate();
  }

  setImageryOpacity(opacity: number): void {
    this.userImageryOpacity = opacity;
    this.setImageryEnabled(opacity > 0);
  }

  /** Loads the resident base pyramid. Finer zooms stream in from update(). */
  async bootstrap(): Promise<void> {
    const waiting: LodNode[] = [];
    for (let z = this.minZoom; z <= this.baseZoom; z++) {
      for (const node of this.layers.get(z) ?? []) {
        this.enqueue(node);
        waiting.push(node);
      }
    }
    await Promise.all(waiting.map((n) => this.waitFor(n)));
    this.showLayer(this.baseZoom);
    this.drainImagery();
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.frame += 1;

    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);

    const wanted = viewTargetZoom({
      distance: camera.position.distanceTo(this.aoiCentre),
      fovDeg: camera.fov,
      viewportHeight,
      latitudeDeg: this.midLat,
      minZoom: this.baseZoom,
      maxZoom: this.maxZoom,
    });

    for (let z = this.baseZoom + 1; z <= wanted; z++) {
      for (const node of this.inFrustum(z)) {
        node.lastWanted = this.frame;
        if (node.state === 'pending') {
          this.enqueue(node);
        }
        if (node.state === 'ready') {
          this.enqueueImagery(node);
        }
      }
    }

    let drawZ = wanted;
    while (drawZ > this.baseZoom && !frustumLayerReady(this.inFrustum(drawZ).map((n) => n.state))) {
      drawZ -= 1;
    }
    if (drawZ <= this.baseZoom) {
      const layer = this.layers.get(this.baseZoom) ?? [];
      for (const node of layer) {
        node.lastWanted = this.frame;
      }
      this.applySelection(layer.filter((n) => n.state === 'ready'));
    } else {
      for (const node of this.inFrustum(drawZ)) {
        node.lastWanted = this.frame;
      }
      this.applySelection(this.inFrustum(drawZ).filter((n) => n.state === 'ready'));
    }

    this.drainQueue();
    this.drainImagery();
    this.applyImageryGate();
    this.evict();
  }

  pick(raycaster: THREE.Raycaster): HoverSample | null {
    const tiles: TerrainTile[] = [];
    for (const node of this.visible) {
      if (node.tile) {
        tiles.push(node.tile);
      }
    }
    if (tiles.length === 0) {
      return null;
    }

    const exaggeration = this.shared.uExaggeration.value;
    const sw = lonLatToLocal(this.aoi.west, this.aoi.south);
    const ne = lonLatToLocal(this.aoi.east, this.aoi.north);
    const zScale = Math.max(1, Math.abs(exaggeration));

    return marchHeightfield(
      raycaster.ray.origin,
      raycaster.ray.direction,
      {
        min: { x: Math.min(sw.x, ne.x), y: Math.min(sw.y, ne.y), z: -150 * zScale },
        max: { x: Math.max(sw.x, ne.x), y: Math.max(sw.y, ne.y), z: 50 * zScale },
      },
      exaggeration,
      (x, y) => sampleVisibleTiles(tiles, x, y),
    );
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      node.tile?.dispose();
      node.tile = null;
    }
    this.group.removeFromParent();
  }

  private inFrustum(z: number): LodNode[] {
    const exaggeration = Math.max(1, Math.abs(this.shared.uExaggeration.value));
    const out: LodNode[] = [];
    for (const node of this.layers.get(z) ?? []) {
      const sw = lonLatToLocal(node.clip.west, node.clip.south);
      const ne = lonLatToLocal(node.clip.east, node.clip.north);
      this.scratchBox.min.set(
        Math.min(sw.x, ne.x),
        Math.min(sw.y, ne.y),
        -150 * exaggeration,
      );
      this.scratchBox.max.set(
        Math.max(sw.x, ne.x),
        Math.max(sw.y, ne.y),
        50 * exaggeration,
      );
      if (this.frustum.intersectsBox(this.scratchBox)) {
        out.push(node);
      }
    }
    return out;
  }

  private applySelection(selected: LodNode[]): void {
    for (const node of this.visible) {
      if (node.tile) {
        node.tile.mesh.visible = false;
      }
    }
    this.visible = [];
    for (const node of selected) {
      if (!node.tile) {
        continue;
      }
      node.tile.mesh.visible = true;
      this.visible.push(node);
      this.enqueueImagery(node);
    }
  }

  private applyImageryGate(): void {
    const visible = this.visible
      .filter((n) => n.tile)
      .map((n) => ({
        hasImagery: n.tile?.hasImagery() ?? false,
        imageryFailed: n.tile?.imageryFailed() ?? false,
      }));
    const on = satelliteVisible(visible, this.wantImagery, this.imageryLayerOn);
    this.imageryLayerOn = on;
    this.shared.uImageryOpacity.value = on ? this.userImageryOpacity : 0;
  }

  /** Bootstrap fallback before the first update() has a camera to measure. */
  private showLayer(z: number): void {
    const selected = (this.layers.get(z) ?? []).filter((n) => n.state === 'ready');
    for (const node of selected) {
      node.lastWanted = this.frame;
    }
    this.applySelection(selected);
  }

  /** Frees the least-recently-wanted tiles above the pinned base pyramid. */
  private evict(): void {
    const evictable: LodNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.coord.z > this.baseZoom && node.tile && node.lastWanted !== this.frame) {
        evictable.push(node);
      }
    }
    const over = evictable.length - TILE_BUDGET;
    if (over <= 0) {
      return;
    }
    evictable.sort((a, b) => a.lastWanted - b.lastWanted);
    for (let i = 0; i < over; i++) {
      const node = evictable[i];
      if (!node) {
        continue;
      }
      node.tile?.dispose();
      node.tile = null;
      node.state = 'pending';
      this.readyCount -= 1;
      this.imgQueuedKeys.delete(node.key);
      this.imageryRetries.delete(node.key);
    }
  }

  private enqueue(node: LodNode): void {
    if (node.state !== 'pending') {
      return;
    }
    node.state = 'loading';
    this.queued.push(node);
  }

  private drainQueue(): void {
    // Finest first: these are the tiles the camera is actually waiting on.
    this.queued.sort((a, b) => b.coord.z - a.coord.z);
    while (this.inflight < MAX_INFLIGHT && this.queued.length > 0) {
      const node = this.queued.shift();
      if (!node) {
        break;
      }
      void this.loadNode(node);
    }
  }

  private waitFor(node: LodNode): Promise<void> {
    if (node.state === 'ready' || node.state === 'missing') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const tick = (): void => {
        if (node.state === 'ready' || node.state === 'missing') {
          resolve();
          return;
        }
        this.drainQueue();
        this.drainImagery();
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  private async loadNode(node: LodNode): Promise<void> {
    this.inflight += 1;
    const bitmap = await fetchTileBitmap(node.coord, this.tileVersion);
    this.inflight -= 1;

    if (!bitmap) {
      node.state = 'missing';
      return;
    }
    if (node.state !== 'loading') {
      // Evicted while the fetch was in flight.
      bitmap.close();
      return;
    }

    const tile = new TerrainTile(node.coord, bitmap, this.shared, this.aoi);
    tile.mesh.visible = false;
    node.tile = tile;
    node.state = 'ready';
    this.readyCount += 1;
    this.group.add(tile.mesh);
    this.enqueueImagery(node);
  }

  private enqueueImagery(node: LodNode): void {
    if (!this.wantImagery || node.state !== 'ready' || !node.tile) {
      return;
    }
    if (node.tile.hasImagery() || node.tile.imageryBusy()) {
      return;
    }
    if (node.tile.imageryFailed()) {
      if ((this.imageryRetries.get(node.key) ?? 0) >= MAX_IMAGERY_RETRIES) {
        return;
      }
    }
    if (this.imgQueuedKeys.has(node.key)) {
      return;
    }
    this.imgQueuedKeys.add(node.key);
    this.imgQueued.push(node);
  }

  private drainImagery(): void {
    if (!this.wantImagery) {
      return;
    }
    this.imgQueued = this.imgQueued.filter((n) => {
      if (!n.tile || n.tile.hasImagery() || n.tile.imageryBusy()) {
        this.imgQueuedKeys.delete(n.key);
        return false;
      }
      if (n.lastWanted === this.frame) {
        return true;
      }
      this.imgQueuedKeys.delete(n.key);
      return false;
    });
    this.imgQueued.sort((a, b) => {
      const av = a.tile?.mesh.visible ? 0 : 1;
      const bv = b.tile?.mesh.visible ? 0 : 1;
      if (av !== bv) {
        return av - bv;
      }
      return a.coord.z - b.coord.z;
    });
    while (this.imgInflight < MAX_IMAGERY_INFLIGHT && this.imgQueued.length > 0) {
      const node = this.imgQueued.shift();
      if (!node) {
        break;
      }
      this.imgQueuedKeys.delete(node.key);
      void this.loadImagery(node);
    }
  }

  private async loadImagery(node: LodNode): Promise<void> {
    if (!this.wantImagery || !node.tile || node.tile.hasImagery()) {
      return;
    }
    if (node.tile.imageryFailed()) {
      const tries = this.imageryRetries.get(node.key) ?? 0;
      if (tries >= MAX_IMAGERY_RETRIES) {
        return;
      }
      this.imageryRetries.set(node.key, tries + 1);
      node.tile.allowImageryRetry();
    }
    this.imgInflight += 1;
    try {
      await node.tile.ensureImagery();
    } finally {
      this.imgInflight -= 1;
    }
  }
}

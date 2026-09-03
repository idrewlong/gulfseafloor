import * as THREE from 'three';
import {
  heightUvRect,
  intersectBBox,
  lonLatToLocal,
  spanMetres,
  spanNorthMetres,
  tileBounds,
  type BBox,
  type TileCoord,
} from '../geo';
import { decodeTerrainRGB, isNodata } from './terrainRgb';
import vert from './shaders/terrain.vert.glsl?raw';
import frag from './shaders/terrain.frag.glsl?raw';

export const TILE_SEGMENTS = 128;
const SKIRT_UV = 0.02;

export type SharedTerrainUniforms = {
  uColorLUT: { value: THREE.Texture };
  uSunDir: { value: THREE.Vector3 };
  uContourInterval: { value: number };
  uDepthMin: { value: number };
  uDepthMax: { value: number };
  uExaggeration: { value: number };
  uFogColor: { value: THREE.Color };
  uFogDensity: { value: number };
  uImageryOpacity: { value: number };
};

let sharedGeometry: THREE.BufferGeometry | null = null;

function createSkirtedTerrainGeometry(): THREE.BufferGeometry {
  const inner = TILE_SEGMENTS;
  const verts = inner + 3;
  const positions = new Float32Array(verts * verts * 3);
  const uvs = new Float32Array(verts * verts * 2);
  const indices: number[] = [];

  for (let iy = 0; iy < verts; iy++) {
    for (let ix = 0; ix < verts; ix++) {
      let u: number;
      let x: number;
      if (ix === 0) {
        u = -SKIRT_UV;
        x = -0.5 - SKIRT_UV;
      } else if (ix === verts - 1) {
        u = 1 + SKIRT_UV;
        x = 0.5 + SKIRT_UV;
      } else {
        u = (ix - 1) / inner;
        x = -0.5 + u;
      }

      let v: number;
      let y: number;
      if (iy === 0) {
        v = -SKIRT_UV;
        y = -0.5 - SKIRT_UV;
      } else if (iy === verts - 1) {
        v = 1 + SKIRT_UV;
        y = 0.5 + SKIRT_UV;
      } else {
        v = (iy - 1) / inner;
        y = -0.5 + v;
      }

      const i = iy * verts + ix;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = 0;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }
  }

  for (let iy = 0; iy < verts - 1; iy++) {
    for (let ix = 0; ix < verts - 1; ix++) {
      const a = iy * verts + ix;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

export function getSharedTerrainGeometry(): THREE.BufferGeometry {
  if (!sharedGeometry) {
    sharedGeometry = createSkirtedTerrainGeometry();
  }
  return sharedGeometry;
}

function heightTextureFromHeights(heights: ImageData): THREE.DataTexture {
  const w = heights.width;
  const h = heights.height;
  const data = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = heights.data[i * 4] ?? 0;
    const g = heights.data[i * 4 + 1] ?? 0;
    const b = heights.data[i * 4 + 2] ?? 0;
    data[i] = THREE.DataUtils.toHalfFloat(decodeTerrainRGB(r, g, b));
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // Slippy PNG row 0 is north. Plane UV (0,0) is south-west. flipY
  // makes WebGL v=0 sample the south edge so neighbouring tiles meet.
  tex.flipY = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function imageryTextureFromBitmap(bitmap: ImageBitmap): THREE.Texture {
  const tex = new THREE.Texture(bitmap);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = THREE.Texture.DEFAULT_ANISOTROPY;
  tex.flipY = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

async function fetchImageryBitmap(t: TileCoord): Promise<ImageBitmap | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/imagery/${t.z}/${t.x}/${t.y}.jpg`);
    } catch {
      continue;
    }
    if (!res.ok) {
      continue;
    }
    try {
      const blob = await res.blob();
      if (blob.size === 0) {
        continue;
      }
      return await createImageBitmap(blob);
    } catch {
      continue;
    }
  }
  return null;
}

function emptyImageryTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function imageDataFromBitmap(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('2D canvas unavailable — cannot cache heightfield');
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export class TerrainTile {
  readonly coord: TileCoord;
  readonly mesh: THREE.Mesh;
  readonly span: number;
  readonly clip: BBox;

  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Texture;
  private imagery: THREE.Texture;
  private readonly heights: ImageData;
  private readonly uvRect: ReturnType<typeof heightUvRect>;
  private imageryState: 'idle' | 'loading' | 'ready' | 'missing' = 'idle';

  constructor(
    coord: TileCoord,
    bitmap: ImageBitmap,
    shared: SharedTerrainUniforms,
    aoi: BBox,
  ) {
    this.coord = coord;
    this.span = spanMetres(coord);
    this.heights = imageDataFromBitmap(bitmap);
    bitmap.close();
    this.texture = heightTextureFromHeights(this.heights);
    this.imagery = emptyImageryTexture();

    const bounds = tileBounds(coord);
    this.clip = intersectBBox(bounds, aoi) ?? bounds;
    this.uvRect = heightUvRect(bounds, this.clip);

    const sw = lonLatToLocal(this.clip.west, this.clip.south);
    const ne = lonLatToLocal(this.clip.east, this.clip.north);
    const width = Math.max(1, ne.x - sw.x);
    const height = Math.max(1, ne.y - sw.y);
    const cx = (sw.x + ne.x) / 2;
    const cy = (sw.y + ne.y) / 2;

    const w = bitmap.width;
    const h = bitmap.height;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uHeightTex: { value: this.texture },
        uTileSpanMeters: { value: this.span },
        uTileSpanY: { value: spanNorthMetres(coord) },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
        uUvOffset: { value: new THREE.Vector2(this.uvRect.offsetX, this.uvRect.offsetY) },
        uUvScale: { value: new THREE.Vector2(this.uvRect.scaleX, this.uvRect.scaleY) },
        uColorLUT: shared.uColorLUT,
        uSunDir: shared.uSunDir,
        uContourInterval: shared.uContourInterval,
        uDepthMin: shared.uDepthMin,
        uDepthMax: shared.uDepthMax,
        uExaggeration: shared.uExaggeration,
        uFogColor: shared.uFogColor,
        uFogDensity: shared.uFogDensity,
        uImageryTex: { value: this.imagery },
        uImageryOpacity: shared.uImageryOpacity,
        uHasImagery: { value: 0 },
      },
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(getSharedTerrainGeometry(), this.material);
    this.mesh.position.set(cx, cy, 0);
    this.mesh.scale.set(width, height, this.span);
    this.mesh.frustumCulled = false;
    this.mesh.userData.tile = this;
  }

  private disposed = false;

  hasImagery(): boolean {
    return this.imageryState === 'ready';
  }

  imageryBusy(): boolean {
    return this.imageryState === 'loading';
  }

  imageryFailed(): boolean {
    return this.imageryState === 'missing';
  }

  allowImageryRetry(): void {
    if (this.imageryState === 'missing') {
      this.imageryState = 'idle';
    }
  }

  async ensureImagery(): Promise<boolean> {
    if (this.disposed || this.imageryState === 'ready') {
      return this.imageryState === 'ready';
    }
    if (this.imageryState === 'missing' || this.imageryState === 'loading') {
      return false;
    }
    this.imageryState = 'loading';
    const bitmap = await fetchImageryBitmap(this.coord);
    if (this.disposed) {
      if (bitmap) {
        bitmap.close();
      }
      return false;
    }
    if (!bitmap) {
      this.imageryState = 'missing';
      return false;
    }
    const next = imageryTextureFromBitmap(bitmap);
    this.imagery.dispose();
    this.imagery = next;
    this.material.uniforms.uImageryTex.value = next;
    this.material.uniforms.uHasImagery.value = 1;
    this.imageryState = 'ready';
    return true;
  }

  /**
   * CPU sample of the height texture at clipped-mesh UV.
   * Returns null for nodata or an unreadable sample — callers must not invent a depth.
   */
  sampleElevation(u: number, v: number): number | null {
    const texU = this.uvRect.offsetX + u * this.uvRect.scaleX;
    const texV = this.uvRect.offsetY + v * this.uvRect.scaleY;
    const w = this.heights.width;
    const h = this.heights.height;
    if (w < 1 || h < 1) {
      return null;
    }
    const x = Math.min(w - 1, Math.max(0, Math.floor(texU * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor((1 - texV) * h)));
    const i = (y * w + x) * 4;
    const r = this.heights.data[i];
    const g = this.heights.data[i + 1];
    const b = this.heights.data[i + 2];
    if (r === undefined || g === undefined || b === undefined) {
      return null;
    }
    const elev = decodeTerrainRGB(r, g, b);
    if (isNodata(elev)) {
      return null;
    }
    return elev;
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.removeFromParent();
    this.material.dispose();
    this.texture.dispose();
    this.imagery.dispose();
    const img = this.texture.image as ImageBitmap | HTMLImageElement | undefined;
    if (img && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
      img.close();
    }
  }
}

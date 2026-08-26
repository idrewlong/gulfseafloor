export type NodeLoadState = 'pending' | 'loading' | 'ready' | 'missing';

export type DisplayQuery = {
  state: NodeLoadState;
  wantImagery: boolean;
  hasImagery: boolean;
  imageryFailed: boolean;
};

const EQUATOR_M = 40_075_016.686;
const TILE_PX = 256;

/** Height-ready tiles may be drawn. Satellite is a separate global gate. */
export function isDisplayReady(opts: DisplayQuery): boolean {
  if (opts.state === 'missing') {
    return true;
  }
  return opts.state === 'ready';
}

/** Refine a parent only when every in-AOI child has height. A 404 child keeps the parent up. */
export function canRefine(children: DisplayQuery[]): boolean {
  if (children.length === 0) {
    return false;
  }
  for (const child of children) {
    if (child.state === 'missing') {
      return false;
    }
    if (!isDisplayReady(child)) {
      return false;
    }
  }
  return true;
}

/** One zoom for the whole view, from camera distance. Per-tile round() quilts z and z+1. */
export function viewTargetZoom(opts: {
  distance: number;
  fovDeg: number;
  viewportHeight: number;
  latitudeDeg: number;
  minZoom: number;
  maxZoom: number;
}): number {
  const metresPerPixel =
    (2 * Math.max(1, opts.distance) * Math.tan((opts.fovDeg * Math.PI) / 360)) /
    Math.max(1, opts.viewportHeight);
  const wanted = Math.log2(
    (EQUATOR_M * Math.cos((opts.latitudeDeg * Math.PI) / 180)) /
      (TILE_PX * Math.max(1e-6, metresPerPixel)),
  );
  return Math.max(opts.minZoom, Math.min(opts.maxZoom, Math.round(wanted)));
}

/** Draw a zoom only when every in-view tile at that zoom has height. */
export function frustumLayerReady(states: NodeLoadState[]): boolean {
  if (states.length === 0) {
    return false;
  }
  return states.every((s) => s === 'ready');
}

/** Gate the satellite layer so every visible tile switches together instead of quilting. */
export function imageryLayerReady(
  visible: Array<{ hasImagery: boolean; imageryFailed: boolean }>,
  wantImagery: boolean,
): boolean {
  if (!wantImagery || visible.length === 0) {
    return false;
  }
  return visible.every((t) => t.hasImagery || t.imageryFailed);
}

/** After the first complete satellite layer, keep it on so LOD swaps do not flash the hypsometric tint. */
export function satelliteVisible(
  visible: Array<{ hasImagery: boolean; imageryFailed: boolean }>,
  wantImagery: boolean,
  alreadyOn: boolean,
): boolean {
  if (!wantImagery) {
    return false;
  }
  if (alreadyOn) {
    return true;
  }
  return imageryLayerReady(visible, true);
}

export type NodeLoadState = 'pending' | 'loading' | 'ready' | 'missing';

export type DisplayQuery = {
  state: NodeLoadState;
  wantImagery: boolean;
  hasImagery: boolean;
  imageryFailed: boolean;
};

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

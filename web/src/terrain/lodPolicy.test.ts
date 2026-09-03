import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canRefine,
  frustumLayerReady,
  isDisplayReady,
  viewTargetZoom,
} from './lodPolicy.ts';

const heightReady = {
  state: 'ready' as const,
};

describe('isDisplayReady', () => {
  it('draws a tile once its height texture is resident', () => {
    assert.equal(isDisplayReady(heightReady), true);
  });

  it('does not draw until the height texture is resident', () => {
    assert.equal(isDisplayReady({ ...heightReady, state: 'loading' }), false);
    assert.equal(isDisplayReady({ ...heightReady, state: 'pending' }), false);
  });
});

describe('canRefine', () => {
  it('holds the parent while any child is still loading height', () => {
    const loading = { ...heightReady, state: 'loading' as const };
    assert.equal(canRefine([heightReady, heightReady, heightReady, loading]), false);
  });

  it('refines once every child has height', () => {
    assert.equal(canRefine([heightReady, heightReady, heightReady, heightReady]), true);
  });

  it('holds the parent when a child 404s so a hole does not open', () => {
    const missing = { ...heightReady, state: 'missing' as const };
    assert.equal(canRefine([heightReady, heightReady, heightReady, missing]), false);
  });
});

describe('viewTargetZoom', () => {
  const base = {
    fovDeg: 48,
    viewportHeight: 900,
    latitudeDeg: 30.14,
    minZoom: 10,
    maxZoom: 14,
  };

  it('picks a coarser zoom when the camera is farther', () => {
    const near = viewTargetZoom({ ...base, distance: 80_000 });
    const far = viewTargetZoom({ ...base, distance: 250_000 });
    assert.ok(far <= near);
    assert.ok(near >= 10 && near <= 14);
  });

  it('clamps to min and max zoom', () => {
    assert.equal(viewTargetZoom({ ...base, distance: 1 }), 14);
    assert.equal(viewTargetZoom({ ...base, distance: 1e9 }), 10);
  });
});

describe('frustumLayerReady', () => {
  it('is false until every in-view tile at that zoom has height', () => {
    assert.equal(frustumLayerReady(['ready', 'loading']), false);
    assert.equal(frustumLayerReady([]), false);
  });

  it('is true only when the whole in-view layer is ready, so zooms do not quilt', () => {
    assert.equal(frustumLayerReady(['ready', 'ready']), true);
  });
});

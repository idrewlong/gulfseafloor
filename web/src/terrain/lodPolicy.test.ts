import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canRefine,
  frustumLayerReady,
  imageryLayerReady,
  isDisplayReady,
  satelliteVisible,
  viewTargetZoom,
} from './lodPolicy.ts';

const heightReady = {
  state: 'ready' as const,
  wantImagery: true,
  hasImagery: false,
  imageryFailed: false,
};

describe('isDisplayReady', () => {
  it('draws a height-ready tile even if satellite is still in flight', () => {
    assert.equal(isDisplayReady(heightReady), true);
  });

  it('does not draw until the height texture is resident', () => {
    assert.equal(isDisplayReady({ ...heightReady, state: 'loading' }), false);
    assert.equal(isDisplayReady({ ...heightReady, state: 'pending' }), false);
  });
});

describe('canRefine', () => {
  it('holds the parent while any child is still loading height', () => {
    const ready = { ...heightReady, hasImagery: true };
    const loading = { ...heightReady, state: 'loading' as const };
    assert.equal(canRefine([ready, ready, ready, loading]), false);
  });

  it('refines once every child has height — imagery is gated separately', () => {
    assert.equal(canRefine([heightReady, heightReady, heightReady, heightReady]), true);
  });

  it('holds the parent when a child 404s so a hole does not open', () => {
    const missing = { ...heightReady, state: 'missing' as const };
    assert.equal(canRefine([heightReady, heightReady, heightReady, missing]), false);
  });
});

describe('imageryLayerReady', () => {
  it('keeps satellite off until every visible tile has a texture', () => {
    assert.equal(
      imageryLayerReady(
        [
          { hasImagery: true, imageryFailed: false },
          { hasImagery: false, imageryFailed: false },
        ],
        true,
      ),
      false,
    );
  });

  it('turns satellite on together so tiles do not quilt', () => {
    assert.equal(
      imageryLayerReady(
        [
          { hasImagery: true, imageryFailed: false },
          { hasImagery: true, imageryFailed: false },
        ],
        true,
      ),
      true,
    );
  });
});

describe('satelliteVisible', () => {
  it('stays on after the first complete layer so zoom does not flash hypsometric', () => {
    assert.equal(
      satelliteVisible(
        [
          { hasImagery: true, imageryFailed: false },
          { hasImagery: false, imageryFailed: false },
        ],
        true,
        true,
      ),
      true,
    );
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

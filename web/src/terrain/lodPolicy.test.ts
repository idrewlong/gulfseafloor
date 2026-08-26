import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canRefine, imageryLayerReady, isDisplayReady, satelliteVisible } from './lodPolicy.ts';

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

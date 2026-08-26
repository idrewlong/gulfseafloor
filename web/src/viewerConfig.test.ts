import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAMERA_MAX_POLAR,
  CAMERA_MIN_POLAR,
  DEFAULT_DEPTH_MAX,
  DEFAULT_DEPTH_MIN,
  DEFAULT_EXAGGERATION,
  SKIRT_METRES,
  displacedZ,
  skirtVisibleFrom,
} from './viewerConfig.ts';

describe('viewerConfig', () => {
  it('starts level: exaggeration is 1×', () => {
    assert.equal(DEFAULT_EXAGGERATION, 1);
  });

  it('depth window covers mid-shelf water out to 42354', () => {
    assert.ok(DEFAULT_DEPTH_MIN <= -80);
    assert.ok(DEFAULT_DEPTH_MAX >= 12);
  });

  it('displaces water and land by the same scale (tomography, not a 0.55 squash)', () => {
    assert.equal(displacedZ(-20, 1), -20);
    assert.equal(displacedZ(-20, 12), -240);
    assert.equal(displacedZ(4, 12), 48);
  });

  it('keeps skirts shorter than the Sound so they are not a blue cliff', () => {
    assert.ok(SKIRT_METRES > 0);
    assert.ok(SKIRT_METRES <= 2);
  });

  it('keeps the camera off the pole and off the horizon so the slab cannot flip', () => {
    assert.ok(CAMERA_MIN_POLAR > 0.05);
    assert.ok(CAMERA_MAX_POLAR < Math.PI * 0.45);
    assert.ok(CAMERA_MAX_POLAR > CAMERA_MIN_POLAR);
  });

  it('never shades skirt walls — the outer half of a dropped triangle still hangs as a spike', () => {
    assert.equal(skirtVisibleFrom(Math.cos(CAMERA_MIN_POLAR)), false);
    assert.equal(skirtVisibleFrom(1), false);
    assert.equal(skirtVisibleFrom(0), false);
    assert.equal(skirtVisibleFrom(-0.4), false);
  });
});

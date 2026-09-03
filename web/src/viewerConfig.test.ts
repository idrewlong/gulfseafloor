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

  it('depth window covers the Bight to its GEBCO floor of -81 m', () => {
    assert.ok(DEFAULT_DEPTH_MIN <= -80);
    assert.ok(DEFAULT_DEPTH_MIN >= -90);
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

  it('reaches dead top-down so the chart can read as a flat map', () => {
    assert.equal(CAMERA_MIN_POLAR, 0);
  });

  it('allows only a slight tilt, never far enough to see the slab edge-on', () => {
    assert.ok(CAMERA_MAX_POLAR > 0);
    assert.ok(CAMERA_MAX_POLAR <= Math.PI * 0.14);
  });

  it('never shades skirt walls — the outer half of a dropped triangle still hangs as a spike', () => {
    assert.equal(skirtVisibleFrom(Math.cos(CAMERA_MIN_POLAR)), false);
    assert.equal(skirtVisibleFrom(1), false);
    assert.equal(skirtVisibleFrom(0), false);
    assert.equal(skirtVisibleFrom(-0.4), false);
  });
});

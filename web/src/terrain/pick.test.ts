import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lonLatToLocal, localToLonLat, ORIGIN } from '../geo.ts';
import { marchHeightfield } from './pick.ts';

const EXAG = 25;
const WATER_ELEV = -12.4;
const SURFACE_Z = WATER_ELEV * EXAG;

function flatWater(x: number, y: number) {
  const { lon, lat } = localToLonLat(x, y);
  return { lon, lat, elevation: WATER_ELEV };
}

describe('marchHeightfield', () => {
  it('hits displaced water under an oblique view, not the z=0 plane', () => {
    const target = { x: 0, y: 0, z: SURFACE_Z };
    const origin = { x: 8_000, y: -115_000, z: 48_000 };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };

    const hit = marchHeightfield(
      origin,
      dir,
      { min: { x: -50_000, y: -50_000, z: -4_000 }, max: { x: 50_000, y: 50_000, z: 2_000 } },
      EXAG,
      flatWater,
    );

    assert.ok(hit, 'expected a surface hit');
    assert.equal(hit.elevation, WATER_ELEV);

    const tPlane = -origin.z / dir.z;
    const z0 = {
      x: origin.x + dir.x * tPlane,
      y: origin.y + dir.y * tPlane,
    };
    const hitLocal = lonLatToLocal(hit.lon, hit.lat);
    const errSurface = Math.hypot(hitLocal.x - target.x, hitLocal.y - target.y);
    const errPlane = Math.hypot(z0.x - target.x, z0.y - target.y);

    assert.ok(errSurface < 40, `seafloor miss ${errSurface.toFixed(1)} m`);
    assert.ok(errPlane > 500, 'z=0 plane should be far from the visual water');
    assert.ok(errSurface < errPlane / 10, 'pick must not snap to the sea-level mesh');
  });

  it('returns the same depth from overhead as from an angle', () => {
    const target = lonLatToLocal(ORIGIN.lon, ORIGIN.lat);
    const hit = marchHeightfield(
      { x: target.x, y: target.y, z: 20_000 },
      { x: 0, y: 0, z: -1 },
      {
        min: { x: target.x - 1_000, y: target.y - 1_000, z: -4_000 },
        max: { x: target.x + 1_000, y: target.y + 1_000, z: 1_000 },
      },
      EXAG,
      flatWater,
    );
    assert.equal(hit?.elevation, WATER_ELEV);
  });

  it('skips nodata along the ray instead of returning a flashing null', () => {
    const origin = { x: 0, y: -2_000, z: 5_000 };
    const target = { x: 0, y: 0, z: SURFACE_Z };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const len = Math.hypot(dx, dy, dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };

    const hit = marchHeightfield(
      origin,
      dir,
      { min: { x: -500, y: -2_500, z: -4_000 }, max: { x: 500, y: 500, z: 6_000 } },
      EXAG,
      (x, y) => {
        const { lon, lat } = localToLonLat(x, y);
        if (y < -80) {
          return { lon, lat, elevation: null };
        }
        return { lon, lat, elevation: WATER_ELEV };
      },
    );

    assert.equal(hit?.elevation, WATER_ELEV);
  });
});

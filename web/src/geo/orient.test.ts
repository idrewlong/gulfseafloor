import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AOI } from '../geo.ts';
import { PLACES, STATE_LINES } from './orient.ts';

const names = () => PLACES.map((p) => p.name);

describe('AOI', () => {
  it('covers New Orleans, Orange Beach, and 42354', () => {
    assert.equal(AOI.west <= -90.135 && AOI.east >= -87.556, true);
    assert.equal(AOI.south <= 29.579 && AOI.north >= 30.294, true);
  });
});

describe('PLACES', () => {
  it('names every barrier island in the Sound', () => {
    for (const island of [
      'Cat Island',
      'West Ship Island',
      'East Ship Island',
      'Horn Island',
      'Petit Bois Island',
      'Dauphin Island',
      'Deer Island',
      'Round Island',
    ]) {
      assert.equal(names().includes(island), true, `missing ${island}`);
    }
  });

  it('names the coastal towns from Louisiana to Alabama', () => {
    for (const town of [
      'Pearlington',
      'Waveland',
      'Bay St. Louis',
      'Pass Christian',
      'Long Beach',
      'Gulfport',
      'Biloxi',
      'Ocean Springs',
      'Gautier',
      'Pascagoula',
      'Moss Point',
      'Grand Bay',
      'Bayou La Batre',
      'Fort Morgan',
      'Gulf Shores',
      'Orange Beach',
      'New Orleans',
      'Mobile',
    ]) {
      assert.equal(names().includes(town), true, `missing ${town}`);
    }
  });

  it('labels the three states that meet the Sound', () => {
    assert.equal(PLACES.some((p) => p.kind === 'state' && p.name === 'Louisiana'), true);
    assert.equal(PLACES.some((p) => p.kind === 'state' && p.name === 'Mississippi'), true);
    assert.equal(PLACES.some((p) => p.kind === 'state' && p.name === 'Alabama'), true);
  });
});

describe('STATE_LINES', () => {
  it('draws the Louisiana and Alabama borders across the AOI', () => {
    const keys = STATE_LINES.map((line) => line.name);
    assert.equal(keys.includes('Louisiana'), true);
    assert.equal(keys.includes('Alabama'), true);
    for (const line of STATE_LINES) {
      assert.ok(line.path.length >= 2, `${line.name} needs a polyline`);
      const hitsAoi = line.path.some(
        ([lon, lat]) => lon >= AOI.west - 0.15 && lon <= AOI.east + 0.15 && lat >= AOI.south - 0.15 && lat <= AOI.north + 0.15,
      );
      assert.equal(hitsAoi, true, `${line.name} should cross the map`);
    }
  });
});

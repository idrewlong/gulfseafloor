import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  METRES_TO_FEET,
  formatDepth,
  formatDepthShort,
  isDepthUnit,
  loadDepthUnit,
  saveDepthUnit,
  toUnit,
} from './units.ts';

describe('toUnit', () => {
  it('leaves metres alone', () => {
    assert.equal(toUnit(-30, 'm'), -30);
  });

  it('converts to feet at the survey-foot-free international ratio', () => {
    assert.equal(METRES_TO_FEET, 3.28084);
    assert.ok(Math.abs(toUnit(-30, 'ft') - -98.4252) < 1e-4);
  });

  it('keeps the sign, so depth stays negative and land stays positive', () => {
    assert.ok(toUnit(-2500, 'ft') < 0);
    assert.ok(toUnit(12, 'ft') > 0);
  });
});

describe('formatDepth', () => {
  it('marks depth with U+2212, not a hyphen, to match the other readouts', () => {
    assert.equal(formatDepth(-30, 'm'), '−30.0 m');
    assert.ok(formatDepth(-30, 'm').startsWith('−'));
  });

  it('signs land positive and leaves the waterline unsigned', () => {
    assert.equal(formatDepth(4, 'm'), '+4.0 m');
    assert.equal(formatDepth(0, 'm'), '0.0 m');
  });

  it('reads the Sound in feet', () => {
    assert.equal(formatDepth(-6, 'ft'), '−19.7 ft');
  });

  // A -2505 m sounding is -8218.5 ft. Carrying a decimal there implies survey
  // precision GEBCO does not have, and the legend has no room for it either.
  it('drops false precision on canyon-scale numbers', () => {
    assert.equal(formatDepth(-2505, 'ft'), '−8219 ft');
    assert.equal(formatDepth(-2505, 'm'), '−2505 m');
  });

  it('keeps a decimal in the shallows where it carries information', () => {
    assert.equal(formatDepth(-3.4, 'm'), '−3.4 m');
    assert.equal(formatDepth(-3.4, 'ft'), '−11.2 ft');
  });
});

describe('formatDepthShort', () => {
  it('rounds to whole units for the legend rail', () => {
    assert.equal(formatDepthShort(-2500, 'm'), '−2500 m');
    assert.equal(formatDepthShort(-2500, 'ft'), '−8202 ft');
    assert.equal(formatDepthShort(12, 'ft'), '+39 ft');
  });
});

describe('isDepthUnit', () => {
  it('accepts only the two units', () => {
    assert.equal(isDepthUnit('m'), true);
    assert.equal(isDepthUnit('ft'), true);
    assert.equal(isDepthUnit('fathoms'), false);
    assert.equal(isDepthUnit(undefined), false);
    assert.equal(isDepthUnit(null), false);
  });
});

describe('the stored preference', () => {
  it('falls back to metres when there is no storage at all', () => {
    assert.equal(loadDepthUnit(), 'm');
  });

  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    try {
      saveDepthUnit('ft');
      assert.equal(loadDepthUnit(), 'ft');
      saveDepthUnit('m');
      assert.equal(loadDepthUnit(), 'm');
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  });

  it('ignores a junk value rather than rendering "undefined" in the readout', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => 'fathoms', setItem: () => {} },
    });
    try {
      assert.equal(loadDepthUnit(), 'm');
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  });

  it('survives storage that throws, as private-mode Safari does', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      assert.equal(loadDepthUnit(), 'm');
      assert.doesNotThrow(() => saveDepthUnit('ft'));
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    }
  });
});

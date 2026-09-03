import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bracket, interpolateGrid, isStale } from './currentsTime.ts';
import type { VelocityStack } from './currentsField.ts';

const T0 = Date.parse('2026-09-03T12:00:00Z');
const T1 = Date.parse('2026-09-03T15:00:00Z');

const stack: VelocityStack = {
  nx: 2, ny: 1,
  bbox: { west: -89.7, south: 29.95, east: -87.85, north: 30.52 },
  times: [T0, T1],
  u: [[0.0, null], [1.0, 0.5]],
  v: [[0.0, 0.2], [-1.0, null]],
};

describe('bracket', () => {
  it('finds the surrounding steps and the fraction between them', () => {
    const b = bracket(stack.times, T0 + 90 * 60 * 1000);
    assert.deepEqual([b.i0, b.i1], [0, 1]);
    assert.equal(b.t, 0.5);
  });

  it('clamps before the first step and after the last', () => {
    assert.deepEqual(bracket(stack.times, T0 - 1e7), { i0: 0, i1: 0, t: 0 });
    assert.deepEqual(bracket(stack.times, T1 + 1e7), { i0: 1, i1: 1, t: 0 });
  });

  it('handles a one-step stack', () => {
    assert.deepEqual(bracket([T0], T1), { i0: 0, i1: 0, t: 0 });
  });
});

describe('interpolateGrid', () => {
  it('blends linearly between steps', () => {
    const g = interpolateGrid(stack, T0 + 90 * 60 * 1000);
    assert.equal(g.u[0], 0.5);
    assert.equal(g.v[0], -0.5);
    assert.equal(g.nx, 2);
    assert.equal(g.ny, 1);
  });

  // A null in either bracketing step must not become a fabricated velocity.
  it('propagates null from either side', () => {
    const g = interpolateGrid(stack, T0 + 90 * 60 * 1000);
    assert.equal(g.u[1], null);
    assert.equal(g.v[1], null);
  });

  it('returns a step exactly at its own time', () => {
    const g = interpolateGrid(stack, T1);
    assert.equal(g.u[0], 1.0);
    assert.equal(g.v[0], -1.0);
  });
});

describe('isStale', () => {
  it('is false inside the window and true outside it', () => {
    assert.equal(isStale(stack, T0 + 1000), false);
    assert.equal(isStale(stack, T0 - 1000), true);
    assert.equal(isStale(stack, T1 + 1000), true);
  });
});

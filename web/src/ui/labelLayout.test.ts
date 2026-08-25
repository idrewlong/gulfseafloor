import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleLabelIds } from './labelLayout.ts';

describe('visibleLabelIds', () => {
  it('keeps the higher-rank label when two sit on top of each other', () => {
    const visible = visibleLabelIds(
      [
        { id: 0, x: 10, y: 10, rank: 2 },
        { id: 1, x: 12, y: 11, rank: 0 },
      ],
      40,
    );
    assert.deepEqual([...visible], [1]);
  });

  it('keeps both when they are far enough apart', () => {
    const visible = visibleLabelIds(
      [
        { id: 0, x: 0, y: 0, rank: 1 },
        { id: 1, x: 200, y: 0, rank: 1 },
      ],
      40,
    );
    assert.equal(visible.size, 2);
    assert.equal(visible.has(0), true);
    assert.equal(visible.has(1), true);
  });

  it('drops a buoy when a place label is closer than minDist', () => {
    const visible = visibleLabelIds(
      [
        { id: 0, x: 10, y: 10, rank: 1 },
        { id: 100, x: 12, y: 11, rank: 10 },
      ],
      40,
    );
    assert.equal(visible.has(0), true);
    assert.equal(visible.has(100), false);
  });
});

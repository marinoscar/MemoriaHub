/**
 * test/sync/worker-pool.spec.ts
 *
 * Tests for the bounded concurrency worker pool.
 */

import { runPool } from '../../src/sync/worker-pool.js';

describe('runPool', () => {
  it('resolves immediately for an empty items list', async () => {
    let called = false;
    await runPool([], 4, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it('processes all items', async () => {
    const processed: number[] = [];
    await runPool([1, 2, 3, 4, 5], 3, async (item) => {
      processed.push(item);
    });
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds N concurrent workers', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const concurrency = 3;
    let activeCount = 0;
    let maxObserved = 0;

    await runPool(items, concurrency, async () => {
      activeCount++;
      maxObserved = Math.max(maxObserved, activeCount);
      // Small async step to allow other workers to start
      await new Promise<void>((r) => setTimeout(r, 5));
      activeCount--;
    });

    expect(maxObserved).toBeLessThanOrEqual(concurrency);
  });

  it('a throwing task does not abort the pool', async () => {
    const processed: number[] = [];
    const errors: number[] = [];

    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      if (item === 3) {
        errors.push(item);
        throw new Error('item 3 failed');
      }
      processed.push(item);
    });

    // All non-throwing items should have been processed
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
    expect(errors).toEqual([3]);
  });

  it('a throwing worker does not leave pool stuck — all items drain', async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const done: number[] = [];

    await runPool(items, 2, async (item) => {
      if (item % 2 === 0) throw new Error(`item ${item} throws`);
      done.push(item);
    });

    // Odd items (1, 3, 5, 7) should complete
    expect(done.sort((a, b) => a - b)).toEqual([1, 3, 5, 7]);
  });

  it('clamps concurrency to at least 1 even if 0 is passed', async () => {
    const processed: number[] = [];
    await runPool([10, 20], 0, async (item) => {
      processed.push(item);
    });
    expect(processed.sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('works correctly with concurrency larger than the item count', async () => {
    const items = [1, 2];
    const processed: number[] = [];
    await runPool(items, 100, async (item) => {
      processed.push(item);
    });
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('calls worker with the item and its index', async () => {
    const calls: Array<[number, number]> = [];
    await runPool(['a', 'b', 'c'], 2, async (item, index) => {
      calls.push([index, item.charCodeAt(0)]);
    });
    // All 3 items should be called with correct indices
    expect(calls).toHaveLength(3);
    const indices = calls.map(([idx]) => idx).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('concurrency=2 with 4 items results in ≤2 in-flight at any time', async () => {
    const items = [1, 2, 3, 4];
    let inFlight = 0;
    let maxInFlight = 0;

    await runPool(items, 2, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => setTimeout(r, 10));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

/**
 * sync/worker-pool.ts — Hand-rolled bounded concurrency pool.
 *
 * Runs `concurrency` workers simultaneously, each pulling the next item from
 * a shared cursor until the list is drained.  A failing worker task does NOT
 * abort the pool — errors are caught per-item and propagated through the
 * provided worker function (which is expected to handle errors itself, e.g.
 * by recording them in the DB and emitting a file:failed event).
 *
 * No external dependencies — only Node built-ins.
 */

/**
 * Run `worker` over every item in `items` with at most `concurrency`
 * simultaneous workers active at any time.
 *
 * A worker that throws does NOT stop the pool; other workers continue.
 * The returned promise resolves once all items have been processed.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  const cap = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  /**
   * Each "slot" is an async function that loops, pulling the next unprocessed
   * item from the shared cursor, running the worker, and repeating until the
   * list is exhausted.
   */
  async function runSlot(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;

      const item = items[index];
      try {
        await worker(item, index);
      } catch {
        // Per-item errors are swallowed here; the worker is responsible for
        // handling them (logging, DB update, emitting file:failed events).
        // This ensures a single bad file never aborts the entire pool.
      }
    }
  }

  // Spin up `cap` concurrent slots and wait for all of them to drain.
  const slots = Array.from({ length: Math.min(cap, items.length) }, runSlot);
  await Promise.all(slots);
}

// =============================================================================
// WebhookBatcher: bounded, time-boxed batches of ids for one event (RETRO-H4, #603)
// =============================================================================
//
// A media event is raised per ITEM by the code that wrote it (an upload, a
// trash, a purge), but delivered per BATCH: a 4 000-file import must not fan
// out 4 000 deliveries to every endpoint. The batcher keeps one open batch per
// bucket key (event, circle, and for a user event the user) and closes it when
//
//   * it holds `maxItems` entries (closed at once, in the caller's tick), or
//   * `windowMs` has passed since its first entry (a timer, `unref`'d so it
//     never holds the process open).
//
// Closing hands the batch to `flush`, which must be cheap and bounded (the
// owner enqueues one `webhooks.fanout` job). `flush` is never awaited by `add`:
// the caller (an HTTP request, a job) pays nothing for the webhook, and a
// failing flush is logged by the owner, never thrown into the write that
// triggered it.
//
// ONLY COMMITTED WRITES ENTER. Callers add after the write returned (outside
// any `$transaction`), so a rolled-back write never reaches a receiver.
//
// AT MOST ONCE. Open batches live in this process: `drain()` (called on
// shutdown) closes them, but a crash loses the open window (at most `maxItems`
// ids per bucket). Receivers that need completeness reconcile through the API.
// =============================================================================

/** One closed batch. */
export interface WebhookBatch<T> {
  readonly key: string;
  readonly items: readonly T[];
  /** When the first entry was added. */
  readonly windowStart: Date;
}

interface OpenBatch<T> {
  items: T[];
  windowStart: Date;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface WebhookBatcherOptions<T> {
  readonly maxItems: number;
  readonly windowMs: number;
  readonly flush: (batch: WebhookBatch<T>) => Promise<void>;
  /** Injected for tests. */
  readonly now?: () => Date;
}

export class WebhookBatcher<T> {
  private readonly open = new Map<string, OpenBatch<T>>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: WebhookBatcherOptions<T>) {
    if (options.maxItems < 1) throw new Error('maxItems must be at least 1');
  }

  /** Adds entries to the bucket `key`, closing full batches as it goes. */
  add(key: string, entries: readonly T[]): void {
    for (const entry of entries) {
      let batch = this.open.get(key);
      if (!batch) {
        batch = { items: [], windowStart: (this.options.now ?? (() => new Date()))(), timer: null };
        this.open.set(key, batch);
        const timer = setTimeout(() => this.close(key), this.options.windowMs);
        timer.unref?.();
        batch.timer = timer;
      }
      batch.items.push(entry);
      if (batch.items.length >= this.options.maxItems) this.close(key);
    }
  }

  /** Open buckets (for tests and diagnostics). */
  openKeys(): string[] {
    return [...this.open.keys()];
  }

  /** Closes every open batch and waits for every flush in flight. */
  async drain(): Promise<void> {
    for (const key of [...this.open.keys()]) this.close(key);
    await Promise.allSettled([...this.inFlight]);
  }

  private close(key: string): void {
    const batch = this.open.get(key);
    if (!batch) return;
    this.open.delete(key);
    if (batch.timer) clearTimeout(batch.timer);
    if (batch.items.length === 0) return;
    const pending = this.options
      .flush({ key, items: batch.items, windowStart: batch.windowStart })
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(pending));
    this.inFlight.add(pending);
  }
}

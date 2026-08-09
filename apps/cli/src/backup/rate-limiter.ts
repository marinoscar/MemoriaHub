/**
 * backup/rate-limiter.ts — Shared token-bucket bandwidth cap (issue #316,
 * epic #308).
 *
 * One bucket is shared across every download worker in the pool: each worker
 * calls `await bucket.take(chunk.length)` per streamed chunk, so the AGGREGATE
 * download rate — not the per-worker rate — is bounded by `maxMbps` (megabits
 * per second, decimal: 1 Mbps = 1e6 bits/s = 125 000 bytes/s).
 *
 * `maxMbps <= 0` disables the cap entirely (take() is a synchronous no-op).
 *
 * Deficit accounting: a take() larger than the current balance still proceeds
 * immediately after sleeping the deficit off, which keeps the implementation a
 * single await with no queue while remaining fair enough under the pool's
 * small (64 KiB-ish) chunk sizes. The bucket starts EMPTY (no initial burst)
 * so timing is deterministic. `now`/`sleep` are injectable for fake-clock
 * tests.
 */

export interface TokenBucketHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TokenBucket {
  /** Refill rate in bytes per millisecond; 0 = unlimited. Mutable via setRate(). */
  private ratePerMs: number;
  /** Maximum accumulated balance (one second's worth) — bounds idle bursts. */
  private capacity: number;
  /** The configured cap in Mbps, kept for reporting (`backup-status`). */
  private maxMbpsValue: number;
  /** Current balance in bytes (can go negative while a deficit is slept off). */
  private available = 0;
  private lastRefillAt: number;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(maxMbps: number, hooks: TokenBucketHooks = {}) {
    this.maxMbpsValue = maxMbps;
    this.ratePerMs = maxMbps > 0 ? (maxMbps * 1e6) / 8 / 1000 : 0;
    this.capacity = this.ratePerMs * 1000;
    this.now = hooks.now ?? Date.now;
    this.sleep = hooks.sleep ?? defaultSleep;
    this.lastRefillAt = this.now();
  }

  /** True when this bucket enforces no cap (maxMbps <= 0). */
  get unlimited(): boolean {
    return this.ratePerMs <= 0;
  }

  /** The currently configured cap in Mbps (0 = unlimited). */
  get maxMbps(): number {
    return this.maxMbpsValue;
  }

  /**
   * Change the cap LIVE (issue #318 — `backup set-rate` on a running daemon):
   * the new rate applies from the next take(). The balance is settled at the
   * old rate first, then clamped to the new capacity so a rate cut cannot
   * carry over a large old-rate burst.
   */
  setRate(maxMbps: number): void {
    this.refill();
    this.maxMbpsValue = maxMbps;
    this.ratePerMs = maxMbps > 0 ? (maxMbps * 1e6) / 8 / 1000 : 0;
    this.capacity = this.ratePerMs * 1000;
    if (this.available > this.capacity) this.available = this.capacity;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefillAt;
    if (elapsed > 0) {
      this.available = Math.min(this.capacity, this.available + elapsed * this.ratePerMs);
      this.lastRefillAt = t;
    }
  }

  /**
   * Consume `bytes` from the bucket, sleeping until the balance allows it.
   * A no-op when the bucket is unlimited.
   */
  async take(bytes: number): Promise<void> {
    if (this.unlimited || bytes <= 0) return;

    this.refill();
    this.available -= bytes;
    if (this.available < 0) {
      const waitMs = Math.ceil(-this.available / this.ratePerMs);
      await this.sleep(waitMs);
      this.refill();
    }
  }
}

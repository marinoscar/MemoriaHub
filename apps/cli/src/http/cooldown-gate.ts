/**
 * http/cooldown-gate.ts — Cooperative global throttle.
 *
 * At concurrency N, independent per-request backoff is not enough: a 429/503
 * seen by one worker doesn't stop the others from hammering the same endpoint.
 * The CooldownGate is a single shared object every HTTP call passes through.
 * When any worker observes a throttle it `trip()`s the gate, opening a global
 * cooldown window; every other worker's `acquire()` then waits out that window
 * before issuing its next request.
 *
 * The gate holds no timers and costs nothing when idle (acquire is a no-op
 * unless a cooldown window is currently open). `now`/`sleep` are injectable so
 * the cooperative behaviour is fully testable with a fake clock.
 */

export interface CooldownGateConfig {
  /** Base cooldown window (ms) applied on the first throttle trip. */
  cooldownMs: number;
  /** Ceiling for the exponential ramp (ms). */
  maxCooldownMs: number;
}

export const DEFAULT_COOLDOWN_CONFIG: CooldownGateConfig = {
  cooldownMs: 2_000,
  maxCooldownMs: 60_000,
};

export interface CooldownGateHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Notified with the window length (ms) each time the gate trips. */
  onTrip?: (delayMs: number) => void;
}

export class CooldownGate {
  private cooldownUntil = 0;
  private consecutiveTrips = 0;

  private readonly cfg: CooldownGateConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onTrip?: (delayMs: number) => void;

  constructor(cfg: CooldownGateConfig, hooks: CooldownGateHooks = {}) {
    this.cfg = cfg;
    this.now = hooks.now ?? Date.now;
    this.sleep =
      hooks.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onTrip = hooks.onTrip;
  }

  /**
   * Called BEFORE each request. If a cooldown window is active, await the
   * remainder; otherwise return immediately (zero cost when not throttled).
   */
  async acquire(): Promise<void> {
    const remaining = this.cooldownUntil - this.now();
    if (remaining > 0) {
      await this.sleep(remaining);
    }
  }

  /**
   * Open / extend the global cooldown window. Called when a worker observes a
   * 429/503. Uses the provider's `Retry-After` when supplied, otherwise an
   * exponential ramp on consecutive trips. Never shortens an existing window.
   */
  trip(retryAfterMs?: number | null): void {
    this.consecutiveTrips++;
    const ramp = Math.min(
      this.cfg.maxCooldownMs,
      this.cfg.cooldownMs * 2 ** (this.consecutiveTrips - 1),
    );
    const window = retryAfterMs != null ? retryAfterMs : ramp;
    const until = this.now() + window;
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
    }
    this.onTrip?.(window);
  }

  /** Called on a clean success — decays the ramp back toward baseline. */
  recordSuccess(): void {
    if (this.consecutiveTrips > 0) {
      this.consecutiveTrips--;
    }
  }

  /** True while a cooldown window is currently open (for inspection/tests). */
  isCoolingDown(): boolean {
    return this.cooldownUntil > this.now();
  }
}

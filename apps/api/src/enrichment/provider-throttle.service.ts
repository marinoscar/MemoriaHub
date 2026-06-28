// =============================================================================
// ProviderThrottleService — server-side per-provider cooldown gate
// =============================================================================
//
// At concurrency > 1, independent per-job backoff is insufficient: a 429 seen
// by one worker tick does not stop sibling jobs from hammering the same API.
// This service holds a CooldownGate per provider key so that a rate-limit event
// from any job immediately backs off all sibling jobs of the same kind.
//
// Provider key mapping (coarse, by job type):
//   auto_tagging   → 'tagging'   (single AI tagging provider configured at a time)
//   geocode        → 'geocode'   (single reverse-geocode provider at a time)
//   face_detection → 'face'      (rekognition / compreface / human — one active)
//   all others     → null        (not throttled: storage, insights, trash, etc.)
//
// The coarse mapping is intentional to avoid per-job DB reads to look up the
// active provider. It is correct because only one provider per feature type is
// configured at any time, so all same-type jobs share the same network backend.
// If the offline geocode provider is active it generates no 429s, so the gate
// will never trip — a no-op acquire is essentially free.
// =============================================================================

import { Injectable, Optional } from '@nestjs/common';

interface GateState {
  cooldownUntil: number;
  consecutiveTrips: number;
}

const BASE_MS = 2_000;
const MAX_MS = 60_000;

/**
 * Per-provider cooperative cooldown gate.
 *
 * acquire(provider): awaits the remaining cooldown window for that provider.
 *   No-op when the gate is idle — zero cost on the happy path.
 * trip(provider, retryAfterMs?): opens / extends the cooldown window after a
 *   rate-limit event; uses exponential ramp when no Retry-After header given.
 * recordSuccess(provider): decays the exponential ramp on a clean success.
 */
@Injectable()
export class ProviderThrottleService {
  // Exposed for unit testing (inspect gate state)
  readonly _gates = new Map<string, GateState>();

  // Injectable hooks for fake-clock / fake-sleep in unit tests
  private readonly _now: () => number;
  private readonly _sleep: (ms: number) => Promise<void>;

  constructor(
    // @Optional() prevents Nest from attempting to resolve this plain-object
    // parameter as an injectable dependency (it has no provider token).
    // Nest injects `undefined` for unresolvable optional params, and the `= {}`
    // default kicks in — giving production behaviour with no args.
    // Unit tests construct `new ProviderThrottleService({ now, sleep })` directly
    // (bypassing the Nest container entirely) so test construction is unchanged.
    @Optional()
    hooks: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this._now = hooks.now ?? Date.now.bind(Date);
    this._sleep =
      hooks.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Maps an enrichment job type to a throttle-provider key.
   * Returns null for job types that do not need throttling.
   */
  static resolveKey(jobType: string): string | null {
    switch (jobType) {
      case 'auto_tagging':
        return 'tagging';
      case 'geocode':
        return 'geocode';
      case 'face_detection':
        return 'face';
      default:
        // storage_migration, storage_insights, trash_purge, metadata_extraction,
        // burst_detection — local or already AWS-SDK-retried; not throttled here.
        return null;
    }
  }

  private gate(provider: string): GateState {
    let g = this._gates.get(provider);
    if (!g) {
      g = { cooldownUntil: 0, consecutiveTrips: 0 };
      this._gates.set(provider, g);
    }
    return g;
  }

  /**
   * Await the remaining cooldown window for `provider`, if any.
   * Returns immediately (no allocation, no await) when the gate is idle.
   */
  async acquire(provider: string): Promise<void> {
    const g = this._gates.get(provider);
    if (!g) return; // gate not yet created → no cooldown ever tripped
    const remaining = g.cooldownUntil - this._now();
    if (remaining > 0) {
      await this._sleep(remaining);
    }
  }

  /**
   * Open or extend the cooldown window after a rate-limit event.
   *
   * When `retryAfterMs` is provided (from a Retry-After response header) that
   * value is used directly. Otherwise an exponential ramp is applied on
   * consecutive trips, capped at MAX_MS. Never shortens an existing window.
   */
  trip(provider: string, retryAfterMs?: number | null): void {
    const g = this.gate(provider);
    g.consecutiveTrips++;
    const ramp = Math.min(MAX_MS, BASE_MS * 2 ** (g.consecutiveTrips - 1));
    const window = retryAfterMs != null ? retryAfterMs : ramp;
    const until = this._now() + window;
    if (until > g.cooldownUntil) {
      g.cooldownUntil = until;
    }
  }

  /**
   * Decay the exponential ramp toward baseline after a clean success.
   * Has no effect when the gate has never been tripped.
   */
  recordSuccess(provider: string): void {
    const g = this._gates.get(provider);
    if (g && g.consecutiveTrips > 0) {
      g.consecutiveTrips--;
    }
  }

  /** True while a cooldown window is currently active (for inspection / tests). */
  isCoolingDown(provider: string): boolean {
    const g = this._gates.get(provider);
    return g != null && g.cooldownUntil > this._now();
  }
}

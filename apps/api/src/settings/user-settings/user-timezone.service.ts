// =============================================================================
// UserTimeZoneService (issue #444)
// =============================================================================
//
// Resolves a user's effective IANA time zone out of the existing
// `user_settings.value` JSONB (key `timezone`) and caches the result
// in-process. NO new table, NO new endpoint, NO migration, NO new permission —
// the key is read/written exclusively through GET/PATCH/PUT /api/user-settings.
//
// THIS IS THE ONE PLACE THE 'UTC' FALLBACK LIVES.
//   The stored value is optional and is never materialized: absent means "no
//   preference expressed", which is deliberately DISTINCT from an explicit
//   'UTC'. Every read path that surfaces the preference to a client (GET
//   /api/user-settings, GET /api/auth/me) returns it RAW so the client can tell
//   the two apart and decide whether to prompt. Every SERVER-side consumer that
//   needs a concrete zone to format or bucket a date comes here instead, so
//   there is exactly one definition of "and if they never chose?".
//
// WHY THE CACHE (and why it is a Map, not a slot).
//   Modeled directly on NotificationPreferencesService: same 5 s TTL, same
//   per-user Map, same bounded expiry sweep, same explicit invalidation on the
//   settings write. The reason is the same too — consumers call this per user
//   in loops (a date-grouped listing, a digest render over a circle's whole
//   membership), and an uncached read would add a `user_settings` round-trip to
//   each. A single un-keyed slot like SystemSettingsService's would serve one
//   user's zone to another, so it must be keyed.
//
//   prime() is the batched form for callers that know their whole recipient set
//   up front: one `findMany` instead of N `findUnique`s.
//
// FAIL-OPEN.
//   Any read failure (DB down, malformed JSONB, a stored zone this runtime's
//   ICU does not know) resolves to 'UTC' with a logged warning. A time-zone
//   lookup must never be the reason a listing 500s; rendering a date in the
//   wrong zone is a far smaller failure than not rendering it at all.
//
// Reads `user_settings` through PrismaService DIRECTLY rather than through
// UserSettingsService — not to dodge a cycle (both live in SettingsModule), but
// because getSettings() CREATES a default row as a side effect. A read-only
// resolution must never write.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { isSupportedTimeZone } from '../../common/time/zone.util';
import { PrismaService } from '../../prisma/prisma.service';

/** TTL for the per-user zone cache. Mirrors NOTIFICATION_PREFERENCES_CACHE_TTL_MS. */
export const USER_TIMEZONE_CACHE_TTL_MS = 5000;

/**
 * Soft bound on the cache. Exceeding it sweeps expired entries, and clears the
 * map wholesale if it is still over afterwards — the same bounding strategy as
 * NotificationPreferencesService. Worst case that costs a few extra reads; it
 * is never unbounded memory.
 */
const TIMEZONE_CACHE_MAX_ENTRIES = 5000;

/** The zone used for a user who has expressed no preference. */
export const DEFAULT_USER_TIME_ZONE = 'UTC';

@Injectable()
export class UserTimeZoneService {
  private readonly logger = new Logger(UserTimeZoneService.name);

  private readonly cache = new Map<
    string,
    { value: string; cachedAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The zone to render this user's dates in. Cached; fail-open to 'UTC'.
   *
   * Always returns a zone `Intl` accepts, so callers can hand the result
   * straight to a formatter without a second validation.
   */
  async resolveUserTimeZone(userId: string): Promise<string> {
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && now - hit.cachedAt < USER_TIMEZONE_CACHE_TTL_MS) {
      return hit.value;
    }

    try {
      const row = await this.prisma.userSettings.findUnique({
        where: { userId },
        select: { value: true },
      });
      const resolved = this.coerce(this.readStored(row?.value));
      this.store(userId, resolved, now);
      return resolved;
    } catch (err) {
      this.logger.warn(
        `time zone lookup for user ${userId} failed, defaulting to ` +
          `${DEFAULT_USER_TIME_ZONE}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return DEFAULT_USER_TIME_ZONE;
    }
  }

  /**
   * Warm the cache for a known set of users in ONE query.
   *
   * Best-effort — a failure leaves the cache cold and resolveUserTimeZone()
   * falls back to its own (also fail-open) per-user read.
   */
  async prime(userIds: readonly string[]): Promise<void> {
    const now = Date.now();
    const missing = [
      ...new Set(
        userIds.filter((id) => {
          const hit = this.cache.get(id);
          return !hit || now - hit.cachedAt >= USER_TIMEZONE_CACHE_TTL_MS;
        }),
      ),
    ];
    if (missing.length === 0) return;

    try {
      const rows = await this.prisma.userSettings.findMany({
        where: { userId: { in: missing } },
        select: { userId: true, value: true },
      });

      const byUser = new Map(rows.map((r) => [r.userId, r.value]));
      for (const userId of missing) {
        // A user with NO settings row caches as 'UTC' too — that is a real
        // answer (absent means no preference), not a miss to retry.
        this.store(userId, this.coerce(this.readStored(byUser.get(userId))), now);
      }
    } catch (err) {
      this.logger.warn(
        `time zone prime for ${missing.length} user(s) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Drop a user's cached zone. Called on the settings write so a change takes
   * effect on the very next read rather than up to one TTL later — the same
   * contract NotificationPreferencesService gives its toggles.
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Pull the `timezone` key out of a raw `user_settings.value`. Anything that
   * is not a non-empty string reads as absent — the stored blob is
   * schema-validated on write, but this read path must not assume a
   * hand-edited row is well formed.
   */
  private readStored(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const tz = (value as Record<string, unknown>)['timezone'];
    return typeof tz === 'string' && tz.length > 0 ? tz : undefined;
  }

  /**
   * Apply the fallback, re-validating on the way through: a zone written under
   * one ICU build can be unknown to another (a renamed zone, a slimmer
   * container image), and handing an unknown zone to `Intl` throws at the
   * formatter rather than here.
   */
  private coerce(stored: string | undefined): string {
    if (!stored) return DEFAULT_USER_TIME_ZONE;
    if (isSupportedTimeZone(stored)) return stored;

    this.logger.warn(
      `stored time zone "${stored}" is unknown to this runtime, ` +
        `falling back to ${DEFAULT_USER_TIME_ZONE}`,
    );
    return DEFAULT_USER_TIME_ZONE;
  }

  private store(userId: string, value: string, now: number): void {
    this.prune(now);
    this.cache.set(userId, { value, cachedAt: now });
  }

  private prune(now: number): void {
    if (this.cache.size < TIMEZONE_CACHE_MAX_ENTRIES) return;

    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt >= USER_TIMEZONE_CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }

    if (this.cache.size >= TIMEZONE_CACHE_MAX_ENTRIES) {
      this.cache.clear();
    }
  }
}

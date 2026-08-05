// =============================================================================
// Notification Preferences (epic #240, issue #251)
// =============================================================================
//
// Resolves a user's per-type notification preferences out of the existing
// `user_settings.value` JSONB (namespace `notifications`) and caches the result
// in-process. NO new table, NO new endpoint, NO migration, NO new permission —
// the namespace is read/written exclusively through GET/PATCH/PUT
// /api/user-settings, and this service is its only server-side READER.
//
// ABSENT MEANS ENABLED.
//   An absent namespace, an absent `enabled`, or an absent per-type key all
//   resolve to TRUE. That is what makes this feature migration-free (every
//   existing row has no namespace, so nobody is muted by shipping it) and makes
//   a newly added NotificationType opt-OUT rather than opt-in. resolve() must
//   therefore never treat "missing" as "false".
//
//   ONE deliberate inversion: `workflowMicroRuns` defaults to FALSE. #247
//   suppresses `on_media_enriched` workflow micro-runs unconditionally because
//   they fire continuously during an import; #251 makes that re-enableable, but
//   the un-set state has to keep matching #247's shipped behavior. The
//   inversion lives HERE and not in the zod schema, so the schema keeps one
//   uniform "optional, no default" rule (see settings.schema.ts).
//
// WHY THE CACHE (and why it is a Map, not a slot).
//   NotificationsService gates every write on isEnabled(), and its producers
//   call it PER RECIPIENT in hot loops: a bulk upload fans `upsertCountedEvent`
//   out to every circle member for every file, and #246's hourly reconcile
//   calls `upsertState` once per (member x queue). An uncached read would add a
//   `user_settings` round-trip to each of those. The TTL mirrors
//   SystemSettingsService.getSettings() (5 s) — long enough to collapse a burst
//   of fan-out, short enough that a toggle takes effect essentially
//   immediately — and the entry is invalidated OUTRIGHT on the settings write
//   (UserSettingsService -> NotificationsService.invalidatePreferences), so the
//   user's own change is never subject to the TTL at all.
//
//   Unlike SystemSettingsService's single un-keyed slot, this is a Map keyed by
//   userId — preferences are per user, and a single slot would serve one user's
//   preferences to another. Same divergence, and the same reason, as
//   NotificationsService's per-user unread-count cache.
//
//   prime() is the batched form: #246's reconcile knows a circle's whole
//   eligible membership up front, so it fetches every uncached member's
//   preferences in ONE `findMany` instead of N `findUnique`s.
//
// FAIL-OPEN.
//   Any read failure (DB down, malformed JSONB) resolves to "everything
//   enabled" with a logged warning. A preferences lookup must never be the
//   reason a notification silently disappears; the failure mode of a gate is
//   over-notifying, never under-notifying.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';

import { NotificationPreferencesValue } from '../common/types/settings.types';
import { PrismaService } from '../prisma/prisma.service';

/** TTL for the per-user preferences cache. Mirrors SETTINGS_CACHE_TTL_MS. */
export const NOTIFICATION_PREFERENCES_CACHE_TTL_MS = 5000;

/**
 * Soft bound on the cache. Exceeding it sweeps expired entries, and clears the
 * map wholesale if it is still over afterwards — same bounding strategy as
 * NotificationsService's unread-count cache. Worst case that costs a few extra
 * reads; it is never unbounded memory.
 */
const PREFERENCES_CACHE_MAX_ENTRIES = 5000;

/**
 * A user's preferences with every default already applied — no optional fields,
 * so callers can never accidentally re-derive "absent means ..." differently.
 */
export interface ResolvedNotificationPreferences {
  /** Master switch. */
  enabled: boolean;
  /** Effective per-type switch — already ANDed with `enabled`. */
  types: Record<NotificationType, boolean>;
  /** Whether `on_media_enriched` workflow micro-runs may notify. */
  workflowMicroRuns: boolean;
}

/** Every enum member, resolved once. */
const ALL_TYPES = Object.values(NotificationType) as NotificationType[];

/**
 * Apply the absent-key defaults to a stored `notifications` namespace.
 *
 * Pure and exported so the settings write path can diff "before" against
 * "after" using exactly the same rules the read path enforces — a second,
 * hand-rolled interpretation of the defaults there is precisely how a
 * dismiss-on-disable would come to disagree with the gate.
 */
export function resolveNotificationPreferences(
  value: NotificationPreferencesValue | null | undefined,
): ResolvedNotificationPreferences {
  // `!== false` (not `=== true`): absent and malformed both mean enabled.
  const enabled = value?.enabled !== false;
  const stored = value?.types ?? {};

  const types = {} as Record<NotificationType, boolean>;
  for (const type of ALL_TYPES) {
    types[type] = enabled && stored[type] !== false;
  }

  return {
    enabled,
    types,
    // The one inverted default — see the header.
    workflowMicroRuns: value?.workflowMicroRuns === true,
  };
}

/** Everything on: the fail-open value, and the value for a user with no row. */
export function defaultNotificationPreferences(): ResolvedNotificationPreferences {
  return resolveNotificationPreferences(undefined);
}

/**
 * Every type a stored namespace SUPPRESSES (master switch off ⇒ all of them).
 *
 * This is what the settings write path dismisses live rows for. It returns the
 * types disabled AFTER the write rather than the ones newly disabled BY it, on
 * purpose: dismissing a type that was already off is a no-op (the gate means it
 * has no live rows), it needs no "before" snapshot, and it makes every settings
 * save self-healing if a row for a suppressed type ever exists.
 */
export function disabledNotificationTypes(
  value: NotificationPreferencesValue | null | undefined,
): NotificationType[] {
  const resolved = resolveNotificationPreferences(value);
  return ALL_TYPES.filter((type) => !resolved.types[type]);
}

@Injectable()
export class NotificationPreferencesService {
  private readonly logger = new Logger(NotificationPreferencesService.name);

  private readonly cache = new Map<
    string,
    { value: ResolvedNotificationPreferences; cachedAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  /** Resolved preferences for one user. Cached; fail-open. */
  async resolve(userId: string): Promise<ResolvedNotificationPreferences> {
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && now - hit.cachedAt < NOTIFICATION_PREFERENCES_CACHE_TTL_MS) {
      return hit.value;
    }

    try {
      const row = await this.prisma.userSettings.findUnique({
        where: { userId },
        select: { value: true },
      });
      const resolved = resolveNotificationPreferences(
        this.readNamespace(row?.value),
      );
      this.store(userId, resolved, now);
      return resolved;
    } catch (err) {
      this.logger.warn(
        `notification preferences lookup for user ${userId} failed, ` +
          `defaulting to all-enabled: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return defaultNotificationPreferences();
    }
  }

  /**
   * Is this type currently deliverable to this user? The gate every
   * NotificationsService write path calls.
   */
  async isEnabled(userId: string, type: NotificationType): Promise<boolean> {
    const prefs = await this.resolve(userId);
    // `!== false` guards a type added to the enum after this object was built
    // (impossible today, since resolve() enumerates the live enum, but the
    // absent-means-enabled rule should hold structurally, not by luck).
    return prefs.types[type] !== false;
  }

  /** Opt-in check for `on_media_enriched` workflow micro-runs (#247 / #251). */
  async allowsWorkflowMicroRuns(userId: string): Promise<boolean> {
    const prefs = await this.resolve(userId);
    return prefs.enabled && prefs.workflowMicroRuns;
  }

  /**
   * Warm the cache for a known set of users in ONE query.
   *
   * Used by #246's review-queue reconcile, which holds a circle's whole
   * eligible membership before it fans `upsertState` out across it: priming
   * turns N `findUnique`s into one `findMany` over the users not already
   * cached. Best-effort — a failure leaves the cache cold and resolve() falls
   * back to its own (also fail-open) per-user read.
   */
  async prime(userIds: readonly string[]): Promise<void> {
    const now = Date.now();
    const missing = [
      ...new Set(
        userIds.filter((id) => {
          const hit = this.cache.get(id);
          return !hit || now - hit.cachedAt >= NOTIFICATION_PREFERENCES_CACHE_TTL_MS;
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
        // A user with NO settings row is cached as all-enabled too — that is a
        // real answer (absent means enabled), not a cache miss to retry.
        this.store(
          userId,
          resolveNotificationPreferences(this.readNamespace(byUser.get(userId))),
          now,
        );
      }
    } catch (err) {
      this.logger.warn(
        `notification preferences prime for ${missing.length} user(s) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Drop a user's cached preferences. Called on the settings write so a toggle
   * takes effect on the very next notification rather than up to one TTL later
   * — the same contract SystemSettingsService gives its feature flags.
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Pull the `notifications` namespace out of a raw `user_settings.value`.
   * Anything that is not a plain object reads as absent, i.e. all defaults —
   * the stored blob is schema-validated on write, but this read path must not
   * assume a hand-edited row is well formed.
   */
  private readNamespace(value: unknown): NotificationPreferencesValue | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const ns = (value as Record<string, unknown>)['notifications'];
    if (!ns || typeof ns !== 'object' || Array.isArray(ns)) return undefined;
    return ns as NotificationPreferencesValue;
  }

  private store(
    userId: string,
    value: ResolvedNotificationPreferences,
    now: number,
  ): void {
    this.prune(now);
    this.cache.set(userId, { value, cachedAt: now });
  }

  private prune(now: number): void {
    if (this.cache.size < PREFERENCES_CACHE_MAX_ENTRIES) return;

    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt >= NOTIFICATION_PREFERENCES_CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }

    if (this.cache.size >= PREFERENCES_CACHE_MAX_ENTRIES) {
      this.cache.clear();
    }
  }
}

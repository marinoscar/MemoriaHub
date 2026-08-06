// =============================================================================
// Notifications Service (epic #240, issue #245)
// =============================================================================
//
// The SINGLE write path for the notifications table. Producers (#246 review
// queue watcher, #247 event producers) call emit()/upsertState() here rather
// than touching Prisma directly, so the state-vs-event dedup semantics live in
// exactly one place and cannot drift between callers.
//
//   emit()        — EVENT types (workflow_run_completed, share_expiring): one
//                   row per occurrence, appended freely, never deduplicated.
//   upsertCountedEvent()
//                 — EVENT types that must NOT fan out (upload_completed,
//                   enrichment_failed): repeated occurrences fold into one row
//                   whose data.count grows, optionally inside a rolling time
//                   window. Event types have no partial unique index behind
//                   them, so the find-or-create is serialized with a
//                   transaction-scoped Postgres advisory lock.
//   upsertState() — STATE types (the four review_queue_*): at most ONE LIVE
//                   row per (userId, circleId, type), refreshed in place. A
//                   circle with 929 pending duplicate groups produces exactly
//                   one row for a given user, never 929. Enforced in the DB by
//                   the partial unique index notifications_review_queue_live_uniq_idx
//                   (migration 20260805000000_add_notifications).
//
// Both are BEST-EFFORT / fire-and-forget from the caller's perspective: a
// failed notification write logs a warning and NEVER throws into or blocks the
// triggering action. Same contract as the transactional email sends
// (EmailService.sendEmailAsync) — a notification is never important enough to
// fail the user-facing operation that produced it.
//
// PER-TYPE USER PREFERENCES (#251) ARE ENFORCED HERE, in all THREE write paths
// above, and deliberately NOT in the producers. A suppressed type writes no row
// at all, and no producer — present or future — has to remember to check: if it
// goes through this service, it is gated. The lookup is the cached
// NotificationPreferencesService (per-user, 5 s TTL, invalidated on the
// settings write), because these methods are called per RECIPIENT in hot loops.
// The gate is fail-open by construction: a preferences read that fails resolves
// to all-enabled, so a broken lookup over-notifies rather than silently
// swallowing everything.
// =============================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Notification, NotificationType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationItemDto } from './dto/notification-response.dto';
import { NotificationPreferencesService } from './notification-preferences.service';

// -----------------------------------------------------------------------------
// Unread-count cache tuning
// -----------------------------------------------------------------------------

/**
 * TTL for the in-memory unread-count cache, in milliseconds.
 *
 * Mirrors STATS_CACHE_TTL_MS in EnrichmentAdminService (2 s) — short enough
 * that a polling bell badge never visibly lags, long enough to collapse the
 * realistic concurrency case (several tabs polling the same user's badge).
 *
 * DIVERGENCE FROM THE MIRRORED PATTERN (deliberate): EnrichmentAdminService
 * caches into a SINGLE un-keyed slot, which is correct there because job stats
 * are global — every admin sees the same numbers. Unread counts are PER USER,
 * so a single slot would serve one user's badge count to another. This cache is
 * therefore a Map keyed by userId.
 */
const UNREAD_COUNT_CACHE_TTL_MS = 2000;

/**
 * Soft bound on the unread-count cache. Exceeding it triggers a sweep of
 * expired entries; if the map is STILL over the bound afterwards (i.e. that
 * many distinct users polled within the 2 s window), it is cleared wholesale.
 * Worst case that costs a few extra COUNT queries — never unbounded memory.
 */
const UNREAD_COUNT_CACHE_MAX_ENTRIES = 5000;

// -----------------------------------------------------------------------------
// Producer input shapes (consumed by #246 / #247)
// -----------------------------------------------------------------------------

/** Input for an EVENT-type notification (one row per occurrence). */
export interface EmitNotificationInput {
  userId: string;
  circleId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Prisma.InputJsonValue | null;
}

/**
 * Input for a STATE-type notification (one LIVE row per user+circle+type).
 * `circleId` is required — there is no "global" review queue, and the partial
 * unique index's `circle_id IS NOT NULL` predicate would not cover a null.
 */
export interface UpsertStateNotificationInput {
  userId: string;
  circleId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Prisma.InputJsonValue | null;
}

/**
 * Input for a COUNTED EVENT notification (#247) — the third producer primitive.
 *
 * `emit()` appends one row per occurrence, which is right for a workflow run
 * finishing but catastrophic for a 4 000-file import (4 000 rows) or a
 * poison-pill batch (400 rows). This primitive instead folds repeated
 * occurrences into ONE row whose `data.count` grows.
 *
 * It is NOT `upsertState()`: state rows are keyed on (userId, circleId, type)
 * and protected by a partial unique index that covers only the four
 * `review_queue_*` types. Event types have no such index, so the find-or-create
 * here is serialized with a transaction-scoped Postgres ADVISORY LOCK on the
 * aggregation key — see upsertCountedEvent() for the full rationale.
 *
 * Two aggregation shapes are expressed by the same primitive:
 *   - `windowMs` set    → a ROLLING window (upload_completed: 15 min). A live
 *                         row older than the window is left alone and a NEW row
 *                         is started, so an import next week is its own row.
 *   - `windowMs` unset  → accumulate until dismissed (enrichment_failed).
 *   - `matchData`       → an extra JSONB equality predicate that further
 *                         partitions live rows beyond (userId, circleId, type);
 *                         enrichment_failed uses `{ jobType }` to keep one row
 *                         per failing job type.
 */
export interface UpsertCountedEventInput {
  userId: string;
  circleId?: string | null;
  type: NotificationType;
  /**
   * Extra JSONB containment predicate partitioning live rows, e.g.
   * `{ jobType: 'auto_tagging' }`. Every key here MUST also appear in `data`,
   * or the row this call creates will not be found by the next one.
   */
  matchData?: Record<string, string>;
  /** Rolling-window width in ms. Omit/null = accumulate until dismissed. */
  windowMs?: number | null;
  /** Amount added to `data.count` (default 1). */
  increment?: number;
  /** Builds the title from the RESULTING total, so pluralization is caller-side. */
  buildTitle: (count: number) => string;
  body?: string | null;
  link?: string | null;
  /**
   * Extra payload merged alongside `count`. `null` is allowed (and serializes
   * to a JSON null) — an absent `lastError` is meaningful context, not a reason
   * to omit the key.
   */
  data?: Record<string, Prisma.InputJsonValue | null>;
  /**
   * Clear `read_at` when an EXISTING row is incremented, so continued activity
   * re-badges the bell. The event-type analog of #246's re-unread rule: there,
   * a read STATE row is re-unread when its queue grows past the acknowledged
   * `countAtRead`; here, any increment IS new activity by construction (the row
   * only grows when something new happened), so no snapshot comparison is
   * needed. Off by default — the caller opts in.
   */
  reunreadOnIncrement?: boolean;
}

export interface NotificationListResult {
  items: NotificationItemDto[];
  meta: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export type NotificationStatusFilter = 'unread' | 'read' | 'all' | 'dismissed';

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /** Per-user TTL cache for getUnreadCount() — see UNREAD_COUNT_CACHE_TTL_MS. */
  private readonly unreadCountCache = new Map<string, { value: number; cachedAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read paths
  // ---------------------------------------------------------------------------

  /**
   * Paginated list, newest first. Served by the
   * (user_id, created_at DESC) index.
   */
  async list(
    userId: string,
    query: {
      status?: NotificationStatusFilter;
      circleId?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<NotificationListResult> {
    const status = query.status ?? 'all';
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.circleId ? { circleId: query.circleId } : {}),
      ...this.buildStatusWhere(status),
    };

    const [totalItems, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        // `id` tiebreak keeps pagination deterministic when several rows share
        // a created_at (a producer sweep can write many rows in one statement).
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => this.toDto(row)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
      },
    };
  }

  /**
   * Unread badge count for the bell — live (non-dismissed), never-read rows
   * across every circle. Cached per user for UNREAD_COUNT_CACHE_TTL_MS.
   */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const now = Date.now();
    const hit = this.unreadCountCache.get(userId);
    if (hit && now - hit.cachedAt < UNREAD_COUNT_CACHE_TTL_MS) {
      return { count: hit.value };
    }

    const count = await this.prisma.notification.count({
      where: { userId, readAt: null, dismissedAt: null },
    });

    this.pruneUnreadCountCache(now);
    this.unreadCountCache.set(userId, { value: count, cachedAt: now });
    return { count };
  }

  // ---------------------------------------------------------------------------
  // Single-row mutations
  // ---------------------------------------------------------------------------

  /**
   * Mark one notification read. Idempotent — `read_at` is preserved via
   * COALESCE so a second call does not move the original read timestamp.
   *
   * countAtRead snapshot (contract with #246): for rows whose `data.count`
   * exists (the review_queue_* STATE types), `data.countAtRead` is set to the
   * current `data.count`. #246 re-marks such a row unread only when the queue
   * has since grown past what the user last saw. countAtRead IS refreshed on a
   * repeat read of an already-read row — an explicit "I've seen it" gesture
   * should always snapshot what is on screen right now.
   *
   * Raw SQL rather than a read-then-write: it is one atomic statement, and the
   * per-row JSONB merge (jsonb_set) has no representation in Prisma's typed
   * update API.
   *
   * `jsonb_exists(data, 'count')` is used in preference to the equivalent
   * `data ? 'count'` operator: `?` is a parameter placeholder in many SQL
   * layers, there is no `?`-operator precedent anywhere in this repo, and the
   * function form removes any question about how Prisma's tagged-template
   * parser treats it.
   */
  async markRead(userId: string, id: string): Promise<void> {
    const affected = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE notifications
      SET read_at = COALESCE(read_at, now()),
          updated_at = now(),
          data = CASE
                   WHEN jsonb_exists(data, 'count')
                     THEN jsonb_set(data, '{countAtRead}', data->'count')
                   ELSE data
                 END
      WHERE id = ${id}::uuid
        AND user_id = ${userId}::uuid
    `);

    // Cross-user access is a 404, not a 403: scoping by user_id means another
    // user's valid id is indistinguishable from a nonexistent one
    // (enumeration-resistant, matching the public-share 404 policy).
    if (affected === 0) {
      throw new NotFoundException('Notification not found');
    }

    this.invalidateUnreadCount(userId);
  }

  /**
   * Dismiss one notification. Idempotent, and implies read — `read_at` is set
   * if it was null, so a dismissed row never lingers in the unread count.
   *
   * No countAtRead snapshot here: a dismissed row is excluded from every live
   * listing and from the unread count, and #246's re-mark-unread logic only
   * ever considers LIVE rows, so the snapshot would have no reader.
   */
  async dismiss(userId: string, id: string): Promise<void> {
    const affected = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE notifications
      SET dismissed_at = COALESCE(dismissed_at, now()),
          read_at = COALESCE(read_at, now()),
          updated_at = now()
      WHERE id = ${id}::uuid
        AND user_id = ${userId}::uuid
    `);

    if (affected === 0) {
      throw new NotFoundException('Notification not found');
    }

    this.invalidateUnreadCount(userId);
  }

  /** Hard-delete one notification row. 404 when it is not the caller's. */
  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notification.deleteMany({
      where: { id, userId },
    });

    if (result.count === 0) {
      throw new NotFoundException('Notification not found');
    }

    this.invalidateUnreadCount(userId);
  }

  // ---------------------------------------------------------------------------
  // Bulk mutations
  // ---------------------------------------------------------------------------

  /**
   * Mark every unread LIVE notification read, optionally scoped to one circle.
   *
   * Two statements, because `updateMany` cannot perform a per-row JSONB merge:
   *
   *   1. Raw UPDATE over rows WITH `data.count`, applying the same countAtRead
   *      snapshot as markRead().
   *   2. A plain `updateMany` for everything else.
   *
   * Order matters and removes the need for a negated JSON predicate (which
   * Prisma's typed `where` cannot express): step 1 has already set `read_at`
   * on the rows it touched, so they no longer satisfy step 2's
   * `readAt: null`, and step 2 naturally picks up exactly the remainder.
   * Both run in one transaction so `updated` is a consistent total.
   *
   * `updated_at = now()` is set EXPLICITLY in the raw statement: the column has
   * no database trigger — it is Prisma-side `@updatedAt` only, which raw SQL
   * bypasses. Omitting it would silently break #248's retention purge, which
   * keys off (dismissed_at, updated_at).
   */
  async markAllRead(userId: string, circleId?: string): Promise<{ updated: number }> {
    const circleClause = circleId
      ? Prisma.sql`AND circle_id = ${circleId}::uuid`
      : Prisma.empty;

    const [withCount, withoutCount] = await this.prisma.$transaction(async (tx) => {
      const a = await tx.$executeRaw(Prisma.sql`
        UPDATE notifications
        SET read_at = now(),
            updated_at = now(),
            data = jsonb_set(data, '{countAtRead}', data->'count')
        WHERE user_id = ${userId}::uuid
          AND read_at IS NULL
          AND dismissed_at IS NULL
          AND jsonb_exists(data, 'count')
          ${circleClause}
      `);

      const b = await tx.notification.updateMany({
        where: {
          userId,
          readAt: null,
          dismissedAt: null,
          ...(circleId ? { circleId } : {}),
        },
        data: { readAt: new Date() },
      });

      return [a, b.count] as const;
    });

    this.invalidateUnreadCount(userId);
    return { updated: withCount + withoutCount };
  }

  /**
   * Dismiss every LIVE notification, optionally scoped to one circle.
   * Dismiss implies read, so `read_at` is backfilled where it was null.
   */
  async dismissAll(userId: string, circleId?: string): Promise<{ updated: number }> {
    const circleClause = circleId
      ? Prisma.sql`AND circle_id = ${circleId}::uuid`
      : Prisma.empty;

    // Raw SQL because `read_at = COALESCE(read_at, now())` is a column-
    // referencing expression, which Prisma's typed `updateMany` cannot express.
    // updated_at set explicitly — see markAllRead().
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE notifications
      SET dismissed_at = now(),
          read_at = COALESCE(read_at, now()),
          updated_at = now()
      WHERE user_id = ${userId}::uuid
        AND dismissed_at IS NULL
        ${circleClause}
    `);

    this.invalidateUnreadCount(userId);
    return { updated };
  }

  // ---------------------------------------------------------------------------
  // Producer API (#246 / #247) — best-effort, never throws
  // ---------------------------------------------------------------------------

  /**
   * Create an EVENT-type notification. One row per occurrence, no dedup.
   *
   * Best-effort: a failure logs a warning and resolves. Callers may `await`
   * this or fire it with `void` — either way it never rejects, so it can never
   * fail or block the action that produced it.
   */
  async emit(input: EmitNotificationInput): Promise<void> {
    try {
      // #251 gate — a suppressed type writes NO row (see the header).
      if (!(await this.preferences.isEnabled(input.userId, input.type))) return;

      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          circleId: input.circleId ?? null,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
          data: this.toJsonInput(input.data),
        },
      });
      this.invalidateUnreadCount(input.userId);
    } catch (err) {
      this.logger.warn(
        `emit(${input.type}) for user ${input.userId} failed: ${this.errorMessage(err)}`,
      );
    }
  }

  /**
   * Upsert a STATE-type notification: at most one LIVE row per
   * (userId, circleId, type), with `data`/`title`/`body`/`link`/`updatedAt`
   * refreshed in place.
   *
   * Not a Prisma `upsert`: that requires a unique constraint expressible in the
   * schema, and the guarantee here comes from a raw-SQL partial unique index
   * (LIVE rows only) which Prisma's DSL cannot represent. So: update-live-first,
   * create-if-none. A concurrent racer can slip between the two and trip the
   * partial unique index (P2002); that is caught and retried once as an update,
   * which is exactly what the loser of the race should have done.
   *
   * `readAt` is deliberately left ALONE. Whether a refreshed queue count should
   * re-mark the row unread is #246's decision, made against the countAtRead
   * snapshot this service writes on read — not something the write path guesses.
   */
  async upsertState(input: UpsertStateNotificationInput): Promise<void> {
    try {
      // #251 gate. A suppressed STATE type writes no row AND refreshes none:
      // the user's existing live rows of this type were dismissed when they
      // disabled it, and this reconcile must not resurrect them.
      if (!(await this.preferences.isEnabled(input.userId, input.type))) return;

      const payload = {
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        data: this.toJsonInput(input.data),
      };
      const liveKey = {
        userId: input.userId,
        circleId: input.circleId,
        type: input.type,
        dismissedAt: null,
      };

      const updated = await this.prisma.notification.updateMany({
        where: liveKey,
        data: payload,
      });

      if (updated.count === 0) {
        try {
          await this.prisma.notification.create({
            data: {
              userId: input.userId,
              circleId: input.circleId,
              type: input.type,
              ...payload,
            },
          });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            // Lost the race — a concurrent producer created the live row
            // between our updateMany and our create. Fold into it.
            await this.prisma.notification.updateMany({
              where: liveKey,
              data: payload,
            });
          } else {
            throw err;
          }
        }
      }

      this.invalidateUnreadCount(input.userId);
    } catch (err) {
      this.logger.warn(
        `upsertState(${input.type}) for user ${input.userId} circle ${input.circleId} failed: ` +
          this.errorMessage(err),
      );
    }
  }

  /**
   * Create-or-increment a COUNTED EVENT notification (#247).
   *
   * WHY AN ADVISORY LOCK. `upsertState()` can afford an optimistic
   * update-then-create-then-catch-P2002 because a DB partial unique index is
   * standing behind it. Event types have NO such index (by design — #244's
   * index predicate lists only the four `review_queue_*` values), so two
   * concurrent uploads to the same circle could both observe "no live row in
   * window" and both INSERT, producing exactly the duplicate rows this
   * primitive exists to prevent. `pg_advisory_xact_lock(hashtext(key))`
   * serializes the find-or-create per aggregation key for the life of the
   * transaction and is released on commit/rollback — no row needs to exist for
   * it to work, which is precisely the case a row lock cannot cover.
   *
   * A hash collision between two different keys costs a little needless
   * serialization and nothing else; the lock is only ever held for the three
   * tiny statements below.
   *
   * The read-then-write is deliberate rather than one clever UPDATE: the title
   * is a function of the RESULTING count (with caller-side pluralization and a
   * circle/uploader name), which would otherwise have to be assembled in SQL.
   * Under the lock, read-then-write is exactly as safe.
   *
   * `updated_at = now()` is set EXPLICITLY in the raw UPDATE — raw SQL bypasses
   * Prisma-side `@updatedAt`, the rolling window compares against `updated_at`,
   * and #248's retention purge keys off it.
   *
   * Best-effort like emit()/upsertState(): a failure logs and resolves.
   */
  async upsertCountedEvent(input: UpsertCountedEventInput): Promise<void> {
    const increment = input.increment ?? 1;
    const circleId = input.circleId ?? null;
    const matchData = input.matchData ?? null;

    try {
      // #251 gate — checked BEFORE the transaction opens, so a suppressed type
      // never takes the advisory lock it would otherwise contend for.
      if (!(await this.preferences.isEnabled(input.userId, input.type))) return;

      await this.prisma.$transaction(async (tx) => {
        // Aggregation key — must contain everything the lookup predicate below
        // filters on, so two different keys can never share a lock by accident
        // (only by hash collision, which is harmless).
        const lockKey = [
          input.userId,
          String(input.type),
          circleId ?? '-',
          matchData ? JSON.stringify(matchData) : '-',
        ].join('|');
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`,
        );

        const matchClause = matchData
          ? Prisma.sql`AND data @> ${JSON.stringify(matchData)}::jsonb`
          : Prisma.empty;

        // Rolling window, when requested. `updated_at` (not `created_at`) is the
        // right anchor: a row that is still being incremented is still current,
        // so a steady import keeps ONE row alive rather than starting a new one
        // every 15 minutes.
        const windowClause =
          input.windowMs != null && input.windowMs > 0
            ? Prisma.sql`AND updated_at > now() - make_interval(secs => ${
                input.windowMs / 1000
              }::double precision)`
            : Prisma.empty;

        const rows = await tx.$queryRaw<Array<{ id: string; count: number }>>(Prisma.sql`
          SELECT
            id,
            CASE
              WHEN data->>'count' ~ '^[0-9]+$' THEN (data->>'count')::int
              ELSE 0
            END AS count
          FROM notifications
          WHERE user_id = ${input.userId}::uuid
            AND type::text = ${String(input.type)}
            -- IS NOT DISTINCT FROM, not plain equality: enrichment_failed rows
            -- are global (circle_id IS NULL), and NULL = NULL is NULL, not true.
            AND circle_id IS NOT DISTINCT FROM ${circleId}::uuid
            AND dismissed_at IS NULL
            ${matchClause}
            ${windowClause}
          ORDER BY updated_at DESC
          LIMIT 1
        `);

        const existing = rows[0];
        const count = (existing?.count ?? 0) + increment;
        const payload = { ...(input.data ?? {}), count };
        const title = input.buildTitle(count);

        if (existing) {
          const reunread = input.reunreadOnIncrement
            ? Prisma.sql`, read_at = NULL`
            : Prisma.empty;

          await tx.$executeRaw(Prisma.sql`
            UPDATE notifications
            SET title = ${title},
                body = ${input.body ?? null},
                link = ${input.link ?? null},
                data = ${JSON.stringify(payload)}::jsonb,
                updated_at = now()
                ${reunread}
            WHERE id = ${existing.id}::uuid
          `);
        } else {
          await tx.notification.create({
            data: {
              userId: input.userId,
              circleId,
              type: input.type,
              title,
              body: input.body ?? null,
              link: input.link ?? null,
              data: payload as Prisma.InputJsonValue,
            },
          });
        }
      });

      this.invalidateUnreadCount(input.userId);
    } catch (err) {
      this.logger.warn(
        `upsertCountedEvent(${input.type}) for user ${input.userId} failed: ` +
          this.errorMessage(err),
      );
    }
  }

  /**
   * Resolve (dismiss) specific LIVE rows by id — the producer-side counterpart
   * to upsertState(), used by the #246 review-queue reconcile when a queue has
   * drained to zero and its row should stop nagging.
   *
   * Takes `{ id, userId }` pairs rather than a filter because the reconcile has
   * already read exactly the rows it means to resolve (it needs them for its
   * re-unread decision anyway), so a second, wider predicate would only add a
   * way for the two to disagree. `userId` is carried purely to invalidate that
   * user's badge cache.
   *
   * Raw SQL for the same reason dismiss()/dismissAll() use it: `read_at =
   * COALESCE(read_at, now())` is a column-referencing expression Prisma's typed
   * `updateMany` cannot express. `updated_at` is set explicitly — raw SQL
   * bypasses Prisma-side `@updatedAt`, and #248's retention purge keys off it.
   *
   * Best-effort like emit()/upsertState(): a failure logs and returns 0.
   */
  async resolveStatesByIds(
    rows: ReadonlyArray<{ id: string; userId: string }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;

    try {
      const resolved = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE notifications
        SET dismissed_at = now(),
            read_at = COALESCE(read_at, now()),
            updated_at = now()
        WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])
          AND dismissed_at IS NULL
      `);

      for (const row of rows) this.invalidateUnreadCount(row.userId);
      return resolved;
    } catch (err) {
      this.logger.warn(`resolveStatesByIds failed: ${this.errorMessage(err)}`);
      return 0;
    }
  }

  /**
   * Resolve (dismiss) every LIVE row of the given types, across all users and
   * circles. Used by the #246 reconcile for a review queue whose feature flag
   * has been turned OFF: the queue can no longer be produced, so leaving a live
   * row pointing at a now-hidden surface would nag forever with no way for the
   * reconcile to ever drain it.
   *
   * Per-user badge caches are NOT invalidated here — the affected user set is
   * unbounded and unknown, and the cache TTL is 2 s, so it self-heals within
   * one poll.
   */
  async resolveStatesByType(types: readonly NotificationType[]): Promise<number> {
    if (types.length === 0) return 0;

    try {
      return await this.prisma.$executeRaw(Prisma.sql`
        UPDATE notifications
        SET dismissed_at = now(),
            read_at = COALESCE(read_at, now()),
            updated_at = now()
        WHERE type::text = ANY(${types.map((t) => String(t))}::text[])
          AND dismissed_at IS NULL
      `);
    } catch (err) {
      this.logger.warn(`resolveStatesByType failed: ${this.errorMessage(err)}`);
      return 0;
    }
  }

  /**
   * Re-mark specific rows unread by clearing `read_at`.
   *
   * The ONLY caller is the #246 reconcile, and the ONLY case it applies is a
   * queue that has grown past what the user last saw (`data.count` >
   * `data.countAtRead`). The growth test itself lives in the reconcile, not
   * here — this method just performs the write, exactly as upsertState()
   * deliberately leaves `read_at` alone rather than guessing.
   *
   * `dismissed_at IS NULL` is re-asserted so a row dismissed between the
   * reconcile's read and this write is never resurrected into the badge count.
   */
  async markStatesUnreadByIds(
    rows: ReadonlyArray<{ id: string; userId: string }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;

    try {
      const updated = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE notifications
        SET read_at = NULL,
            updated_at = now()
        WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])
          AND dismissed_at IS NULL
          AND read_at IS NOT NULL
      `);

      for (const row of rows) this.invalidateUnreadCount(row.userId);
      return updated;
    } catch (err) {
      this.logger.warn(`markStatesUnreadByIds failed: ${this.errorMessage(err)}`);
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Preference-driven writes (#251)
  // ---------------------------------------------------------------------------

  /**
   * Dismiss every LIVE row of the given types for ONE user — the write half of
   * "turning a type off".
   *
   * DECIDED BEHAVIOR: disabling a type does not merely stop new rows, it clears
   * the ones already on screen. The user's intent when they flip a toggle off
   * is "stop showing me this", not "stop showing me this except for the eleven
   * already there". Without it a disabled STATE type would be especially bad:
   * #246's reconcile is now gated too, so it would never drain those rows to
   * zero and they would nag forever.
   *
   * Runs INSIDE the caller's transaction (`tx`), so the dismissals and the
   * settings write commit or roll back together — a settings save that fails
   * after dismissing would otherwise leave the user with the rows gone and the
   * type still on. Unlike the rest of the producer API this is NOT best-effort:
   * it throws, because the caller's transaction is exactly what should be
   * rolled back if it fails.
   *
   * Raw SQL for the same reason as dismiss()/dismissAll(): `read_at =
   * COALESCE(read_at, now())` is a column-referencing expression Prisma's typed
   * `updateMany` cannot express. `updated_at` is set explicitly — raw SQL
   * bypasses Prisma-side `@updatedAt`, and #248's retention purge keys off it.
   *
   * The caller is responsible for invalidatePreferences() after commit; it is
   * deliberately not done here, since the cache must not be cleared on the
   * strength of a transaction that may still roll back.
   */
  async dismissTypesForUser(
    userId: string,
    types: readonly NotificationType[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    if (types.length === 0) return 0;

    return tx.$executeRaw(Prisma.sql`
      UPDATE notifications
      SET dismissed_at = now(),
          read_at = COALESCE(read_at, now()),
          updated_at = now()
      WHERE user_id = ${userId}::uuid
        AND dismissed_at IS NULL
        AND type::text = ANY(${types.map((t) => String(t))}::text[])
    `);
  }

  /**
   * Drop a user's cached preferences so a toggle takes effect on the very next
   * notification instead of up to one TTL later. Called by UserSettingsService
   * AFTER its transaction commits.
   */
  invalidatePreferences(userId: string): void {
    this.preferences.invalidate(userId);
    // Their badge count changes the moment rows are dismissed on disable.
    this.invalidateUnreadCount(userId);
  }

  /**
   * Batched preference warm-up for a known set of recipients — one query
   * instead of one per user. Used by #246's reconcile, which holds a circle's
   * whole eligible membership before fanning upsertState() across it.
   */
  async primePreferences(userIds: readonly string[]): Promise<void> {
    await this.preferences.prime(userIds);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Translate the `status` query param into a Prisma where fragment.
   *
   * Dismissed rows are excluded from unread/read/all and returned ONLY by
   * `dismissed` — see NotificationListQueryDto.
   */
  private buildStatusWhere(
    status: NotificationStatusFilter,
  ): Prisma.NotificationWhereInput {
    switch (status) {
      case 'unread':
        return { dismissedAt: null, readAt: null };
      case 'read':
        return { dismissedAt: null, readAt: { not: null } };
      case 'dismissed':
        return { dismissedAt: { not: null } };
      case 'all':
      default:
        return { dismissedAt: null };
    }
  }

  private toDto(row: Notification): NotificationItemDto {
    return {
      id: row.id,
      circleId: row.circleId,
      type: row.type,
      title: row.title,
      body: row.body,
      link: row.link,
      data: row.data ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Normalize an optional JSON payload for a Prisma write. `undefined`/`null`
   * both mean "no payload", written as SQL NULL (Prisma.JsonNull) rather than
   * a JSON `null` literal, so `jsonb_exists(data, 'count')` is cleanly false.
   */
  private toJsonInput(
    value: Prisma.InputJsonValue | null | undefined,
  ): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
    return value === null || value === undefined ? Prisma.JsonNull : value;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Drop a user's cached badge count so it cannot lag behind their own action. */
  private invalidateUnreadCount(userId: string): void {
    this.unreadCountCache.delete(userId);
  }

  /**
   * Keep the per-user cache bounded: sweep expired entries once the map grows
   * past the soft cap, and clear it outright if it is still over afterwards.
   */
  private pruneUnreadCountCache(now: number): void {
    if (this.unreadCountCache.size < UNREAD_COUNT_CACHE_MAX_ENTRIES) return;

    for (const [key, entry] of this.unreadCountCache) {
      if (now - entry.cachedAt >= UNREAD_COUNT_CACHE_TTL_MS) {
        this.unreadCountCache.delete(key);
      }
    }

    if (this.unreadCountCache.size >= UNREAD_COUNT_CACHE_MAX_ENTRIES) {
      this.unreadCountCache.clear();
    }
  }
}

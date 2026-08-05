// =============================================================================
// Notifications Service (epic #240, issue #245)
// =============================================================================
//
// The SINGLE write path for the notifications table. Producers (#246 review
// queue watcher, #247 event producers) call emit()/upsertState() here rather
// than touching Prisma directly, so the state-vs-event dedup semantics live in
// exactly one place and cannot drift between callers.
//
//   emit()        — EVENT types (upload_completed, enrichment_failed,
//                   workflow_run_completed, share_expiring): one row per
//                   occurrence, appended freely, never deduplicated.
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
// =============================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Notification, NotificationType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationItemDto } from './dto/notification-response.dto';

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

  constructor(private readonly prisma: PrismaService) {}

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

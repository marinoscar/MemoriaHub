// =============================================================================
// Memories Notification Producer (epic #300, issue #311)
// =============================================================================
//
// Produces `memories_ready` rows after a `memory_generation` run has CREATED at
// least one memory for a circle. A refresh-only run produces nothing: nothing
// new arrived, and a notification that resurfaces the same six cards every day
// is the fastest way to get the bell muted.
//
// VOLUME GUARD — a counted EVENT with a 24-HOUR ROLLING WINDOW.
//   Memories arrive in BATCHES: one generation pass routinely creates six or
//   more (a year of On This Day anchors, several trips, a theme). `emit()`
//   would append one row per memory — precisely the fan-out the notification
//   design exists to prevent — and a member of three circles would find their
//   bell buried after a single backfill. `upsertCountedEvent()` instead folds
//   every creation in the window into ONE row whose `data.count` grows, so the
//   user sees "6 new memories in Familia" and, if the admin runs a backfill an
//   hour later, "31 new memories in Familia" — still one row.
//
//   It is deliberately NOT `upsertState()`. A state row would need the raw-SQL
//   partial unique index `notifications_review_queue_live_uniq_idx` widened
//   (its predicate lists only the four `review_queue_*` values), and the
//   semantics are wrong anyway: "N new memories arrived" is a count of things
//   that HAPPENED, not the current depth of a queue the user drains. There is
//   no number that falls back to zero when the user acts, which is the property
//   that makes a STATE row a STATE row.
//
//   The window is anchored on `updated_at` by the primitive, so a generation
//   run today extends today's row while a run next week correctly starts a new
//   one. The find-or-create is race-safe: two concurrent `memory_generation`
//   jobs for the same circle (possible across replicas) are serialized by
//   upsertCountedEvent()'s transaction-scoped advisory lock.
//
// AUDIENCE — every circle member, regardless of per-circle role.
//   Browsing memories needs no write access, so a `viewer` genuinely can act on
//   this. Same rationale as `upload_completed`, and deliberately unlike #246's
//   collaborator-only review-queue audience (resolving a review group DOES need
//   write access).
//
// FIRE-AND-FORGET — `recordGeneratedAsync()` returns void and never rejects.
// The caller is `MemoryGenerationHandler`, which must never fail a generation
// job because a notification write failed; every memory it created is already
// committed and visible in the app.
//
// MODULE PLACEMENT. This producer lives in `MemoriesModule`, which imports
// `NotificationsModule` — an edge pointing INTO notifications, exactly like
// `MediaModule` and `WorkflowsModule`. `NotificationsModule` still imports
// NOTHING, which is the load-bearing property that keeps the module graph
// acyclic (see its header and docs/specs/notifications.md).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MemoryType, NotificationType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';

/** Rolling aggregation window for `memories_ready`. See header. */
export const MEMORIES_READY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** In-app route the bell row opens. */
export const MEMORIES_READY_LINK = '/memories';

export interface RecordGeneratedInput {
  circleId: string;
  /** Memories CREATED by the run (refreshes are deliberately not counted). */
  createdCount: number;
  /**
   * Run start. Used to find the run's own newest memory for the row body.
   *
   * The producer resolves that title itself rather than taking it from the
   * caller: it already holds a PrismaService for the member list, whereas
   * MemoryGenerationHandler holds none — injecting one there for a single
   * string would be the only DB dependency in an otherwise pure orchestrator.
   */
  since: Date;
}

/** Outcome of one produce call — returned for tests and the handler's log. */
export interface RecordGeneratedResult {
  recipients: number;
  skipped: boolean;
}

@Injectable()
export class MemoriesNotificationService {
  private readonly logger = new Logger(MemoriesNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Fire-and-forget entry point for the generation handler. Swallows
   * everything — mirrors `UploadNotificationService.recordUploadAsync`.
   */
  recordGeneratedAsync(input: RecordGeneratedInput): void {
    void this.recordGenerated(input).catch((err) => {
      this.logger.warn(
        `memories_ready notification for circle ${input.circleId} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * One generation run → one increment of `createdCount` for every member.
   *
   * Recipients are processed sequentially, not with `Promise.all`: each is a
   * short transaction taking an advisory lock on its own aggregation key, and
   * fanning out in parallel would only add contention on the keys that must
   * serialize anyway. A circle has a handful of members, not thousands.
   */
  async recordGenerated(input: RecordGeneratedInput): Promise<RecordGeneratedResult> {
    if (input.createdCount <= 0) {
      return { recipients: 0, skipped: true };
    }

    const circle = await this.prisma.circle.findUnique({
      where: { id: input.circleId },
      select: {
        name: true,
        // Every member, every role — see the audience note in the header.
        members: { select: { userId: true } },
      },
    });
    // Circle deleted between the generation run and this call.
    if (!circle || circle.members.length === 0) {
      return { recipients: 0, skipped: true };
    }

    const topTitle = await this.resolveTopMemoryTitle(input.circleId, input.since);
    const memberIds = circle.members.map((m) => m.userId);

    // One batched preference read instead of one per member — the same
    // warm-up #246's reconcile does before fanning out across a membership.
    await this.notifications.primePreferences(memberIds);

    for (const userId of memberIds) {
      await this.notifications.upsertCountedEvent({
        userId,
        circleId: input.circleId,
        type: NotificationType.memories_ready,
        // Redundant with the primitive's own `circle_id` column predicate, and
        // kept anyway: it is the documented partition key for this type, and it
        // makes the row self-describing for any future consumer reading `data`.
        // Every matchData key must also appear in `data` below, or the row this
        // call creates would not be found by the next one.
        matchData: { circleId: input.circleId },
        data: { circleId: input.circleId },
        windowMs: MEMORIES_READY_WINDOW_MS,
        increment: input.createdCount,
        link: MEMORIES_READY_LINK,
        body: topTitle,
        buildTitle: (count) =>
          `${count} new ${count === 1 ? 'memory' : 'memories'} in ${circle.name}`,
        // Continued activity re-badges the bell: a counted row only ever grows
        // when something genuinely new happened, so the increment IS the
        // "new activity" signal (the event-type analog of #246's re-unread rule,
        // minus the countAtRead comparison a STATE row needs).
        reunreadOnIncrement: true,
      });
    }

    return { recipients: memberIds.length, skipped: false };
  }

  /**
   * Title shown as the row body: the run's most interesting new memory.
   *
   * `on_this_day` wins when present — it is the one type anchored to TODAY, so
   * it is the memory the user is most likely to want right now — otherwise the
   * newest. A failure here is not worth losing the notification over, so it
   * degrades to `null` (a row with no body) rather than throwing.
   */
  private async resolveTopMemoryTitle(
    circleId: string,
    since: Date,
  ): Promise<string | null> {
    try {
      const rows = await this.prisma.memory.findMany({
        where: {
          circleId,
          deletedAt: null,
          generatedAt: { gte: since },
        },
        select: { title: true, type: true },
        orderBy: { generatedAt: 'desc' },
        take: 25,
      });
      if (rows.length === 0) return null;

      const anchored = rows.find((r) => r.type === MemoryType.on_this_day);
      return (anchored ?? rows[0])!.title;
    } catch (err) {
      this.logger.warn(
        `Failed to resolve top memory title for circle ${circleId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }
}

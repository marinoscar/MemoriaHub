// =============================================================================
// MemoriaHubWebhooks: where MemoriaHub raises its webhook events (RETRO-H4, #603)
// =============================================================================
//
// The one service the app's write paths call to raise an event of
// `memoriahub-webhook-events.ts`. Every method is called AFTER the triggering
// write committed (outside any `$transaction`) and NEVER throws: a webhook is
// a side channel, and a failure in it must not fail an upload, a purge or a job.
//
//   * Media (`mediaCreated`, `mediaTrashed`, `mediaDeleted`) is synchronous and
//     does no I/O: the entries go into a `WebhookBatcher` (100 ids or 60 s per
//     batch, per event and circle, and per uploader for the user event). A
//     closed batch becomes ONE `webhooks.fanout` job (`enqueueFanout`, a single
//     bounded insert), so the fan-out itself runs in the queue.
//   * Memories and workflow runs are raised from job handlers, after their
//     terminal write: they re-read the committed rows and call
//     `WebhooksService.emit` directly (inside the job, no detached work).
//
// SKIP WHEN NOBODY LISTENS. Before enqueuing or emitting, the service checks
// (cached 30 s) whether any enabled endpoint subscribes to the key, so a
// deployment without webhooks pays one cached read per batch and no job rows.
// The check reads `webhook_endpoints` through the bypass client (reason
// `webhooks`, the slice's own), because system-scope rows have no organization.
// The bypass client is `PrismaSystemService` (RETRO-D1), named by that reason.
// =============================================================================

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  WEBHOOKS_SYSTEM_ACCESS_REASON,
  WebhooksService,
  isSubscribed,
} from '@marinoscar/platform-api/webhooks';
import { WorkflowRunStatus, WorkflowTrigger, type MediaType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { MAX_IDS_PER_EVENT, MEMORIAHUB_WEBHOOK_EVENTS } from './memoriahub-webhook-events';
import { WebhookBatcher, type WebhookBatch } from './webhook-batcher';

/** How long a media batch stays open after its first entry. */
export const MEDIA_WEBHOOK_WINDOW_MS = 60_000;
/** How long the "does any endpoint subscribe" answer is reused. */
export const SUBSCRIPTION_CACHE_MS = 30_000;

/** A media item as `media.item.created` reports it. */
export interface CreatedMediaItem {
  readonly id: string;
  readonly circleId: string;
  readonly type: MediaType | 'photo' | 'video';
  readonly capturedAt: Date | null;
  readonly addedById: string | null;
}

type MediaEntry =
  | { kind: 'created'; item: CreatedMediaItem }
  | { kind: 'id'; id: string };

const TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set([
  WorkflowRunStatus.completed,
  WorkflowRunStatus.completed_with_errors,
  WorkflowRunStatus.failed,
]);

const SEPARATOR = '|';

@Injectable()
export class MemoriaHubWebhooks implements OnApplicationShutdown {
  private readonly logger = new Logger(MemoriaHubWebhooks.name);
  private readonly batcher: WebhookBatcher<MediaEntry>;
  private subscriptions: { at: number; patterns: Promise<string[][]> } | null = null;

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
    private readonly system: PrismaSystemService,
  ) {
    this.batcher = new WebhookBatcher<MediaEntry>({
      maxItems: MAX_IDS_PER_EVENT,
      windowMs: MEDIA_WEBHOOK_WINDOW_MS,
      flush: (batch) => this.flushMedia(batch),
    });
  }

  // ---------------------------------------------------------------------------
  // Media (batched, no I/O in the caller)
  // ---------------------------------------------------------------------------

  /** A media item was registered (the non-deduplicated path of `createMedia`). */
  mediaCreated(item: CreatedMediaItem): void {
    this.safely('mediaCreated', () => {
      this.batcher.add(bucket(MEMORIAHUB_WEBHOOK_EVENTS.itemCreated, item.circleId), [{ kind: 'created', item }]);
      if (item.addedById) {
        this.batcher.add(bucket(MEMORIAHUB_WEBHOOK_EVENTS.uploadCompleted, item.circleId, item.addedById), [
          { kind: 'id', id: item.id },
        ]);
      }
    });
  }

  /** Items of one circle moved to Trash. */
  mediaTrashed(circleId: string, mediaItemIds: readonly string[]): void {
    this.safely('mediaTrashed', () => {
      if (mediaItemIds.length === 0) return;
      this.batcher.add(
        bucket(MEMORIAHUB_WEBHOOK_EVENTS.itemTrashed, circleId),
        mediaItemIds.map((id) => ({ kind: 'id' as const, id })),
      );
    });
  }

  /** Items were permanently deleted; rows from several circles are grouped here. */
  mediaDeleted(rows: readonly { id: string; circleId: string }[]): void {
    this.safely('mediaDeleted', () => {
      for (const row of rows) {
        this.batcher.add(bucket(MEMORIAHUB_WEBHOOK_EVENTS.itemDeleted, row.circleId), [{ kind: 'id', id: row.id }]);
      }
    });
  }

  /** Closes the open media batches (shutdown, tests). */
  async flushPending(): Promise<void> {
    await this.batcher.drain();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flushPending();
  }

  // ---------------------------------------------------------------------------
  // Memories and workflow runs (from job handlers, after their terminal write)
  // ---------------------------------------------------------------------------

  /** A generation pass in `circleId` that started at `since` created memories. */
  async memoriesCreated(circleId: string, since: Date): Promise<void> {
    await this.guard('memoriesCreated', async () => {
      const key = MEMORIAHUB_WEBHOOK_EVENTS.memoryCreated;
      if (!(await this.anySubscriber(key))) return;
      const rows = await this.prisma.memory.findMany({
        where: { circleId, deletedAt: null, generatedAt: { gte: since } },
        select: { id: true, type: true },
        orderBy: [{ generatedAt: 'asc' }, { id: 'asc' }],
        take: MAX_IDS_PER_EVENT * 10,
      });
      for (const chunk of chunks(rows, MAX_IDS_PER_EVENT)) {
        await this.webhooks.emit(
          key,
          {
            circleId,
            count: chunk.length,
            memoryIds: chunk.map((row) => row.id),
            types: [...new Set(chunk.map((row) => String(row.type)))],
          },
          { orgId: null },
        );
      }
    });
  }

  /** A workflow run reached a terminal status (re-read; a run that is not terminal raises nothing). */
  async workflowRunFinished(runId: string): Promise<void> {
    await this.guard('workflowRunFinished', async () => {
      const key = MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted;
      if (!(await this.anySubscriber(key))) return;
      const run = await this.loadRun(runId);
      if (!run || !TERMINAL.has(run.status)) return;
      const recipient = recipientOf(run);
      if (!recipient) return;
      await this.webhooks.emitForUser(recipient, key, {
        runId: run.id,
        workflowId: run.workflowId,
        circleId: run.circleId,
        status: run.status,
        trigger: run.triggerType,
        succeededCount: run.succeededCount,
        failedCount: run.failedCount,
      });
    });
  }

  /** A workflow run moved to `awaiting_approval`. */
  async workflowRunAwaitingApproval(runId: string): Promise<void> {
    await this.guard('workflowRunAwaitingApproval', async () => {
      const key = MEMORIAHUB_WEBHOOK_EVENTS.workflowRunAwaitingApproval;
      if (!(await this.anySubscriber(key))) return;
      const run = await this.loadRun(runId);
      if (!run || run.status !== WorkflowRunStatus.awaiting_approval) return;
      const recipient = recipientOf(run);
      if (!recipient) return;
      await this.webhooks.emitForUser(recipient, key, {
        runId: run.id,
        workflowId: run.workflowId,
        circleId: run.circleId,
        matchedCount: run.matchedCount,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async flushMedia(batch: WebhookBatch<MediaEntry>): Promise<void> {
    await this.guard('flushMedia', async () => {
      const [eventKey, circleId, userId] = batch.key.split(SEPARATOR);
      if (!(await this.anySubscriber(eventKey))) return;
      let data: unknown;
      if (eventKey === MEMORIAHUB_WEBHOOK_EVENTS.itemCreated) {
        const items = batch.items.flatMap((entry) => (entry.kind === 'created' ? [entry.item] : []));
        data = {
          circleId,
          count: items.length,
          items: items.map((item) => ({
            mediaItemId: item.id,
            mediaType: item.type,
            capturedAt: item.capturedAt ? item.capturedAt.toISOString() : null,
            addedById: item.addedById,
          })),
        };
      } else {
        const ids = batch.items.flatMap((entry) => (entry.kind === 'id' ? [entry.id] : []));
        data =
          eventKey === MEMORIAHUB_WEBHOOK_EVENTS.uploadCompleted
            ? { circleId, count: ids.length, mediaItemIds: ids, windowStart: batch.windowStart.toISOString() }
            : { circleId, count: ids.length, mediaItemIds: ids };
      }
      await this.webhooks.enqueueFanout(eventKey, data, {
        orgId: null,
        ...(userId ? { userId } : {}),
        occurredAt: batch.windowStart,
      });
    });
  }

  /** Whether any enabled endpoint (any scope) subscribes to `eventKey`. Cached (one read in flight at a time); fails open. */
  async anySubscriber(eventKey: string): Promise<boolean> {
    try {
      const now = Date.now();
      if (!this.subscriptions || now - this.subscriptions.at > SUBSCRIPTION_CACHE_MS) {
        const patterns = this.system
          .asSystem(WEBHOOKS_SYSTEM_ACCESS_REASON)
          .webhookEndpoint
          .findMany({ where: { enabled: true }, select: { eventKeys: true } })
          .then((rows) => rows.map((row) => row.eventKeys));
        this.subscriptions = { at: now, patterns };
        // A failed read is not cached: the next call retries.
        patterns.catch(() => {
          if (this.subscriptions?.patterns === patterns) this.subscriptions = null;
        });
      }
      return (await this.subscriptions.patterns).some((patterns) => isSubscribed(patterns, eventKey));
    } catch (error) {
      this.logger.debug(`Webhook subscription lookup failed; emitting anyway: ${message(error)}`);
      return true;
    }
  }

  private loadRun(runId: string) {
    return this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        workflowId: true,
        circleId: true,
        status: true,
        triggerType: true,
        startedById: true,
        matchedCount: true,
        succeededCount: true,
        failedCount: true,
        workflow: { select: { createdById: true } },
      },
    });
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn(`Webhook ${what} failed: ${message(error)}`);
    }
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Webhook ${what} failed: ${message(error)}`);
    }
  }
}

function bucket(eventKey: string, circleId: string, userId?: string): string {
  return [eventKey, circleId, userId ?? ''].join(SEPARATOR);
}

/** Same resolution as `WorkflowRunNotificationService`: the starter, or the creator for a scheduled run. */
function recipientOf(run: {
  triggerType: WorkflowTrigger;
  startedById: string | null;
  workflow: { createdById: string | null };
}): string | null {
  return run.triggerType === WorkflowTrigger.scheduled
    ? (run.workflow.createdById ?? run.startedById)
    : (run.startedById ?? run.workflow.createdById);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

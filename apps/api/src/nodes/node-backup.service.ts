// =============================================================================
// NodeBackupService (issue #312, epic #308 — Local Media Backup via Worker Nodes)
// =============================================================================
//
// Control plane for the node backup data feed: per-node config (schedule /
// scope / checkpoint), run lifecycle (start → change-feed pages → acks →
// finish) with a single-active-run rule and staleness release, the presigned
// change feed itself, the reconcile manifest, and the dimensions catalog.
//
// Layering: this service owns HTTP-facing orchestration + state transitions;
// all feed/sidecar/lag QUERIES delegate to NodeBackupQueryService (#310).
// Ownership (404 unknown node / 403 foreign node) funnels through
// NodesService.assertOwnership, exactly like every other /api/nodes/* route.
//
// Serialization rule: every BigInt (bytesAcked, bytesDownloaded, pending
// bytes, object sizes) leaves this service as a STRING — never let a raw
// BigInt escape to JSON (see CLAUDE.md gotchas).
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NodeBackupConfig,
  NodeBackupRun,
  NodeBackupRunKind,
  NodeBackupRunStatus,
  Prisma,
  WorkerNode,
} from '@prisma/client';
import { isSupportedTimeZone } from '../common/time/zone.util';
import { PrismaService } from '../prisma/prisma.service';
import { NodesService } from './nodes.service';
import {
  BackupFeedCursor,
  NodeBackupQueryService,
} from './node-backup-query.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { isValidCron, nextCronDate } from '../workflows/util/cron.util';
import {
  BackupRunStats,
  BackupAckDto,
  BackupChangesQueryDto,
  BackupManifestQueryDto,
  FinishBackupRunDto,
  StartBackupRunDto,
  UpdateBackupConfigDto,
} from './dto/node-backup.dto';

const DEFAULT_RUN_STALE_MINUTES = 15;
const DEFAULT_MAX_PAGE_SIZE = 200;
const DEFAULT_FEED_SAFETY_HORIZON_SECONDS = 5;
const DEFAULT_CHANGES_LIMIT = 100;
const MANIFEST_MAX_LIMIT = 1000;

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

/**
 * Valid IANA timezone names — including 'UTC', which several runtimes
 * canonicalize out of Intl.supportedValuesOf('timeZone'). This local helper's
 * lazily-built Set moved to common/time/zone.util.ts (issue #444) when
 * per-user time zones needed the same predicate; the alias keeps this file's
 * call site unchanged.
 */
const isSupportedTimezone = isSupportedTimeZone;

@Injectable()
export class NodeBackupService {
  private readonly logger = new Logger(NodeBackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodesService: NodesService,
    private readonly queryService: NodeBackupQueryService,
    private readonly objectsService: ObjectsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Settings helpers
  // ---------------------------------------------------------------------------

  private async getBackupSettings(): Promise<{
    maxPageSize: number;
    feedSafetyHorizonSeconds: number;
    runStaleMinutes: number;
  }> {
    const settings = await this.systemSettings.getSettings();
    return {
      maxPageSize: settings.backup?.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
      feedSafetyHorizonSeconds:
        settings.backup?.feedSafetyHorizonSeconds ??
        DEFAULT_FEED_SAFETY_HORIZON_SECONDS,
      runStaleMinutes:
        settings.backup?.runStaleMinutes ?? DEFAULT_RUN_STALE_MINUTES,
    };
  }

  private staleCutoff(runStaleMinutes: number): Date {
    return new Date(Date.now() - runStaleMinutes * 60_000);
  }

  // ---------------------------------------------------------------------------
  // Active-run helpers
  // ---------------------------------------------------------------------------

  /**
   * True when `run` counts as ACTIVE: still `running` with an ack (or page
   * fetch — both refresh lastAckAt) inside the runStaleMinutes window.
   */
  private isRunFresh(run: NodeBackupRun, cutoff: Date): boolean {
    return (
      run.status === NodeBackupRunStatus.running &&
      run.lastAckAt !== null &&
      run.lastAckAt >= cutoff
    );
  }

  /** The node's currently-active run id, or null. */
  private async findActiveRunId(
    nodeId: string,
    runStaleMinutes: number,
  ): Promise<string | null> {
    const run = await this.prisma.nodeBackupRun.findFirst({
      where: {
        nodeId,
        status: NodeBackupRunStatus.running,
        lastAckAt: { gte: this.staleCutoff(runStaleMinutes) },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    return run?.id ?? null;
  }

  /**
   * Load `runId` and assert it is THE active running run for `nodeId` (409
   * otherwise — wrong node, not running, or stale). When `refreshAck` is set,
   * the run's `lastAckAt` is bumped to now: a page fetch counts as liveness.
   */
  private async requireActiveRun(
    nodeId: string,
    runId: string,
    runStaleMinutes: number,
    opts: { refreshAck: boolean },
  ): Promise<NodeBackupRun> {
    const run = await this.prisma.nodeBackupRun.findUnique({
      where: { id: runId },
    });
    if (
      !run ||
      run.nodeId !== nodeId ||
      !this.isRunFresh(run, this.staleCutoff(runStaleMinutes))
    ) {
      throw new ConflictException(
        'runId is not the active running backup run for this node',
      );
    }
    if (opts.refreshAck) {
      await this.prisma.nodeBackupRun.update({
        where: { id: run.id },
        data: { lastAckAt: new Date() },
      });
    }
    return run;
  }

  // ---------------------------------------------------------------------------
  // Config serialization
  // ---------------------------------------------------------------------------

  private async serializeConfig(node: WorkerNode, config: NodeBackupConfig) {
    const { runStaleMinutes } = await this.getBackupSettings();

    const scope = await this.queryService.resolveScope(
      node.createdById,
      config.circleIds,
    );
    const cursor: BackupFeedCursor | null =
      config.checkpointUpdatedAt && config.checkpointId
        ? { updatedAt: config.checkpointUpdatedAt, id: config.checkpointId }
        : null;
    const pending = await this.queryService.getPendingLag(scope, cursor);
    const activeRunId = await this.findActiveRunId(node.id, runStaleMinutes);

    return {
      nodeId: config.nodeId,
      enabled: config.enabled,
      scheduleCron: config.scheduleCron,
      timezone: config.timezone,
      nextRunAt: iso(config.nextRunAt),
      circleIds: config.circleIds,
      checkpoint: cursor
        ? { updatedAt: cursor.updatedAt.toISOString(), id: cursor.id }
        : null,
      // BigInt → STRING at the DTO boundary.
      itemsAcked: config.itemsAcked.toString(),
      bytesAcked: config.bytesAcked.toString(),
      lastRunAt: iso(config.lastRunAt),
      lastCompletedRunAt: iso(config.lastCompletedRunAt),
      lastReconcileAt: iso(config.lastReconcileAt),
      pending: { items: pending.items, bytes: pending.bytes.toString() },
      activeRunId,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /nodes/:id/backup/config
  // ---------------------------------------------------------------------------

  async getConfig(userId: string, nodeId: string) {
    const node = await this.nodesService.assertOwnership(userId, nodeId);
    const config = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
    });
    if (!config) {
      return { config: null };
    }
    return { config: await this.serializeConfig(node, config) };
  }

  // ---------------------------------------------------------------------------
  // PUT /nodes/:id/backup/config
  // ---------------------------------------------------------------------------

  async updateConfig(userId: string, nodeId: string, dto: UpdateBackupConfigDto) {
    const node = await this.nodesService.assertOwnership(userId, nodeId);

    if (typeof dto.scheduleCron === 'string' && !isValidCron(dto.scheduleCron)) {
      throw new BadRequestException(
        `Invalid cron expression "${dto.scheduleCron}" — expected the 5-field form ` +
          '"minute hour day-of-month month day-of-week"',
      );
    }
    if (typeof dto.timezone === 'string' && !isSupportedTimezone(dto.timezone)) {
      throw new BadRequestException(
        `Unknown timezone "${dto.timezone}" — expected an IANA timezone name ` +
          '(e.g. "America/Costa_Rica")',
      );
    }
    if (dto.circleIds !== undefined && dto.circleIds.length > 0) {
      // Every requested circle must be one the node OWNER belongs to.
      const memberships = await this.prisma.circleMember.findMany({
        where: { userId: node.createdById, circleId: { in: dto.circleIds } },
        select: { circleId: true },
      });
      const memberIds = new Set(memberships.map((m) => m.circleId));
      const invalid = dto.circleIds.filter((id) => !memberIds.has(id));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `circleIds contains circles the node owner is not a member of: ${invalid.join(', ')}`,
        );
      }
    }

    const existing = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
    });

    // Effective post-merge values ('key present' distinguishes null from absent).
    const scheduleCron =
      dto.scheduleCron !== undefined
        ? dto.scheduleCron
        : existing?.scheduleCron ?? null;
    const timezone =
      dto.timezone !== undefined ? dto.timezone : existing?.timezone ?? null;

    // Recompute nextRunAt whenever the schedule inputs changed (or the row is
    // being created); clearing the cron clears nextRunAt.
    let nextRunAt: Date | null;
    if (scheduleCron === null) {
      nextRunAt = null;
    } else if (
      dto.scheduleCron !== undefined ||
      dto.timezone !== undefined ||
      !existing
    ) {
      nextRunAt = nextCronDate(scheduleCron, new Date(), timezone ?? 'UTC');
    } else {
      nextRunAt = existing.nextRunAt;
    }

    const config = await this.prisma.nodeBackupConfig.upsert({
      where: { nodeId },
      create: {
        nodeId,
        enabled: dto.enabled ?? true,
        scheduleCron,
        timezone,
        nextRunAt,
        circleIds: dto.circleIds ?? [],
      },
      update: {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        scheduleCron,
        timezone,
        nextRunAt,
        ...(dto.circleIds !== undefined ? { circleIds: dto.circleIds } : {}),
      },
    });

    return { config: await this.serializeConfig(node, config) };
  }

  // ---------------------------------------------------------------------------
  // POST /nodes/:id/backup/runs
  // ---------------------------------------------------------------------------

  async startRun(userId: string, nodeId: string, dto: StartBackupRunDto) {
    await this.nodesService.assertOwnership(userId, nodeId);

    const config = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
    });
    if (!config) {
      throw new BadRequestException('backup is not configured for this node');
    }
    if (!config.enabled) {
      throw new BadRequestException('backup is disabled for this node');
    }

    const { runStaleMinutes } = await this.getBackupSettings();
    const now = new Date();
    const cutoff = this.staleCutoff(runStaleMinutes);

    // Single-active-run rule: a FRESH running run blocks (409); STALE running
    // runs are released (marked stale) and the new run proceeds.
    const runningRuns = await this.prisma.nodeBackupRun.findMany({
      where: { nodeId, status: NodeBackupRunStatus.running },
      orderBy: { startedAt: 'desc' },
    });
    const fresh = runningRuns.find((r) => this.isRunFresh(r, cutoff));
    if (fresh) {
      throw new ConflictException({
        message: 'a backup run is already active for this node',
        activeRunId: fresh.id,
      });
    }
    if (runningRuns.length > 0) {
      await this.prisma.nodeBackupRun.updateMany({
        where: { id: { in: runningRuns.map((r) => r.id) } },
        data: { status: NodeBackupRunStatus.stale, finishedAt: now },
      });
      this.logger.warn(
        `Released ${runningRuns.length} stale running backup run(s) for node ${nodeId}`,
      );
    }

    // Scheduled triggers roll nextRunAt forward AT START (same at-start
    // pattern as workflow-schedule.task.ts), so a crash mid-run cannot
    // re-fire the same slot forever.
    const nextRunAt =
      dto.trigger === 'scheduled' && config.scheduleCron
        ? nextCronDate(config.scheduleCron, now, config.timezone ?? 'UTC')
        : undefined;

    const run = await this.prisma.nodeBackupRun.create({
      data: {
        nodeId,
        kind: dto.kind as NodeBackupRunKind,
        status: NodeBackupRunStatus.running,
        trigger: dto.trigger,
        cliVersion: dto.cliVersion ?? null,
        startedAt: now,
        lastAckAt: now,
        cursorStartUpdatedAt: config.checkpointUpdatedAt,
        cursorStartId: config.checkpointId,
      },
    });

    await this.prisma.nodeBackupConfig.update({
      where: { nodeId },
      data: {
        lastRunAt: now,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      },
    });

    return {
      run: {
        id: run.id,
        kind: run.kind,
        startedAt: run.startedAt.toISOString(),
        cursorStart: {
          updatedAt: iso(run.cursorStartUpdatedAt),
          id: run.cursorStartId,
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // GET /nodes/:id/backup/changes
  // ---------------------------------------------------------------------------

  async getChanges(userId: string, nodeId: string, q: BackupChangesQueryDto) {
    const node = await this.nodesService.assertOwnership(userId, nodeId);

    const config = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
    });
    if (!config) {
      throw new BadRequestException('backup is not configured for this node');
    }

    const { runStaleMinutes, maxPageSize, feedSafetyHorizonSeconds } =
      await this.getBackupSettings();

    // The page fetch itself counts as run liveness.
    await this.requireActiveRun(nodeId, q.runId, runStaleMinutes, {
      refreshAck: true,
    });

    // Cursor params are both-or-neither.
    const hasUpdatedAfter = q.updatedAfter !== undefined;
    const hasAfterId = q.afterId !== undefined;
    if (hasUpdatedAfter !== hasAfterId) {
      throw new BadRequestException(
        'updatedAfter and afterId must be provided together (or neither)',
      );
    }
    const cursor: BackupFeedCursor | null = hasUpdatedAfter
      ? { updatedAt: new Date(q.updatedAfter as string), id: q.afterId as string }
      : null;

    const limit = Math.max(
      1,
      Math.min(q.limit ?? DEFAULT_CHANGES_LIMIT, maxPageSize),
    );
    const safetyHorizon = new Date(
      Date.now() - feedSafetyHorizonSeconds * 1000,
    );

    const scope = await this.queryService.resolveScope(
      node.createdById,
      config.circleIds,
    );
    const feedItems = await this.queryService.getChanges(scope, cursor, limit);

    const ttlSeconds = this.config.get<number>('storage.signedUrlExpiry', 3600);

    const items = await Promise.all(
      feedItems.map(async (item) => {
        const tombstone = item.deletedAt !== null;
        const storageObject = item.storageObject;

        let downloadUrl: string | null = null;
        let downloadUrlExpiresAt: string | null = null;
        if (!tombstone && storageObject && storageObject.status === 'ready') {
          try {
            downloadUrl = await this.objectsService.getInternalDownloadUrl(
              storageObject.id,
              ttlSeconds,
            );
            if (downloadUrl) {
              downloadUrlExpiresAt = new Date(
                Date.now() + ttlSeconds * 1000,
              ).toISOString();
            }
          } catch (err) {
            // Per-item best effort: the item is still returned, URL-less.
            this.logger.warn(
              `Failed to presign download URL for object ${storageObject.id} ` +
                `(media item ${item.id}): ${err instanceof Error ? err.message : String(err)}`,
            );
            downloadUrl = null;
          }
        }

        return {
          id: item.id,
          circleId: item.circleId,
          updatedAt: item.updatedAt.toISOString(),
          createdAt: item.createdAt.toISOString(),
          capturedAt: iso(item.capturedAt),
          capturedAtOffset: item.capturedAtOffset,
          type: item.type,
          deletedAt: iso(item.deletedAt),
          archivedAt: iso(item.archivedAt),
          contentHash: item.contentHash,
          originalFilename: item.originalFilename,
          storage: storageObject
            ? {
                objectId: storageObject.id,
                // BigInt → STRING at the DTO boundary.
                size: storageObject.size.toString(),
                mimeType: storageObject.mimeType,
                status: storageObject.status,
              }
            : null,
          downloadUrl,
          downloadUrlExpiresAt,
          sidecar: this.queryService.composeSidecar(item),
        };
      }),
    );

    const last = feedItems.length > 0 ? feedItems[feedItems.length - 1] : null;

    return {
      items,
      // Even a PARTIAL page advances the cursor (the safety horizon means a
      // short page is normal near "now"); null only on a zero-item page.
      nextCursor: last
        ? { updatedAt: last.updatedAt.toISOString(), id: last.id }
        : null,
      hasMore: feedItems.length === limit,
      safetyHorizon: safetyHorizon.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /nodes/:id/backup/ack
  // ---------------------------------------------------------------------------

  async ack(userId: string, nodeId: string, dto: BackupAckDto) {
    await this.nodesService.assertOwnership(userId, nodeId);

    const config = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
    });
    if (!config) {
      throw new BadRequestException('backup is not configured for this node');
    }

    const { runStaleMinutes } = await this.getBackupSettings();
    // No pre-refresh — the ack transaction below sets lastAckAt itself.
    const run = await this.requireActiveRun(nodeId, dto.runId, runStaleMinutes, {
      refreshAck: false,
    });

    const cursorUpdatedAt = new Date(dto.cursor.updatedAt);
    const cursorId = dto.cursor.id;

    // Monotonic checkpoint: a cursor STRICTLY behind the stored checkpoint is
    // rejected; an equal cursor is an allowed no-op advance.
    if (config.checkpointUpdatedAt && config.checkpointId) {
      const behind =
        cursorUpdatedAt.getTime() < config.checkpointUpdatedAt.getTime() ||
        (cursorUpdatedAt.getTime() === config.checkpointUpdatedAt.getTime() &&
          cursorId < config.checkpointId);
      if (behind) {
        throw new ConflictException(
          'ack cursor is behind the stored checkpoint — the checkpoint only moves forward',
        );
      }
    }

    const itemsProcessed = dto.stats.itemsDownloaded + dto.stats.itemsSkipped;
    const bytesDownloaded = BigInt(dto.stats.bytesDownloaded);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.nodeBackupConfig.update({
        where: { nodeId },
        data: {
          checkpointUpdatedAt: cursorUpdatedAt,
          checkpointId: cursorId,
          itemsAcked: { increment: itemsProcessed },
          bytesAcked: { increment: bytesDownloaded },
        },
      }),
      this.prisma.nodeBackupRun.update({
        where: { id: run.id },
        data: {
          itemsDownloaded: { increment: dto.stats.itemsDownloaded },
          itemsSkipped: { increment: dto.stats.itemsSkipped },
          sidecarsWritten: { increment: dto.stats.sidecarsWritten },
          bytesDownloaded: { increment: bytesDownloaded },
          errorCount: { increment: dto.stats.errors },
          lastAckAt: now,
          cursorEndUpdatedAt: cursorUpdatedAt,
          cursorEndId: cursorId,
        },
      }),
    ]);

    return {
      ok: true as const,
      checkpoint: { updatedAt: cursorUpdatedAt.toISOString(), id: cursorId },
    };
  }

  // ---------------------------------------------------------------------------
  // POST /nodes/:id/backup/runs/:runId/finish
  // ---------------------------------------------------------------------------

  async finishRun(
    userId: string,
    nodeId: string,
    runId: string,
    dto: FinishBackupRunDto,
  ) {
    await this.nodesService.assertOwnership(userId, nodeId);

    const run = await this.prisma.nodeBackupRun.findUnique({
      where: { id: runId },
    });
    // A run belonging to another node is a 404, not a 403 — same
    // enumeration-resistant policy as the notifications :id routes.
    if (!run || run.nodeId !== nodeId) {
      throw new NotFoundException(`NodeBackupRun ${runId} not found`);
    }
    if (run.status !== NodeBackupRunStatus.running) {
      throw new BadRequestException(
        `run is already terminal (status "${run.status}")`,
      );
    }

    const now = new Date();
    const finalStats = dto.finalStats;

    await this.prisma.nodeBackupRun.update({
      where: { id: run.id },
      data: {
        status: dto.status as NodeBackupRunStatus,
        finishedAt: now,
        ...(dto.error !== undefined ? { lastError: dto.error } : {}),
        ...(finalStats
          ? {
              itemsDownloaded: { increment: finalStats.itemsDownloaded },
              itemsSkipped: { increment: finalStats.itemsSkipped },
              sidecarsWritten: { increment: finalStats.sidecarsWritten },
              bytesDownloaded: { increment: BigInt(finalStats.bytesDownloaded) },
              errorCount: { increment: finalStats.errors },
            }
          : {}),
      },
    });

    if (dto.status === 'completed') {
      // updateMany, not update: a config deleted mid-run must not 500 here.
      await this.prisma.nodeBackupConfig.updateMany({
        where: { nodeId },
        data: {
          lastCompletedRunAt: now,
          ...(run.kind === NodeBackupRunKind.reconcile
            ? { lastReconcileAt: now }
            : {}),
        },
      });
    }

    return { ok: true as const };
  }

  // ---------------------------------------------------------------------------
  // GET /nodes/:id/backup/runs
  // ---------------------------------------------------------------------------

  async listRuns(userId: string, nodeId: string, limit?: number) {
    await this.nodesService.assertOwnership(userId, nodeId);

    const take = Math.max(1, Math.min(limit ?? 20, 100));
    const runs = await this.prisma.nodeBackupRun.findMany({
      where: { nodeId },
      orderBy: { startedAt: 'desc' },
      take,
    });

    return {
      runs: runs.map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        trigger: run.trigger,
        startedAt: run.startedAt.toISOString(),
        finishedAt: iso(run.finishedAt),
        lastAckAt: iso(run.lastAckAt),
        itemsDownloaded: run.itemsDownloaded,
        itemsSkipped: run.itemsSkipped,
        sidecarsWritten: run.sidecarsWritten,
        // BigInt → STRING at the DTO boundary.
        bytesDownloaded: run.bytesDownloaded.toString(),
        errorCount: run.errorCount,
        lastError: run.lastError,
        cliVersion: run.cliVersion,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /nodes/:id/backup/manifest
  // ---------------------------------------------------------------------------

  async getManifest(userId: string, nodeId: string, q: BackupManifestQueryDto) {
    const node = await this.nodesService.assertOwnership(userId, nodeId);

    const config = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
    });
    if (!config) {
      throw new BadRequestException('backup is not configured for this node');
    }

    const { runStaleMinutes } = await this.getBackupSettings();
    // A manifest page fetch also counts as run liveness.
    await this.requireActiveRun(nodeId, q.runId, runStaleMinutes, {
      refreshAck: true,
    });

    const limit = Math.max(1, Math.min(q.limit ?? MANIFEST_MAX_LIMIT, MANIFEST_MAX_LIMIT));
    const scope = await this.queryService.resolveScope(
      node.createdById,
      config.circleIds,
    );
    const rows = await this.queryService.getManifest(
      scope,
      q.afterId ?? null,
      limit,
    );

    const last = rows.length > 0 ? rows[rows.length - 1] : null;

    return {
      items: rows.map((row) => ({
        id: row.id,
        contentHash: row.contentHash,
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: iso(row.deletedAt),
        archivedAt: iso(row.archivedAt),
      })),
      nextAfterId: last?.id ?? null,
      hasMore: rows.length === limit,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /nodes/:id/backup/dimensions
  // ---------------------------------------------------------------------------

  async getDimensions(userId: string, nodeId: string) {
    const node = await this.nodesService.assertOwnership(userId, nodeId);

    // No run (and no config) required — an unconfigured node reads the
    // owner's full circle scope (empty circleIds = ALL owner circles).
    const config = await this.prisma.nodeBackupConfig.findUnique({
      where: { nodeId },
      select: { circleIds: true },
    });
    const scope = await this.queryService.resolveScope(
      node.createdById,
      config?.circleIds ?? [],
    );
    const dimensions = await this.queryService.getDimensions(scope);

    return { ...dimensions, generatedAt: new Date().toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Staleness sweep (called by NodeBackupStaleTask)
  // ---------------------------------------------------------------------------

  /**
   * Mark every `running` run whose lastAckAt has fallen outside the
   * runStaleMinutes window as `stale` (with finishedAt). Returns the number of
   * runs released.
   */
  async markStaleRuns(): Promise<number> {
    const { runStaleMinutes } = await this.getBackupSettings();
    const result: Prisma.BatchPayload =
      await this.prisma.nodeBackupRun.updateMany({
        where: {
          status: NodeBackupRunStatus.running,
          lastAckAt: { lt: this.staleCutoff(runStaleMinutes) },
        },
        data: { status: NodeBackupRunStatus.stale, finishedAt: new Date() },
      });
    return result.count;
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleRole,
  OneDriveImportItemStatus,
  OneDriveImportRunStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MicrosoftGraphClient, OneDriveDriveItem } from './microsoft-graph.client';
import { OneDriveConnectionService } from './onedrive-connection.service';
import {
  OneDriveConnectionExpiredError,
  OneDriveNotConnectedError,
} from './onedrive.errors';

const ONEDRIVE_FEATURE = 'oneDriveImport';
export const ONEDRIVE_IMPORT_JOB_TYPE = 'onedrive_import';

/** Safety ceiling on a single enumeration to keep memory bounded. */
const MAX_ENUMERATED_ITEMS = 50_000;

export interface StartImportInput {
  circleId: string;
  remoteFolderPath?: string;
  recursive?: boolean;
}

/**
 * Server-side OneDrive import orchestration. Phase 1 (enumeration + fan-out)
 * happens synchronously here; phase 2 (per-item download → upload → createMedia)
 * runs in {@link OneDriveImportHandler} via the enrichment queue. Modeled on the
 * storage-migration run/item pattern. See docs/specs/onedrive-import.md §4, §5.
 */
@Injectable()
export class OneDriveImportService {
  private readonly logger = new Logger(OneDriveImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly connectionService: OneDriveConnectionService,
    private readonly graphClient: MicrosoftGraphClient,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  // ---------------------------------------------------------------------------
  // startImport
  // ---------------------------------------------------------------------------

  async startImport(
    userId: string,
    userPermissions: string[],
    input: StartImportInput,
  ): Promise<{ runId: string; totalCount: number }> {
    // 1. Feature gate.
    if (!(await this.systemSettings.isFeatureEnabled(ONEDRIVE_FEATURE))) {
      throw new BadRequestException('OneDrive Data Import is disabled');
    }

    // 2. Per-circle collaborator access — identical mechanism to createMedia.
    await this.circleMembershipService.assertCircleAccess(
      userId,
      input.circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // 3. One active run per user.
    const activeRun = await this.prisma.oneDriveImportRun.findFirst({
      where: {
        userId,
        status: {
          in: [OneDriveImportRunStatus.pending, OneDriveImportRunStatus.running],
        },
      },
    });
    if (activeRun) {
      throw new ConflictException(
        'You already have an active OneDrive import run; wait for it to finish or cancel it first',
      );
    }

    // 4. Fresh access token (also surfaces "not connected" / "reconnect").
    let accessToken: string;
    try {
      accessToken = await this.connectionService.getFreshAccessToken(userId);
    } catch (err) {
      if (err instanceof OneDriveNotConnectedError) {
        throw new BadRequestException(
          'No OneDrive connection — connect a Microsoft account first',
        );
      }
      if (err instanceof OneDriveConnectionExpiredError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // 5. Synchronous enumeration of eligible image/video items.
    const basePath = input.remoteFolderPath?.trim() || null;
    const recursive = input.recursive ?? false;
    const eligible = await this.enumerate(accessToken, basePath, recursive);

    // 6 + 7. Persist run + item rows in a transaction, then fan out one job/item.
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.oneDriveImportRun.create({
        data: {
          userId,
          circleId: input.circleId,
          remoteFolderPath: basePath,
          recursive,
          status: OneDriveImportRunStatus.pending,
          totalCount: eligible.length,
        },
      });

      if (eligible.length > 0) {
        await tx.oneDriveImportItem.createMany({
          data: eligible.map((item) => ({
            runId: created.id,
            remoteItemId: item.id,
            remotePath: item.path,
            remoteName: item.name,
            remoteSize: BigInt(item.size),
            status: OneDriveImportItemStatus.pending,
          })),
          skipDuplicates: true,
        });
      }

      return created;
    });

    // Short-circuit: nothing eligible → mark completed immediately.
    if (eligible.length === 0) {
      await this.prisma.oneDriveImportRun.update({
        where: { id: run.id },
        data: {
          status: OneDriveImportRunStatus.completed,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      this.logger.log(
        `OneDrive import run ${run.id}: no eligible media under "${basePath ?? '/'}"; completed immediately`,
      );
      return { runId: run.id, totalCount: 0 };
    }

    const items = await this.prisma.oneDriveImportItem.findMany({
      where: { runId: run.id },
      select: { id: true },
    });

    for (const item of items) {
      await this.enrichmentJobService.enqueue({
        type: ONEDRIVE_IMPORT_JOB_TYPE,
        circleId: input.circleId,
        mediaItemId: null,
        reason: 'backfill',
        priority: 0,
        payload: { runId: run.id, itemId: item.id },
        // REQUIRED: all onedrive_import jobs share mediaItemId=null, so the
        // default (type, mediaItemId IS NULL) dedup would collapse them into one.
        skipDedup: true,
      });
    }

    this.logger.log(
      `OneDrive import run ${run.id} created: ${eligible.length} files queued from "${basePath ?? '/'}" (recursive=${recursive})`,
    );

    return { runId: run.id, totalCount: eligible.length };
  }

  // ---------------------------------------------------------------------------
  // enumerate — bounded folder walk collecting eligible image/video items
  // ---------------------------------------------------------------------------

  private async enumerate(
    accessToken: string,
    basePath: string | null,
    recursive: boolean,
  ): Promise<OneDriveDriveItem[]> {
    const collected: OneDriveDriveItem[] = [];
    const seen = new Set<string>();
    const stack: (string | null)[] = [basePath];

    while (stack.length > 0) {
      const path = stack.pop() ?? null;
      const children = await this.graphClient.listChildren(accessToken, path);

      for (const child of children) {
        if (child.isFolder) {
          if (recursive) stack.push(child.path);
          continue;
        }
        if (!this.isImageOrVideo(child.mimeType)) continue;
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        collected.push(child);

        if (collected.length >= MAX_ENUMERATED_ITEMS) {
          this.logger.warn(
            `OneDrive enumeration hit the ${MAX_ENUMERATED_ITEMS}-item ceiling; truncating`,
          );
          return collected;
        }
      }
    }

    return collected;
  }

  private isImageOrVideo(mimeType: string | null): boolean {
    if (!mimeType) return false;
    return mimeType.startsWith('image/') || mimeType.startsWith('video/');
  }

  // ---------------------------------------------------------------------------
  // listRuns
  // ---------------------------------------------------------------------------

  async listRuns(userId: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.prisma.oneDriveImportRun.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.oneDriveImportRun.count({ where: { userId } }),
    ]);

    return {
      items,
      meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    };
  }

  // ---------------------------------------------------------------------------
  // getRun — recompute per-status item counts from item rows
  // ---------------------------------------------------------------------------

  async getRun(userId: string, runId: string) {
    const run = await this.prisma.oneDriveImportRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.userId !== userId) {
      throw new NotFoundException(`Import run not found: ${runId}`);
    }

    const countsByStatus = await this.prisma.oneDriveImportItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: true,
    });

    const byStatus: Record<string, number> = {};
    for (const row of countsByStatus) {
      byStatus[row.status] = row._count;
    }

    return {
      ...run,
      importedCount: byStatus[OneDriveImportItemStatus.completed] ?? 0,
      failedCount: byStatus[OneDriveImportItemStatus.failed] ?? 0,
      skippedCount: byStatus[OneDriveImportItemStatus.skipped] ?? 0,
      pendingCount: byStatus[OneDriveImportItemStatus.pending] ?? 0,
      runningCount: byStatus[OneDriveImportItemStatus.running] ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // cancelRun
  // ---------------------------------------------------------------------------

  async cancelRun(userId: string, runId: string) {
    const run = await this.prisma.oneDriveImportRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.userId !== userId) {
      throw new NotFoundException(`Import run not found: ${runId}`);
    }

    // Already terminal — no-op, return as-is.
    if (
      run.status !== OneDriveImportRunStatus.pending &&
      run.status !== OneDriveImportRunStatus.running
    ) {
      return run;
    }

    const updated = await this.prisma.oneDriveImportRun.update({
      where: { id: runId },
      data: { status: OneDriveImportRunStatus.cancelled, finishedAt: new Date() },
    });

    // Best-effort: drop still-pending item jobs. In-flight jobs detect the
    // cancelled run via the handler's cancel guard and mark themselves skipped.
    try {
      await this.prisma.$executeRaw`
        DELETE FROM enrichment_jobs
        WHERE type = ${ONEDRIVE_IMPORT_JOB_TYPE}
          AND status = 'pending'
          AND payload->>'runId' = ${runId}
      `;
    } catch (err) {
      this.logger.warn(
        `cancelRun: could not delete pending jobs for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.log(`OneDrive import run ${runId} cancelled by user ${userId}`);
    return updated;
  }
}

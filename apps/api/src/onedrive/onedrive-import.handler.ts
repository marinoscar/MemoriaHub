// =============================================================================
// OneDrive Import Handler
// =============================================================================
//
// Enrichment handler type: 'onedrive_import'
//
// Each job carries a payload: { runId, itemId }
//
// Phase 2 of the OneDrive import flow (see docs/specs/onedrive-import.md §5):
// download one remote file from OneDrive, stream it into the active MemoriaHub
// storage provider, then hand it to MediaService.createMedia so it flows through
// the normal ingest pipeline (content-hash dedup + auto-enrichment).
//
// Failure / finalization strategy is modeled EXACTLY on StorageMigrationHandler:
//   - cancel guard: run cancelled → mark item skipped, return (no throw)
//   - idempotent already-done skip: item completed → return
//   - terminal-attempt detection: attempts + 1 >= MAX_ATTEMPTS → mark item
//     failed, then RETHROW so the worker records the job failure + backoff
//   - RateLimitError propagates untouched so the worker routes it to the
//     rate-limit deferral path rather than the normal-failure retry path
//   - maybeFinalizeRun closes the run once every item is terminal
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';
import {
  EnrichmentJob,
  OneDriveImportItemStatus,
  OneDriveImportRunStatus,
} from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { RateLimitError } from '../enrichment/rate-limit.error';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { toRequestUser } from '../auth/interfaces/authenticated-user.interface';
import { ObjectsService } from '../storage/objects/objects.service';
import { MediaService } from '../media/media.service';
import { MicrosoftGraphClient } from './microsoft-graph.client';
import { OneDriveConnectionService } from './onedrive-connection.service';

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const MAX_ATTEMPTS = getEnvInt('ENRICHMENT_MAX_ATTEMPTS', 3);

@Injectable()
export class OneDriveImportHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'onedrive_import';

  private readonly logger = new Logger(OneDriveImportHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly connectionService: OneDriveConnectionService,
    private readonly graphClient: MicrosoftGraphClient,
    private readonly objectsService: ObjectsService,
    private readonly mediaService: MediaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = job.payload as { runId?: string; itemId?: string } | null;
    if (!payload?.runId || !payload?.itemId) {
      throw new Error(
        `onedrive_import job ${job.id} has invalid payload: ${JSON.stringify(payload)}`,
      );
    }
    const { runId, itemId } = payload;

    // ─── Load item ────────────────────────────────────────────────────────────
    const item = await this.prisma.oneDriveImportItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      this.logger.warn(`onedrive_import job ${job.id}: item ${itemId} not found; skipping`);
      return;
    }

    // Idempotent no-op for retried/duplicate jobs that already succeeded.
    if (item.status === OneDriveImportItemStatus.completed) {
      this.logger.debug(`onedrive_import job ${job.id}: item ${itemId} already completed; skipping`);
      return;
    }

    // ─── Load run ─────────────────────────────────────────────────────────────
    const run = await this.prisma.oneDriveImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      this.logger.warn(`onedrive_import job ${job.id}: run ${runId} not found; skipping`);
      return;
    }

    // Cancel guard: run cancelled → mark item skipped, no error, no retry.
    if (run.status === OneDriveImportRunStatus.cancelled) {
      await this.prisma.oneDriveImportItem.update({
        where: { id: itemId },
        data: { status: OneDriveImportItemStatus.skipped },
      });
      await this.maybeFinalizeRun(runId);
      return;
    }

    // Lazily flip the run to running on the first claimed item.
    if (run.status === OneDriveImportRunStatus.pending) {
      await this.prisma.oneDriveImportRun.update({
        where: { id: runId },
        data: {
          status: OneDriveImportRunStatus.running,
          startedAt: run.startedAt ?? new Date(),
        },
      });
    }

    // Mark item running.
    await this.prisma.oneDriveImportItem.update({
      where: { id: itemId },
      data: { status: OneDriveImportItemStatus.running },
    });

    // ─── Core import (may throw → worker retries / defers) ─────────────────────
    try {
      await this.doImport({ run, item });
      await this.maybeFinalizeRun(runId);
    } catch (err) {
      // Rate-limit signals must propagate untouched — they route to the
      // deferral path (rateLimitHits) rather than the attempts-based failure
      // path, so the item stays retryable and must NOT be marked failed.
      if (err instanceof RateLimitError) {
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);

      // job.attempts is not yet incremented when process() runs; the worker
      // increments it in the failure path after we throw. attempts + 1 >=
      // MAX_ATTEMPTS means there will be no further retry.
      const isTerminal = job.attempts + 1 >= MAX_ATTEMPTS;
      if (isTerminal) {
        try {
          await this.prisma.oneDriveImportItem.update({
            where: { id: itemId },
            data: { status: OneDriveImportItemStatus.failed, lastError: message },
          });
          await this.prisma.oneDriveImportRun.update({
            where: { id: runId },
            data: { lastError: message },
          });
          await this.maybeFinalizeRun(runId);
        } catch (dbErr) {
          this.logger.error(
            `onedrive_import job ${job.id}: failed to record terminal failure for item ${itemId}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
          );
        }
      }

      // Rethrow so the worker records the enrichment_job failure + backoff.
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // doImport — download → hash-while-streaming upload → createMedia
  // ---------------------------------------------------------------------------

  private async doImport(args: {
    run: { id: string; userId: string; circleId: string };
    item: { id: string; remoteItemId: string; remotePath: string; remoteName: string; remoteSize: bigint };
  }): Promise<void> {
    const { run, item } = args;

    // Fresh access token (throws OneDriveConnectionExpiredError on invalid_grant,
    // RateLimitError on a 429 from the token endpoint).
    const accessToken = await this.connectionService.getFreshAccessToken(run.userId);

    // Download content — Graph returns a web ReadableStream (typed as a Node
    // readable by the client). Convert to a Node stream for the uploader.
    const downloaded = await this.graphClient.downloadContent(accessToken, item.remoteItemId);
    const sourceStream = Readable.fromWeb(downloaded as unknown as NodeWebReadableStream);

    // Compute the SHA-256 digest as bytes flow through — never buffer the whole
    // file. The Transform updates the hash and passes each chunk straight into
    // the uploader; once provider.upload() resolves the stream is fully
    // consumed, so hash.digest() is final and safe to read.
    const hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    // Forward source errors so the upload rejects instead of hanging.
    sourceStream.on('error', (e) => hashing.destroy(e));
    const uploadStream = sourceStream.pipe(hashing);

    const mimeType = this.resolveMimeType(item.remoteName);
    const object = await this.objectsService.createObjectFromStream({
      stream: uploadStream,
      mimeType,
      originalName: item.remoteName,
      size: Number(item.remoteSize),
      uploadedById: run.userId,
      auditUploadType: 'onedrive_import',
    });

    const contentHash = hash.digest('hex');
    const type: 'photo' | 'video' = mimeType.startsWith('video/') ? 'video' : 'photo';

    // Resolve the user's permissions exactly as an HTTP request would (same
    // query + aggregation the PermissionsGuard relies on) so createMedia's
    // super-admin / per-circle checks behave identically.
    const authUser = await this.authService.validateJwtPayload({
      sub: run.userId,
      email: '',
      roles: [],
    });
    if (!authUser) {
      throw new Error(`Importing user ${run.userId} is inactive or no longer exists`);
    }
    const userPermissions = toRequestUser(authUser).permissions;

    const result = await this.mediaService.createMedia(
      {
        storageObjectId: object.id,
        type,
        source: 'import',
        sourcePath: item.remotePath,
        sourceDeviceName: 'OneDrive',
        originalFilename: item.remoteName,
        contentHash,
        circleId: run.circleId,
      },
      run.userId,
      userPermissions,
    );

    // On a dedup hit createMedia already cleaned up the redundant StorageObject;
    // still record the existing MediaItem id and mark the item completed.
    await this.prisma.oneDriveImportItem.update({
      where: { id: item.id },
      data: { status: OneDriveImportItemStatus.completed, mediaItemId: result.id },
    });

    if (result.deduplicated) {
      this.logger.debug(
        `onedrive_import: item ${item.id} deduped onto existing MediaItem ${result.id}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // maybeFinalizeRun — close the run once every item is terminal
  // ---------------------------------------------------------------------------

  private async maybeFinalizeRun(runId: string): Promise<void> {
    const run = await this.prisma.oneDriveImportRun.findUnique({ where: { id: runId } });
    if (!run) return;

    if (
      run.status === OneDriveImportRunStatus.completed ||
      run.status === OneDriveImportRunStatus.failed ||
      run.status === OneDriveImportRunStatus.cancelled
    ) {
      return;
    }

    const countsByStatus = await this.prisma.oneDriveImportItem.groupBy({
      by: ['status'],
      where: { runId },
      _count: true,
    });
    const byStatus: Record<string, number> = {};
    for (const row of countsByStatus) byStatus[row.status] = row._count;

    const completed = byStatus[OneDriveImportItemStatus.completed] ?? 0;
    const failed = byStatus[OneDriveImportItemStatus.failed] ?? 0;
    const skipped = byStatus[OneDriveImportItemStatus.skipped] ?? 0;

    if (completed + failed + skipped < run.totalCount) {
      return; // not all items terminal yet
    }

    const finalStatus =
      failed > 0 ? OneDriveImportRunStatus.failed : OneDriveImportRunStatus.completed;

    await this.prisma.oneDriveImportRun.update({
      where: { id: runId },
      data: { status: finalStatus, finishedAt: new Date() },
    });

    this.logger.log(
      `onedrive_import: run ${runId} finalized status=${finalStatus} ` +
        `(completed=${completed}, failed=${failed}, skipped=${skipped})`,
    );
  }

  /**
   * Best-effort MIME resolution from a filename extension. The imported bytes
   * are stored as-is; the metadata pipeline re-derives the authoritative MIME
   * downstream. We only need enough to classify photo vs. video here.
   */
  private resolveMimeType(name: string): string {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const map: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      heic: 'image/heic',
      heif: 'image/heif',
      bmp: 'image/bmp',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      m4v: 'video/x-m4v',
      avi: 'video/x-msvideo',
      mkv: 'video/x-matroska',
      webm: 'video/webm',
      '3gp': 'video/3gpp',
      mpg: 'video/mpeg',
      mpeg: 'video/mpeg',
    };
    return map[ext] ?? 'application/octet-stream';
  }
}

// =============================================================================
// Thumbnail Repair Enrichment Handler
// =============================================================================
//
// Global enrichment job that finds media items whose thumbnail never landed
// (MediaItem.metadata->>'thumbnailStorageKey' IS NULL) even though their
// StorageObject reached a terminal status ('ready' or 'failed'), and repairs
// them via one of two paths:
//
//   1. Cheap resync — the thumbnail actually exists on the StorageObject
//      (_processing.thumbnail is populated) but the MediaItem sync was missed
//      (e.g. the OBJECT_PROCESSED_EVENT fired before the MediaItem row was
//      created). Just re-run MediaMetadataSyncService.syncFromStorageObject.
//
//   2. Full reprocess — the thumbnail genuinely never got generated. Re-run
//      the whole processing pipeline via
//      StorageProcessingRecoveryService.reprocessObjectNow, whose pipeline
//      emits OBJECT_PROCESSED_EVENT and thereby triggers the MediaItem sync
//      automatically. Attempts are capped via a crash-safe counter persisted
//      in StorageObject.metadata._thumbnailRepairAttempts.
//
// Objects at status='processing' are deliberately EXCLUDED — they are owned
// by the existing 10-minute StorageProcessingRecoveryTask cron. This sweep
// owns the 'ready'/'failed' terminal states that cron never revisits.
//
// Runs via the shared enrichment worker queue (type 'thumbnail_repair',
// mediaItemId: null, circleId: null) so it benefits from retries, visibility
// in /admin/jobs, and the (type, mediaItemId IS NULL) dedup guarantee.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EnrichmentJob, Prisma, StorageObject } from '@prisma/client';
import { thumbnailResultSchema } from '@memoriahub/enrichment-compute/dto';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { MediaMetadataSyncService } from './sync/media-metadata-sync.service';
import { ThumbnailNodePersistService } from './thumbnail-node-persist.service';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_AGE_MINUTES = 30;

/** Raw row shape returned by the candidate $queryRaw. */
interface ThumbnailRepairCandidate {
  media_item_id: string;
  storage_object_id: string;
}

type RepairOutcome = 'resynced' | 'reprocessed' | 'exhausted' | 'failed';

@Injectable()
export class ThumbnailRepairHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'thumbnail_repair';

  /**
   * NOTE ON NODE ELIGIBILITY: `thumbnail_repair` is a GLOBAL sweep job
   * (mediaItemId: null, circleId: null) that batch-repairs many media items
   * per run (see repairOne() below) — it has no single input object for a
   * node to download and no single output for persistNodeResult to receive.
   * nodeResultSchema/persistNodeResult are wired here for interface parity
   * with ThumbnailRegenHandler (and per the distributed-nodes contract that
   * every thumbnail-producing handler exposes the same node result shape),
   * but in the current claim model
   * (`POST /api/nodes/:id/jobs/:jobId/claim` claims whole job rows, one node
   * result per job) a node cannot actually claim and complete this job type
   * end-to-end — that would require per-item claim granularity this global
   * sweep job doesn't have. Real distributed thumbnail repair, if wanted,
   * would need the sweep to fan out one `thumbnail_regen`-shaped job per
   * candidate rather than repairing a batch in one job.
   */
  readonly nodeResultSchema = thumbnailResultSchema;

  private readonly logger = new Logger(ThumbnailRepairHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly mediaMetadataSyncService: MediaMetadataSyncService,
    private readonly storageProcessingRecoveryService: StorageProcessingRecoveryService,
    private readonly thumbnailNodePersistService: ThumbnailNodePersistService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * See the nodeResultSchema doc comment above: wired for parity, but this
   * global sweep job has no single mediaItemId for persistThumbnail to act
   * on unless a future caller enqueues a per-item-shaped thumbnail_repair job
   * (mediaItemId set) — persistThumbnail itself already handles that case
   * correctly (it reads job.mediaItemId), so this passes straight through.
   */
  async persistNodeResult(job: EnrichmentJob, result: unknown): Promise<void> {
    const parsed = thumbnailResultSchema.parse(result);
    await this.thumbnailNodePersistService.persistThumbnail(job, parsed);
  }

  async process(_job: EnrichmentJob): Promise<void> {
    const batchSize = parseInt(
      process.env['THUMBNAIL_REPAIR_BATCH_SIZE'] ?? String(DEFAULT_BATCH_SIZE),
      10,
    );
    const maxAttempts = parseInt(
      process.env['THUMBNAIL_REPAIR_MAX_ATTEMPTS'] ?? String(DEFAULT_MAX_ATTEMPTS),
      10,
    );
    const minAgeMinutes = parseInt(
      process.env['THUMBNAIL_REPAIR_MIN_AGE_MINUTES'] ?? String(DEFAULT_MIN_AGE_MINUTES),
      10,
    );

    // Candidates: live media items with no thumbnail reference whose storage
    // object settled at a terminal status long enough ago that in-flight
    // processing cannot explain the gap. status='processing' is excluded on
    // purpose — those objects belong to StorageProcessingRecoveryTask.
    const candidates = await this.prisma.$queryRaw<ThumbnailRepairCandidate[]>(Prisma.sql`
      SELECT mi.id AS media_item_id, so.id AS storage_object_id
      FROM media_items mi
      JOIN storage_objects so ON so.id = mi.storage_object_id
      WHERE mi.deleted_at IS NULL
        AND (mi.metadata->>'thumbnailStorageKey') IS NULL
        AND so.status IN ('ready', 'failed')
        AND so.updated_at < now() - (${minAgeMinutes} * interval '1 minute')
        AND so.storage_key NOT LIKE 'thumbnails/%'
        AND (so.mime_type LIKE 'image/%' OR so.mime_type LIKE 'video/%')
        AND COALESCE((so.metadata->>'_thumbnailRepairAttempts')::int, 0) < ${maxAttempts}
      ORDER BY so.updated_at ASC
      LIMIT ${batchSize}
    `);

    const counts = { resynced: 0, reprocessed: 0, exhausted: 0, errors: 0 };

    if (candidates.length === 0) {
      this.logger.log(
        'thumbnail_repair: candidates=0 resynced=0 reprocessed=0 exhausted=0 errors=0',
      );
      return;
    }

    // Sequential, not Promise.all: the reprocess path runs the full
    // sharp/ffmpeg pipeline, which is memory-heavy — the exact workload that
    // causes OOM incidents in the first place. Same rationale as
    // StorageProcessingRecoveryService: don't add concurrent memory pressure
    // while repairing the aftermath of a memory incident.
    for (const candidate of candidates) {
      try {
        const outcome = await this.repairOne(candidate.storage_object_id, maxAttempts);
        if (outcome === 'failed') {
          counts.errors++;
        } else {
          counts[outcome]++;
        }
      } catch (err) {
        counts.errors++;
        this.logger.error(
          `thumbnail_repair: error repairing object ${candidate.storage_object_id} ` +
            `(media item ${candidate.media_item_id}): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }

    this.logger.log(
      `thumbnail_repair: candidates=${candidates.length} resynced=${counts.resynced} ` +
        `reprocessed=${counts.reprocessed} exhausted=${counts.exhausted} errors=${counts.errors}`,
    );
  }

  private async repairOne(storageObjectId: string, maxAttempts: number): Promise<RepairOutcome> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id: storageObjectId },
    });

    if (!object) {
      this.logger.warn(`thumbnail_repair: StorageObject ${storageObjectId} vanished; skipping`);
      return 'failed';
    }

    const meta = (object.metadata as Record<string, unknown> | null) ?? {};
    const processing = meta['_processing'] as Record<string, Record<string, unknown>> | undefined;
    const thumbMeta = processing?.['thumbnail'];

    // -------------------------------------------------------------------
    // Cheap resync path: the thumbnail already exists on the StorageObject;
    // only the MediaItem sync was missed. No attempts-counter bump — nothing
    // expensive or crash-prone happens here.
    // -------------------------------------------------------------------
    if (
      typeof thumbMeta?.['thumbnailObjectId'] === 'string' &&
      typeof thumbMeta?.['thumbnailStorageKey'] === 'string'
    ) {
      await this.mediaMetadataSyncService.syncFromStorageObject(object.id);
      this.logger.log(`thumbnail_repair: resynced existing thumbnail for object ${object.id}`);
      return 'resynced';
    }

    // -------------------------------------------------------------------
    // Reprocess path: the thumbnail never got generated — re-run the full
    // processing pipeline.
    // -------------------------------------------------------------------
    const attempts =
      typeof meta['_thumbnailRepairAttempts'] === 'number'
        ? (meta['_thumbnailRepairAttempts'] as number)
        : 0;
    const nextAttempts = attempts + 1;

    // Persist the incremented counter BEFORE invoking the pipeline. If this
    // repair attempt itself gets killed mid-flight (OOM — plausible, since the
    // pipeline is the memory-heavy part), the counter must have already
    // advanced — otherwise the object would be reclaimed and retried forever
    // every sweep without ever reaching maxAttempts. Mirrors
    // StorageProcessingRecoveryService.recoverOne.
    const claimed = await this.prisma.storageObject.update({
      where: { id: object.id },
      data: {
        metadata: {
          ...meta,
          _thumbnailRepairAttempts: nextAttempts,
          ...(nextAttempts >= maxAttempts ? { _thumbnailRepairExhausted: true } : {}),
        } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `thumbnail_repair: reprocessing object ${object.id} (attempt ${nextAttempts}/${maxAttempts})`,
    );

    // reprocessObjectNow's pipeline emits OBJECT_PROCESSED_EVENT, which
    // triggers the MediaItem metadata sync automatically — no manual sync
    // call needed on this path.
    await this.storageProcessingRecoveryService.reprocessObjectNow(claimed);

    // Did the reprocess actually produce a thumbnail on the MediaItem?
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { storageObjectId: object.id },
      select: { metadata: true },
    });
    const itemMeta = (mediaItem?.metadata as Record<string, unknown> | null) ?? {};

    if (typeof itemMeta['thumbnailStorageKey'] === 'string') {
      // Success — clear the repair bookkeeping so a future regression gets a
      // fresh budget. Re-read the row first: the pipeline just merged new
      // _processing results into metadata and we must not clobber them.
      const fresh = await this.prisma.storageObject.findUnique({
        where: { id: object.id },
        select: { metadata: true },
      });
      const freshMeta = (fresh?.metadata as Record<string, unknown> | null) ?? {};
      const {
        _thumbnailRepairAttempts: _droppedAttempts,
        _thumbnailRepairExhausted: _droppedExhausted,
        ...restMeta
      } = freshMeta;

      await this.prisma.storageObject.update({
        where: { id: object.id },
        data: { metadata: restMeta as Prisma.InputJsonValue },
      });

      return 'reprocessed';
    }

    if (nextAttempts >= maxAttempts) {
      this.logger.warn(
        `thumbnail_repair: object ${object.id} exhausted ${nextAttempts} attempts without a thumbnail — will not retry again`,
      );
      return 'exhausted';
    }

    this.logger.warn(
      `thumbnail_repair: reprocess of object ${object.id} did not yield a thumbnail ` +
        `(attempt ${nextAttempts}/${maxAttempts}); will retry on a later sweep`,
    );
    return 'failed';
  }
}

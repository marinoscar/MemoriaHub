import { Injectable, Logger } from '@nestjs/common';
import { Prisma, StorageObject } from '@prisma/client';
import type { ObjectProcessingOutcome } from '@marinoscar/platform-api/storage';

import { PrismaService } from '../../prisma/prisma.service';
import { MediaObjectProcessingService } from '../media-object-processing.service';

// =============================================================================
// ObjectReprocessService: re-run the processors for ONE object, now (RETRO-D1b, #567)
// =============================================================================
//
// For callers that need the result in hand, all of them already bounded:
//
//   * the three synchronous HTTP callers, whose response reports the outcome:
//     `POST /api/media/:id/thumbnail/rerun`, the orientation edit, and the AI
//     enhancer's replace (and keep-both copy);
//   * code already inside a job: `thumbnail_regen`, `thumbnail_repair`.
//
// Open decision 1 of #567: the platform exposes a run-processors-now API
// (`ObjectProcessingService.run`, wrapped by `MediaObjectProcessingService.runNow`),
// so these callers keep inline execution of ONE object and their response
// contract (`{ status, width, height }`), with no enqueue-and-wait. Everything
// that touches MANY objects (recovery, the admin bulk reprocess) is a queue job
// (`StorageRecoveryService`).
//
// A destructive overwrite must then, in order (issue #434): this call ->
// AWAIT `MediaMetadataSyncService.syncFromStorageObject` ->
// `ThumbnailPruneService.pruneSupersededThumbnails`. That ordering lives at the
// call sites (MediaModule owns the sync service; MediaProcessingModule cannot
// import it without a cycle) and is pinned by their specs.
// =============================================================================

@Injectable()
export class ObjectReprocessService {
  private readonly logger = new Logger(ObjectReprocessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processing: MediaObjectProcessingService,
  ) {}

  /**
   * Resets `object` to `processing` with its retry bookkeeping cleared (an
   * explicit request always gets a fresh attempt), runs every registered
   * processor against it, writes `ready` or `failed`, and emits
   * `OBJECT_PROCESSED_EVENT`. The write is scoped to the object's organization.
   */
  async reprocessNow(object: StorageObject): Promise<ObjectProcessingOutcome> {
    const existingMeta =
      object.metadata && typeof object.metadata === 'object' && !Array.isArray(object.metadata)
        ? (object.metadata as Record<string, unknown>)
        : {};
    const { _processingRetryCount, _processingRetryExhausted, ...restMeta } = existingMeta;

    const reset = await this.prisma.forOrg(object.orgId).storageObject.update({
      where: { id: object.id },
      data: { status: 'processing', metadata: restMeta as Prisma.InputJsonValue },
    });

    this.logger.log(`reprocessNow: re-running the processors for object ${object.id}`);
    return this.processing.runNow(reset);
  }
}

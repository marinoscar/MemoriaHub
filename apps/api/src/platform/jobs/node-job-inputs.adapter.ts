// =============================================================================
// The nodes slice's NODE_JOB_INPUTS binding (RETRO-C2, #581)
// =============================================================================
//
// Which stored object a node-held job reads. MemoriaHub's per-item jobs are about a media item
// (`subjectType = 'media_item'`, `subjectId` = its id): the object is that item's `StorageObject`.
// The data plane signs a download URL for `storageKey` through `NODE_OBJECT_STORE`
// (`jobs-host.module.ts`) and a node never names a key itself.
//
// A job with another subject (a circle sweep, a global job) has no input object and is refused with
// the slice's `NodeJobInputError`, which the data plane answers with a 422.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Job } from '@marinoscar/platform-api/jobs';
import { NodeJobInputError, type NodeJobInputObject, type NodeJobInputs } from '@marinoscar/platform-api/nodes';

import { PrismaService } from '../../prisma/prisma.service';

/** The media-item subject type of MemoriaHub's per-item jobs (see `media-item-job.ts`). */
const MEDIA_ITEM_SUBJECT = 'media_item';

/** MemoriaHub's {@link NodeJobInputs}: the `StorageObject` of the job's media item. */
@Injectable()
export class NodeJobInputsAdapter implements NodeJobInputs {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(job: Job): Promise<NodeJobInputObject> {
    if (job.subjectType !== MEDIA_ITEM_SUBJECT || !job.subjectId) {
      throw new NodeJobInputError(
        'missing_subject_id',
        `Job ${job.id} is not about a media item: it has no input object`,
        job.id,
        job.subjectId ?? null,
      );
    }

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.subjectId },
      select: { storageObjectId: true },
    });
    if (!mediaItem?.storageObjectId) {
      throw new NodeJobInputError(
        'input_object_not_found',
        `Media item ${job.subjectId} of job ${job.id} no longer exists or has no stored object`,
        job.id,
        job.subjectId,
      );
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: mediaItem.storageObjectId },
      select: { id: true, storageKey: true, size: true, mimeType: true },
    });
    if (!object) {
      throw new NodeJobInputError(
        'input_object_not_found',
        `The stored object of media item ${job.subjectId} (job ${job.id}) was not found`,
        job.id,
        job.subjectId,
      );
    }
    if (!object.storageKey) {
      throw new NodeJobInputError(
        'input_object_has_no_storage_key',
        `The stored object of media item ${job.subjectId} (job ${job.id}) has no storage key`,
        job.id,
        job.subjectId,
      );
    }
    return { id: object.id, storageKey: object.storageKey, size: object.size, mimeType: object.mimeType };
  }
}

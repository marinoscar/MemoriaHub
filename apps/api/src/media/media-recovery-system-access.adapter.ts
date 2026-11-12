import { Injectable } from '@nestjs/common';
import type { MediaModels, MediaSystemAccess, MediaTx } from '@marinoscar/memoriahub-api/media';

import { STORAGE_PROCESSING_RECOVERY_REASON } from '../app-registrations/system-access-reasons';
import { PrismaSystemService } from '../prisma/prisma-system.service';

/**
 * Binds the media slice's `MEDIA_RECOVERY_SYSTEM_ACCESS` hook to the cross-organization client under the
 * `storage-processing-recovery` reason: the `media.storage.recover_stuck` and `media.storage.reprocess`
 * jobs scan `storage_objects` across organizations, bump their retry counters and queue a
 * `storage.object.process` job for each; they are system jobs with no organization to scope to.
 */
@Injectable()
export class MediaRecoverySystemAccessAdapter implements MediaSystemAccess {
  constructor(private readonly system: PrismaSystemService) {}

  runAsSystem<R>(fn: (tx: MediaTx) => Promise<R>): Promise<R> {
    return this.system.runAsSystem(STORAGE_PROCESSING_RECOVERY_REASON, (tx) => fn(tx as unknown as MediaTx));
  }

  asSystem(): MediaModels {
    return this.system.asSystem(STORAGE_PROCESSING_RECOVERY_REASON) as unknown as MediaModels;
  }
}

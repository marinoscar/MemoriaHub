import { Injectable } from '@nestjs/common';
import type { MediaModels, MediaSystemAccess, MediaTx } from '@marinoscar/memoriahub-api/media';

import { MEDIA_HOUSEKEEPING_REASON } from '../app-registrations/system-access-reasons';
import { PrismaSystemService } from '../prisma/prisma-system.service';

/**
 * Binds the media slice's `MEDIA_SYSTEM_ACCESS` hook to the cross-organization client under the
 * `media-housekeeping` reason: the global `thumbnail_repair` sweep finds and counts repair
 * attempts across organizations and has none to scope to.
 */
@Injectable()
export class MediaSystemAccessAdapter implements MediaSystemAccess {
  constructor(private readonly system: PrismaSystemService) {}

  runAsSystem<R>(fn: (tx: MediaTx) => Promise<R>): Promise<R> {
    return this.system.runAsSystem(MEDIA_HOUSEKEEPING_REASON, (tx) => fn(tx as unknown as MediaTx));
  }

  asSystem(): MediaModels {
    return this.system.asSystem(MEDIA_HOUSEKEEPING_REASON) as unknown as MediaModels;
  }
}

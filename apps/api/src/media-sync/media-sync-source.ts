import { HttpStatus } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { MEDIA_SYNC_REASONS } from './media-sync.constants';
import { mediaSyncRefusal } from './media-sync-refusal';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `POST /api/media` attribution guard (epic #498, issue #505): a media item
 * registered with `source: 'android'` and a `sourceDeviceId` must name an
 * ACTIVE media sync device owned by the caller, else 400
 * `UNKNOWN_SOURCE_DEVICE`. This stops one user (or a stale, unpaired phone)
 * from attributing uploads to a device that is not theirs. A client that
 * sends no `sourceDeviceId`, or another `source`, is unaffected.
 *
 * A plain function over `PrismaService` rather than a provider, so the media
 * module can call it without importing the media-sync module.
 */
export async function assertMediaSyncSourceDevice(
  prisma: Pick<PrismaService, 'mediaSyncDevice'>,
  userId: string,
  source: string,
  sourceDeviceId: string | undefined,
): Promise<void> {
  if (source !== 'android' || sourceDeviceId === undefined) return;

  const refuse = () =>
    mediaSyncRefusal(
      HttpStatus.BAD_REQUEST,
      MEDIA_SYNC_REASONS.UNKNOWN_SOURCE_DEVICE,
      'sourceDeviceId must be an active media sync device of yours',
    );

  if (!UUID_PATTERN.test(sourceDeviceId)) throw refuse();
  const device = await prisma.mediaSyncDevice.findFirst({
    where: { id: sourceDeviceId, userId, status: 'active' },
    select: { id: true },
  });
  if (!device) throw refuse();
}

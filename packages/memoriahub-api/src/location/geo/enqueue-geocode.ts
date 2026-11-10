import type { Logger } from '@nestjs/common';

import { enqueueEnrichmentJob } from '../../media/index.js';
import type { MemoriahubEnqueueResult, MemoriahubJobsPort } from '../../ports/index.js';
import type { LocationDb } from '../data/location-db.js';

/**
 * Queues a `geocode` job for a media item. The job carries the item's coordinates in its payload
 * (a worker node holds no database access, so the payload is the only place it can learn where to
 * look up); the handler still re-reads the item when it runs on the server. Best-effort on the
 * coordinates: a failed read queues the job without them.
 *
 * @param jobs - the jobs port.
 * @param prisma - the database port, read for the coordinates.
 * @param input - the item, its circle, why and how urgent.
 * @param logger - receives a note when the coordinates could not be read.
 * @stability experimental
 */
export async function enqueueGeocodeJob(
  jobs: MemoriahubJobsPort,
  prisma: Pick<LocationDb, 'mediaItem'>,
  input: { mediaItemId: string; circleId: string; reason: string; priority: number },
  logger?: Pick<Logger, 'warn'>,
): Promise<MemoriahubEnqueueResult> {
  let payload: Record<string, unknown> | undefined;
  try {
    const item = await prisma.mediaItem.findUnique({
      where: { id: input.mediaItemId },
      select: { takenLat: true, takenLng: true },
    });
    if (item && Number.isFinite(item.takenLat) && Number.isFinite(item.takenLng)) {
      payload = { lat: item.takenLat, lng: item.takenLng };
    }
  } catch (error) {
    logger?.warn(`Could not read coordinates for geocode job of ${input.mediaItemId}: ${String(error)}`);
  }
  return enqueueEnrichmentJob(jobs, {
    type: 'geocode',
    mediaItemId: input.mediaItemId,
    circleId: input.circleId,
    reason: input.reason,
    priority: input.priority,
    ...(payload !== undefined ? { payload } : {}),
  });
}

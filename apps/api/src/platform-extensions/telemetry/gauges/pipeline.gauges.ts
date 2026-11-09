// =============================================================================
// Media pipeline gauges (RETRO-T3, #628)
// =============================================================================
//
//   app.media.processing.backlog{status}  storage_objects not yet ready
//                                         (one GROUP BY over `@@index([status])`)
//   app.enrichment.pending{stage}         rows of the five per-item status tables
//                                         at pending/processing (five indexed counts;
//                                         `media_face_status` has no `status` index,
//                                         see docs/specs/telemetry-metrics.md)
//
// Each read is memoized for 60 s and runs only while the export gate is open.
// `storage_objects` is an org (row-level security) table and the gauge counts
// across organizations, so its read runs as the system client with the
// `admin-aggregate` reason. PLATFORM-ADOPTION-SHIM(RETRO-D1): over `PrismaService`
// until a separate `PrismaSystemService` exists.
// =============================================================================

import { runAsSystem } from '@marinoscar/platform-api/core';

import type { PrismaService } from '../../../prisma/prisma.service';
import { BACKLOG_STATUSES, ENRICHMENT_STAGES } from '../memoriahub-metrics.manifest';

export type BacklogCounts = Record<(typeof BACKLOG_STATUSES)[number], number>;
export type PendingCounts = Record<(typeof ENRICHMENT_STAGES)[number], number>;

const ACTIVE: Array<'pending' | 'processing'> = ['pending', 'processing'];

/** Stored objects not yet ready, by status (every status reported, zeros included). */
export async function readProcessingBacklog(prisma: PrismaService): Promise<BacklogCounts> {
  const rows = await runAsSystem(prisma, 'admin-aggregate', async (tx) => {
    const grouped = await (tx as unknown as PrismaService).storageObject.groupBy({
      by: ['status'],
      where: { status: { in: [...BACKLOG_STATUSES] } },
      _count: { _all: true },
    });
    return grouped.map((row) => ({ status: row.status as string, count: row._count._all }));
  });
  const counts: BacklogCounts = { pending: 0, uploading: 0, processing: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status as keyof BacklogCounts] = row.count;
  }
  return counts;
}

/** Media items pending or processing per enrichment stage. */
export async function readEnrichmentPending(prisma: PrismaService): Promise<PendingCounts> {
  const where = { status: { in: [...ACTIVE] } };
  const [faces, tags, metadata, geocode, social] = await Promise.all([
    prisma.mediaFaceStatus.count({ where }),
    prisma.mediaTagStatus.count({ where }),
    prisma.mediaMetadataStatus.count({ where }),
    prisma.mediaGeocodeStatus.count({ where }),
    prisma.mediaSocialStatus.count({ where }),
  ]);
  return { faces, tags, metadata, geocode, social };
}

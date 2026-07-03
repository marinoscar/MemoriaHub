import { Injectable, Logger } from '@nestjs/common';
import { JobReason, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';

const PAGE_SIZE = 5000;
const CHUNK_SIZE = 100;

export interface DuplicateBackfillOptions {
  from?: string;
  to?: string;
  force?: boolean;
}

/**
 * DuplicateBackfillService
 *
 * App-wide backfill of duplicate detection across all circles. Uses
 * keyset (id-cursor) pagination to page through eligible photos 5 000 at a
 * time (bounded memory, resumable), then slices each page into 100-id
 * chunks enqueued as `duplicate_detection_batch` jobs — never spanning
 * circle boundaries, mirroring TaggingBackfillService's per-circle loop.
 *
 * When `force` is false (default), only items without an existing visual
 * embedding row are eligible — this is the closest available "not yet
 * processed" signal, since duplicate detection has no dedicated per-item
 * status table (unlike tagging/geocode/metadata).
 */
@Injectable()
export class DuplicateBackfillService {
  private readonly logger = new Logger(DuplicateBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentJobService: EnrichmentJobService,
  ) {}

  async backfillAllCircles(
    opts: DuplicateBackfillOptions,
  ): Promise<{ enqueued: number; circles: number; estimatedItems: number }> {
    const circles = await this.prisma.circle.findMany({ select: { id: true } });

    let totalJobs = 0;
    let totalItems = 0;

    for (const circle of circles) {
      const { jobs, items } = await this.backfillCircle(circle.id, opts);
      totalJobs += jobs;
      totalItems += items;
    }

    this.logger.log(
      `Global duplicate-detection backfill complete: ${totalJobs} job(s) enqueued for ~${totalItems} item(s) across ${circles.length} circle(s)`,
    );

    return { enqueued: totalJobs, circles: circles.length, estimatedItems: totalItems };
  }

  private async backfillCircle(
    circleId: string,
    opts: DuplicateBackfillOptions,
  ): Promise<{ jobs: number; items: number }> {
    const force = opts.force ?? false;
    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;

    let cursor: string | undefined;
    let jobs = 0;
    let items = 0;
    let done = false;

    while (!done) {
      const page = await this.fetchEligibleIdsPage(circleId, { from, to, force, cursor, limit: PAGE_SIZE });
      items += page.length;

      for (let i = 0; i < page.length; i += CHUNK_SIZE) {
        const chunk = page.slice(i, i + CHUNK_SIZE);
        await this.enrichmentJobService.enqueue({
          type: 'duplicate_detection_batch',
          circleId,
          reason: JobReason.backfill,
          priority: 100,
          payload: { mediaItemIds: chunk },
          // Many distinct batch jobs share circleId with a null mediaItemId —
          // skip the default dedup so each chunk gets its own job row.
          skipDedup: true,
        });
        jobs++;
      }

      if (page.length < PAGE_SIZE) {
        done = true;
      } else {
        cursor = page[page.length - 1];
      }
    }

    this.logger.log(
      `Duplicate-detection backfill: circle ${circleId} — ${jobs} job(s) enqueued for ${items} item(s) (force=${force})`,
    );

    return { jobs, items };
  }

  private async fetchEligibleIdsPage(
    circleId: string,
    opts: { from?: Date; to?: Date; force: boolean; cursor?: string; limit: number },
  ): Promise<string[]> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`circle_id = ${circleId}::uuid`,
      Prisma.sql`type = 'photo'`,
      Prisma.sql`deleted_at IS NULL`,
      Prisma.sql`archived_at IS NULL`,
    ];

    if (opts.from) conditions.push(Prisma.sql`captured_at >= ${opts.from}`);
    if (opts.to) conditions.push(Prisma.sql`captured_at <= ${opts.to}`);
    if (!opts.force) {
      conditions.push(
        Prisma.sql`NOT EXISTS (SELECT 1 FROM media_visual_embedding mve WHERE mve.media_item_id = media_items.id)`,
      );
    }
    if (opts.cursor) conditions.push(Prisma.sql`id > ${opts.cursor}::uuid`);

    const whereClause = Prisma.join(conditions, ' AND ');

    const rows = await this.prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM media_items WHERE ${whereClause} ORDER BY id ASC LIMIT ${opts.limit}`,
    );

    return rows.map((r) => r.id);
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DuplicateGroupStatus, EnrichmentJob, Prisma } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { DuplicateDetectionService } from './duplicate-detection.service';

/** Optional payload for a `duplicate_confidence_backfill` job. */
interface DuplicateConfidenceBackfillPayload {
  /** Optional cap on groups processed in one run (defaults to unbounded). */
  limit?: number;
}

/** Keyset page size for the pending-group scan. */
const PAGE_SIZE = 500;

/**
 * One-pass backfill of `duplicate_groups.confidence` (issue #190).
 *
 * `DuplicateDetectionService.recomputeGroupMeta` became the authoritative writer
 * of the new column, and `DuplicateService`'s read paths self-heal one group at
 * a time — but a group that is neither mutated nor viewed would stay NULL
 * forever, and a NULL-confidence group is excluded from threshold runs in both
 * directions. This global job closes that historical gap in a single pass.
 *
 * Scans PENDING groups with `confidence IS NULL` by ascending id (a stable
 * keyset that keeps advancing even when a group's similarity is genuinely
 * uncomputable and the column stays NULL), and recomputes each one's
 * tightest-pair CLIP similarity from its live members.
 *
 * SERVER-ONLY by omission: no `nodeResultSchema` / `persistNodeResult` pair —
 * the computation is a pure pgvector query with no media bytes to stream, so
 * there is nothing for a distributed node to do.
 */
@Injectable()
export class DuplicateConfidenceBackfillHandler implements EnrichmentHandler, OnModuleInit {
  readonly type = 'duplicate_confidence_backfill';

  private readonly logger = new Logger(DuplicateConfidenceBackfillHandler.name);

  constructor(
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly detection: DuplicateDetectionService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: EnrichmentJob): Promise<void> {
    const payload = (job.payload as unknown as DuplicateConfidenceBackfillPayload | null) ?? {};
    const limit = typeof payload.limit === 'number' && payload.limit > 0 ? payload.limit : null;

    let scanned = 0;
    let filled = 0;
    let uncomputable = 0;
    let errors = 0;
    let cursorId: string | null = null;

    for (;;) {
      const remaining = limit === null ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - scanned);
      if (remaining <= 0) break;

      const where: Prisma.DuplicateGroupWhereInput = {
        status: DuplicateGroupStatus.pending,
        confidence: null,
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      };

      const groups: { id: string }[] = await this.prisma.duplicateGroup.findMany({
        where,
        orderBy: { id: 'asc' },
        take: remaining,
        select: { id: true },
      });

      if (groups.length === 0) break;
      cursorId = groups[groups.length - 1].id;
      scanned += groups.length;

      for (const group of groups) {
        try {
          const members = await this.prisma.mediaItem.findMany({
            where: { duplicateGroupId: group.id, deletedAt: null, archivedAt: null },
            select: { id: true },
          });
          const confidence = await this.detection.computeGroupConfidence(
            members.map((m) => m.id),
          );
          if (confidence === null) {
            // Genuinely uncomputable — leave NULL (the documented "excluded from
            // threshold matching in both directions" state) and move on.
            uncomputable++;
            continue;
          }
          await this.prisma.duplicateGroup.update({
            where: { id: group.id },
            data: { confidence },
          });
          filled++;
        } catch (err) {
          errors++;
          this.logger.warn(
            `duplicate_confidence_backfill failed for group ${group.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      if (groups.length < remaining) break; // last page
    }

    this.logger.log({
      event: 'duplicate_confidence_backfill.completed',
      jobId: job.id,
      scanned,
      filled,
      uncomputable,
      errors,
    });
  }
}

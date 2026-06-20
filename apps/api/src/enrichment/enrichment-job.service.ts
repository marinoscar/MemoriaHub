import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentJob, JobStatus, JobReason } from '@prisma/client';

export interface EnqueueInput {
  type: string;
  mediaItemId?: string | null;
  circleId?: string | null;
  reason: JobReason;
  priority?: number;
  providerKey?: string;
  modelVersion?: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class EnrichmentJobService {
  private readonly logger = new Logger(EnrichmentJobService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueInput): Promise<EnrichmentJob> {
    const { type, mediaItemId = null, circleId = null, reason, priority = 0, providerKey, modelVersion, payload } = input;

    // Idempotency: return existing pending/running job of same type for same media item.
    // For global jobs (mediaItemId IS NULL), Prisma treats `mediaItemId: null` as IS NULL,
    // which correctly deduplicates global jobs by type.
    const existing = await this.prisma.enrichmentJob.findFirst({
      where: {
        type,
        mediaItemId,
        status: { in: [JobStatus.pending, JobStatus.running] },
      },
    });

    if (existing) {
      this.logger.debug(`Enrichment job already exists for type="${type}" mediaItemId="${mediaItemId ?? 'global'}" (status=${existing.status}); skipping enqueue.`);
      return existing;
    }

    const job = await this.prisma.enrichmentJob.create({
      data: {
        type,
        mediaItemId,
        circleId,
        status: JobStatus.pending,
        reason,
        priority,
        providerKey,
        modelVersion,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: (payload ?? undefined) as any,
      },
    });

    this.logger.log(`Enqueued enrichment job type="${type}" mediaItemId="${mediaItemId ?? 'global'}" reason="${reason}" priority=${priority} id=${job.id}`);
    return job;
  }

  /**
   * Record which provider/model processed a job, so the admin jobs dashboard and
   * historical job rows show the model used (unlike per-item status tables, which
   * get overwritten on re-runs). Best-effort — never throws.
   */
  async recordModel(jobId: string, providerKey: string | null, modelVersion: string | null): Promise<void> {
    try {
      await this.prisma.enrichmentJob.update({
        where: { id: jobId },
        data: { providerKey, modelVersion },
      });
    } catch (err) {
      this.logger.warn(`recordModel failed for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentJob, JobStatus } from '@prisma/client';

const MAX_ATTEMPTS = 3;

@Injectable()
export class EnrichmentJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnrichmentJobWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EnrichmentHandlerRegistry,
  ) {}

  onModuleInit(): void {
    // Check both new and legacy env vars for backwards compatibility
    const enrichmentEnabled = process.env['ENRICHMENT_WORKER_ENABLED'];
    const faceEnabled = process.env['FACE_WORKER_ENABLED'];
    if (enrichmentEnabled === 'false' || faceEnabled === 'false') {
      this.logger.log('EnrichmentJobWorker disabled via env var');
      return;
    }

    const pollMs = parseInt(
      process.env['ENRICHMENT_JOB_POLL_MS'] ?? process.env['FACE_JOB_POLL_MS'] ?? '5000',
      10,
    );
    this.logger.log(`EnrichmentJobWorker starting; poll interval: ${pollMs}ms`);

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('EnrichmentJobWorker stopped');
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('EnrichmentJobWorker tick skipped — previous tick still running');
      return;
    }

    this.running = true;
    try {
      const concurrency = parseInt(
        process.env['ENRICHMENT_WORKER_CONCURRENCY'] ?? process.env['FACE_WORKER_CONCURRENCY'] ?? '1',
        10,
      );
      await this.processBatch(concurrency);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`EnrichmentJobWorker tick error: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async processBatch(concurrency: number): Promise<void> {
    const jobs: EnrichmentJob[] = [];

    for (let i = 0; i < concurrency; i++) {
      const job = await this.claimNextJob();
      if (!job) break;
      jobs.push(job);
    }

    if (jobs.length === 0) return;

    this.logger.debug(`EnrichmentJobWorker claimed ${jobs.length} job(s)`);
    await Promise.all(jobs.map((job) => this.processJob(job)));
  }

  private async claimNextJob(): Promise<EnrichmentJob | null> {
    // Atomic claim: find + update in one transaction
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.enrichmentJob.findFirst({
        where: { status: JobStatus.pending },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });

      if (!job) return null;

      return tx.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.running,
          startedAt: new Date(),
        },
      });
    });
  }

  private async processJob(job: EnrichmentJob): Promise<void> {
    const handler = this.registry.get(job.type);

    if (!handler) {
      const errMsg = `No handler registered for enrichment job type "${job.type}"`;
      this.logger.error(`EnrichmentJob ${job.id}: ${errMsg}`);
      await this.prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.failed,
          lastError: errMsg,
          finishedAt: new Date(),
        },
      });
      return;
    }

    try {
      await handler.process(job);

      await this.prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.succeeded,
          finishedAt: new Date(),
        },
      });

      this.logger.log(`EnrichmentJob ${job.id} (type="${job.type}") succeeded for MediaItem ${job.mediaItemId ?? 'global'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`EnrichmentJob ${job.id} (type="${job.type}") failed: ${message}`);

      const newAttempts = job.attempts + 1;
      const shouldRetry = newAttempts < MAX_ATTEMPTS;

      await this.prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: shouldRetry ? JobStatus.pending : JobStatus.failed,
          attempts: newAttempts,
          lastError: message,
          ...(shouldRetry ? {} : { finishedAt: new Date() }),
        },
      });

      this.logger.warn(
        `EnrichmentJob ${job.id}: attempt ${newAttempts}/${MAX_ATTEMPTS}; ` +
          (shouldRetry ? 'will retry' : 'marked failed'),
      );
    }
  }
}

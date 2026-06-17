import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FaceDetectionService } from '../face-detection.service';
import { FaceJob, FaceJobStatus } from '@prisma/client';

const MAX_ATTEMPTS = 3;

@Injectable()
export class FaceJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FaceJobWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly faceDetectionService: FaceDetectionService,
  ) {}

  onModuleInit(): void {
    if (process.env['FACE_WORKER_ENABLED'] === 'false') {
      this.logger.log('FaceJobWorker disabled via FACE_WORKER_ENABLED=false');
      return;
    }

    const pollMs = parseInt(process.env['FACE_JOB_POLL_MS'] ?? '5000', 10);
    this.logger.log(`FaceJobWorker starting; poll interval: ${pollMs}ms`);

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('FaceJobWorker stopped');
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('FaceJobWorker tick skipped — previous tick still running');
      return;
    }

    this.running = true;
    try {
      const concurrency = parseInt(process.env['FACE_WORKER_CONCURRENCY'] ?? '1', 10);
      await this.processBatch(concurrency);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`FaceJobWorker tick error: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async processBatch(concurrency: number): Promise<void> {
    // Atomically claim up to `concurrency` pending jobs
    const jobs: FaceJob[] = [];

    for (let i = 0; i < concurrency; i++) {
      const job = await this.claimNextJob();
      if (!job) break;
      jobs.push(job);
    }

    if (jobs.length === 0) return;

    this.logger.debug(`FaceJobWorker claimed ${jobs.length} job(s)`);
    await Promise.all(jobs.map((job) => this.processJob(job)));
  }

  private async claimNextJob(): Promise<FaceJob | null> {
    // Atomic claim: find + update in one transaction
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.faceJob.findFirst({
        where: { status: FaceJobStatus.pending },
        orderBy: { createdAt: 'asc' },
      });

      if (!job) return null;

      return tx.faceJob.update({
        where: { id: job.id },
        data: {
          status: FaceJobStatus.running,
          startedAt: new Date(),
        },
      });
    });
  }

  private async processJob(job: FaceJob): Promise<void> {
    try {
      await this.faceDetectionService.processMediaItem(job);

      await this.prisma.faceJob.update({
        where: { id: job.id },
        data: {
          status: FaceJobStatus.succeeded,
          finishedAt: new Date(),
        },
      });

      this.logger.log(`FaceJob ${job.id} succeeded for MediaItem ${job.mediaItemId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`FaceJob ${job.id} failed: ${message}`);

      const newAttempts = job.attempts + 1;
      const shouldRetry = newAttempts < MAX_ATTEMPTS;

      await this.prisma.faceJob.update({
        where: { id: job.id },
        data: {
          status: shouldRetry ? FaceJobStatus.pending : FaceJobStatus.failed,
          attempts: newAttempts,
          lastError: message,
          ...(shouldRetry ? {} : { finishedAt: new Date() }),
        },
      });

      this.logger.warn(
        `FaceJob ${job.id}: attempt ${newAttempts}/${MAX_ATTEMPTS}; ` +
          (shouldRetry ? 'will retry' : 'marked failed'),
      );
    }
  }
}

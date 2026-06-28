import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentJob, JobStatus } from '@prisma/client';
import { RateLimitError, classifyRateLimit } from './rate-limit.error';
import { computeQueueBackoffMs } from './backoff.util';
import { ProviderThrottleService } from './provider-throttle.service';

// ---------------------------------------------------------------------------
// Config helpers — read from env at startup (same pattern as existing worker)
// ---------------------------------------------------------------------------

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// Normal-failure retry config
const MAX_ATTEMPTS = getEnvInt('ENRICHMENT_MAX_ATTEMPTS', 3);
const RETRY_BASE_MS = getEnvInt('ENRICHMENT_RETRY_BASE_MS', 2_000);
const RETRY_MAX_MS = getEnvInt('ENRICHMENT_RETRY_MAX_MS', 60_000);

// Rate-limit deferral config
const RL_BASE_MS = getEnvInt('ENRICHMENT_RATELIMIT_BASE_MS', 30_000);
const RL_MAX_MS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_MS', 900_000);
const RL_MAX_HITS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_HITS', 10);

@Injectable()
export class EnrichmentJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnrichmentJobWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
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
    // Atomic claim: find + update in one transaction.
    // Skip jobs that are backed off (scheduledFor is in the future).
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const job = await tx.enrichmentJob.findFirst({
        where: {
          status: JobStatus.pending,
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });

      if (!job) return null;

      return tx.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.running,
          startedAt: new Date(),
          scheduledFor: null,
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

    // Resolve a coarse provider key for the shared throttle gate.
    // null = job type does not need provider-level throttling.
    const throttleKey = ProviderThrottleService.resolveKey(job.type);

    try {
      // Wait out any active cooldown window before hitting the remote API.
      // No-op (zero cost) when the gate is idle or key is null.
      if (throttleKey) {
        await this.throttle.acquire(throttleKey);
      }

      await handler.process(job);

      // Successful call — decay the exponential ramp toward baseline.
      if (throttleKey) {
        this.throttle.recordSuccess(throttleKey);
      }

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

      // Classify: did this handler throw (or cause) a rate-limit error?
      const rl = error instanceof RateLimitError ? error : classifyRateLimit(error);

      if (rl) {
        // ── Rate-limit deferral path ──────────────────────────────────────
        // Also trip the shared throttle gate so sibling jobs back off together.
        if (throttleKey) {
          this.throttle.trip(throttleKey, rl.retryAfterMs ?? null);
        }

        const hits = job.rateLimitHits + 1;
        const delayMs = computeQueueBackoffMs(hits, {
          baseMs: RL_BASE_MS,
          maxMs: RL_MAX_MS,
          retryAfterMs: rl.retryAfterMs ?? null,
        });
        const giveUp = hits >= RL_MAX_HITS;

        await this.prisma.enrichmentJob.update({
          where: { id: job.id },
          data: {
            status: giveUp ? JobStatus.failed : JobStatus.pending,
            rateLimitHits: hits,
            rateLimitedAt: new Date(),
            scheduledFor: giveUp ? null : new Date(Date.now() + delayMs),
            lastError: rl.message,
            // attempts is NOT incremented for rate-limit deferrals
            ...(giveUp ? { finishedAt: new Date() } : {}),
          },
        });

        this.logger.warn(
          `EnrichmentJob ${job.id} (type="${job.type}"): rate-limited by ${rl.providerKey ?? 'provider'} ` +
            `(hit ${hits}/${RL_MAX_HITS}); ` +
            (giveUp
              ? 'giving up — marked failed'
              : `backing off ${Math.round(delayMs / 1000)}s (scheduledFor +${Math.round(delayMs / 1000)}s)`),
        );
      } else {
        // ── Normal failure / exponential retry path ───────────────────────
        const newAttempts = job.attempts + 1;
        const shouldRetry = newAttempts < MAX_ATTEMPTS;
        const delayMs = computeQueueBackoffMs(newAttempts, {
          baseMs: RETRY_BASE_MS,
          maxMs: RETRY_MAX_MS,
        });

        await this.prisma.enrichmentJob.update({
          where: { id: job.id },
          data: {
            status: shouldRetry ? JobStatus.pending : JobStatus.failed,
            attempts: newAttempts,
            lastError: message,
            scheduledFor: shouldRetry ? new Date(Date.now() + delayMs) : null,
            ...(!shouldRetry ? { finishedAt: new Date() } : {}),
          },
        });

        this.logger.warn(
          `EnrichmentJob ${job.id} (type="${job.type}"): attempt ${newAttempts}/${MAX_ATTEMPTS} failed — ` +
            (shouldRetry
              ? `will retry in ${Math.round(delayMs / 1000)}s`
              : 'marked failed'),
        );
      }

      // Always log the underlying error for debugging
      this.logger.error(`EnrichmentJob ${job.id}: ${message}`);
    }
  }
}

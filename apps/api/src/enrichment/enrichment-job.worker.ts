import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentClaimService } from './enrichment-claim.service';
import { EnrichmentJob, JobStatus, Prisma } from '@prisma/client';
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

/**
 * Whether the shared enrichment worker is enabled, per env-var kill-switches.
 * Checks both the current `ENRICHMENT_WORKER_ENABLED` var and the legacy
 * `FACE_WORKER_ENABLED` alias for backwards compatibility — either one set to
 * 'false' disables the worker.
 *
 * Extracted as a pure function (rather than inlined in the lifecycle hook) so
 * other consumers — e.g. DoctorService's diagnostics sweep — can check the
 * same enabled/disabled state without duplicating the boolean logic.
 */
export function isEnrichmentWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enrichmentEnabled = env['ENRICHMENT_WORKER_ENABLED'];
  const faceEnabled = env['FACE_WORKER_ENABLED'];
  return !(enrichmentEnabled === 'false' || faceEnabled === 'false');
}

// Normal-failure retry config.
// ENRICHMENT_MAX_ATTEMPTS is exported so other queue components (e.g. the
// admin stuck-reset path, which must fail — not requeue — jobs whose attempts
// budget is exhausted) share the exact same budget as the worker.
export const ENRICHMENT_MAX_ATTEMPTS = getEnvInt('ENRICHMENT_MAX_ATTEMPTS', 3);
const MAX_ATTEMPTS = ENRICHMENT_MAX_ATTEMPTS;
const RETRY_BASE_MS = getEnvInt('ENRICHMENT_RETRY_BASE_MS', 2_000);
const RETRY_MAX_MS = getEnvInt('ENRICHMENT_RETRY_MAX_MS', 60_000);

// Rate-limit deferral config
const RL_BASE_MS = getEnvInt('ENRICHMENT_RATELIMIT_BASE_MS', 30_000);
const RL_MAX_MS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_MS', 900_000);
const RL_MAX_HITS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_HITS', 10);

// Active per-job execution timeout. A handler that runs longer than this is
// aborted (its worker slot freed) and routed through the normal-failure retry
// path. 0 disables the timeout. Must exceed the longest LEGITIMATE single-job
// runtime (e.g. long video face detection) to avoid killing valid work.
const JOB_TIMEOUT_MS = getEnvInt('ENRICHMENT_JOB_TIMEOUT_MS', 600_000); // 10 min

// Per-type override for the video job types, which legitimately run far longer
// than the global default on low-compute hosts (download + ffmpeg + per-frame
// provider calls on multi-GB videos). 0 disables the timeout for these types.
const VIDEO_JOB_TIMEOUT_MS = getEnvInt('ENRICHMENT_VIDEO_JOB_TIMEOUT_MS', 1_200_000); // 20 min

// Lease duration (ms) stamped on a job at claim time. A running job whose lease
// expires is considered stuck and reaped by the lease-based reaper
// (EnrichmentAdminService.resetStuck). The server worker "renews" implicitly by
// finishing fast; long-running jobs rely on this lease being comfortably above
// the longest legitimate single-job runtime, so the default is set well above
// the video job timeout (ENRICHMENT_VIDEO_JOB_TIMEOUT_MS default 1_200_000).
const LEASE_MS = getEnvInt('ENRICHMENT_LEASE_MS', 1_800_000); // 30 min

/** Job types governed by the video timeout override. */
const VIDEO_JOB_TYPES = new Set(['video_face_detection', 'social_media_detection']);

/** Resolve the effective execution timeout (ms) for a job type. */
function timeoutMsForType(type: string): number {
  return VIDEO_JOB_TYPES.has(type) ? VIDEO_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS;
}

@Injectable()
export class EnrichmentJobWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EnrichmentJobWorker.name);

  // Continuous worker-pool state.
  private shuttingDown = false;
  private loops: Promise<void>[] = [];
  private pollMs = 5000;
  // Outstanding empty-queue sleep timers, tracked so onModuleDestroy can abort
  // them promptly for a fast shutdown.
  private readonly sleepTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EnrichmentHandlerRegistry,
    private readonly throttle: ProviderThrottleService,
    private readonly claimService: EnrichmentClaimService,
  ) {}

  /**
   * Started from OnApplicationBootstrap — NOT OnModuleInit — deliberately.
   * OnApplicationBootstrap is guaranteed to fire only after every module's
   * OnModuleInit (across the whole app, not just this module's DI subtree) has
   * resolved. Enrichment handlers self-register via their own module's
   * OnModuleInit (see docs/specs/enrichment-queue.md Section 6); starting the
   * pool from OnModuleInit raced against that registration in production —
   * during a slow boot (e.g. the offline reverse-geocoder's GeoNames dataset
   * load blocking the event loop for several seconds) the worker successfully
   * claimed real jobs whose handlers weren't registered yet, and those jobs
   * were marked permanently `failed` with "no handler registered" (no retry).
   * OnApplicationBootstrap closes that race structurally.
   */
  onApplicationBootstrap(): void {
    // Check both new and legacy env vars for backwards compatibility
    if (!isEnrichmentWorkerEnabled()) {
      this.logger.log('EnrichmentJobWorker disabled via env var');
      return;
    }

    this.pollMs = parseInt(
      process.env['ENRICHMENT_JOB_POLL_MS'] ?? process.env['FACE_JOB_POLL_MS'] ?? '5000',
      10,
    );
    // Pool size is fixed at startup — unlike the old per-tick concurrency read,
    // the number of loops cannot change without a restart. This is intentional:
    // each loop is a long-lived claim→process→repeat cycle.
    const concurrency = Math.max(
      1,
      parseInt(
        process.env['ENRICHMENT_WORKER_CONCURRENCY'] ?? process.env['FACE_WORKER_CONCURRENCY'] ?? '1',
        10,
      ) || 1,
    );
    this.shuttingDown = false;
    this.logger.log(
      `EnrichmentJobWorker starting; pool size ${concurrency}, poll interval ${this.pollMs}ms`,
    );
    // Fire off N long-lived loops. We deliberately do NOT await them — they run
    // for the lifetime of the worker.
    this.loops = Array.from({ length: concurrency }, (_, i) => this.runLoop(i));
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const t of this.sleepTimers) clearTimeout(t);
    this.sleepTimers.clear();
    this.logger.log('EnrichmentJobWorker stopping');
  }

  /**
   * One long-lived worker-pool loop: claim a job → process it → repeat; sleep
   * `pollMs` whenever the queue is empty. There is no batch barrier — a slow or
   * hung job (bounded by the active per-job timeout) only stalls its own slot,
   * never the other loops or the queue as a whole.
   */
  private async runLoop(slot: number): Promise<void> {
    while (!this.shuttingDown) {
      let processed = false;
      try {
        processed = await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`EnrichmentJobWorker loop ${slot} error: ${msg}`);
      }
      if (!processed && !this.shuttingDown) {
        await this.sleep(this.pollMs);
      }
    }
  }

  /**
   * Claim and process ONE job. Returns true if a job was processed, false if the
   * queue was empty. The continuous worker loops call this; unit tests drive it
   * directly. Claiming goes through the shared, DB-atomic EnrichmentClaimService
   * (UPDATE ... FOR UPDATE SKIP LOCKED), which is multi-process safe: no two
   * loops — or a server worker and a remote node — ever claim the same row, so
   * the old in-process claim mutex is no longer needed. Processing runs after
   * the claim commits.
   */
  async tick(): Promise<boolean> {
    const job = await this.claimNextJob();
    if (!job) return false;
    await this.processJob(job);
    return true;
  }

  /**
   * Abortable sleep. The timer is tracked in `sleepTimers` so onModuleDestroy
   * can clear it for a prompt shutdown, and unref'd so it never keeps the
   * process alive on its own.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.sleepTimers.delete(t);
        resolve();
      }, ms);
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref();
      }
      this.sleepTimers.add(t);
    });
  }

  private async claimNextJob(): Promise<EnrichmentJob | null> {
    // Multi-process-safe atomic claim via the shared claim service:
    // UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED). The server
    // in-process worker claims with nodeId=null / executor='server' over every
    // registered handler type, one job at a time. `attempts` is charged at
    // CLAIM time inside the SQL (attempts + 1) — preserving the semantic that a
    // job which takes the whole process down (OOM SIGKILL) before the in-process
    // failure path still consumes its attempt, so the stuck/lease reaper can
    // permanently fail it once the budget is exhausted instead of requeueing it
    // into an infinite crash loop. `attempts` therefore means "attempts
    // STARTED", not "attempts failed".
    const claimed = await this.claimService.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: this.registry.types(),
      limit: 1,
      leaseMs: LEASE_MS,
    });
    return claimed[0] ?? null;
  }

  /**
   * Race a job's work against a timeout. If the timeout wins, rejects with a
   * timeout Error (which the caller's catch routes through the normal-failure
   * retry path). The underlying work promise is left to settle in the background
   * — JS cannot force-cancel it — but the worker slot is freed immediately so the
   * queue keeps moving. Promise.race attaches reactions to `work`, so a late
   * rejection does not surface as an unhandledRejection.
   */
  private withTimeout<T>(work: Promise<T>, ms: number, job: EnrichmentJob): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`enrichment job execution timed out after ${ms}ms (type="${job.type}")`));
      }, ms);
      // Don't let this timer keep the process alive on its own.
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  /**
   * Write a job's terminal/requeue state with one retry. If the status update
   * throws (e.g. a transient DB error), the row would otherwise be orphaned in
   * `running` forever — retry once after a short delay; if that also fails, log
   * and swallow so the worker slot is freed (the stuck-reset cron recovers the
   * row via the settings-driven threshold).
   */
  private async safeTerminalUpdate(
    jobId: string,
    jobType: string,
    data: Prisma.EnrichmentJobUpdateInput,
  ): Promise<void> {
    try {
      await this.prisma.enrichmentJob.update({ where: { id: jobId }, data });
    } catch (firstErr) {
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      this.logger.warn(
        `EnrichmentJob ${jobId} (type="${jobType}"): status update failed (${firstMsg}); retrying once`,
      );
      await this.sleep(1_000);
      try {
        await this.prisma.enrichmentJob.update({ where: { id: jobId }, data });
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        this.logger.error(
          `EnrichmentJob ${jobId} (type="${jobType}"): status update failed after retry (${retryMsg}); ` +
            'leaving row in running — the stuck-reset cron will recover it',
        );
      }
    }
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
          // Release the claim/lease on this terminal failure.
          claimedByNode: { disconnect: true },
          leaseExpiresAt: null,
          executor: null,
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

      const timeoutMs = timeoutMsForType(job.type);
      if (timeoutMs > 0) {
        await this.withTimeout(handler.process(job), timeoutMs, job);
      } else {
        await handler.process(job);
      }

      // Successful call — decay the exponential ramp toward baseline.
      if (throttleKey) {
        this.throttle.recordSuccess(throttleKey);
      }

      await this.safeTerminalUpdate(job.id, job.type, {
        status: JobStatus.succeeded,
        finishedAt: new Date(),
        // Release the claim/lease so the terminal row is unowned.
        claimedByNode: { disconnect: true },
        leaseExpiresAt: null,
        executor: null,
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

        await this.safeTerminalUpdate(job.id, job.type, {
          status: giveUp ? JobStatus.failed : JobStatus.pending,
          rateLimitHits: hits,
          rateLimitedAt: new Date(),
          scheduledFor: giveUp ? null : new Date(Date.now() + delayMs),
          lastError: rl.message,
          // attempts is NOT charged for rate-limit deferrals: un-charge the
          // claim-time increment (absolute write, so a safeTerminalUpdate retry
          // after a lost-ack first write can never double-decrement).
          attempts: job.attempts - 1,
          // Release the claim/lease so a requeued (or failed) job is unowned.
          claimedByNode: { disconnect: true },
          leaseExpiresAt: null,
          executor: null,
          ...(giveUp ? { finishedAt: new Date() } : {}),
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
        // The claimed row already carries the claim-time charge, so
        // job.attempts IS the number of attempts consumed including this one.
        const shouldRetry = job.attempts < MAX_ATTEMPTS;
        const delayMs = computeQueueBackoffMs(job.attempts, {
          baseMs: RETRY_BASE_MS,
          maxMs: RETRY_MAX_MS,
        });

        await this.safeTerminalUpdate(job.id, job.type, {
          status: shouldRetry ? JobStatus.pending : JobStatus.failed,
          lastError: message,
          scheduledFor: shouldRetry ? new Date(Date.now() + delayMs) : null,
          // Release the claim/lease so a requeued (or failed) job is unowned.
          claimedByNode: { disconnect: true },
          leaseExpiresAt: null,
          executor: null,
          ...(!shouldRetry ? { finishedAt: new Date() } : {}),
        });

        this.logger.warn(
          `EnrichmentJob ${job.id} (type="${job.type}"): attempt ${job.attempts}/${MAX_ATTEMPTS} failed — ` +
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

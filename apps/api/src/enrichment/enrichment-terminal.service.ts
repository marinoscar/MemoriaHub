// =============================================================================
// EnrichmentTerminalService — shared terminal-state writer for enrichment jobs
// =============================================================================
//
// Extracted (behavior-preserving) from EnrichmentJobWorker.processJob so that
// BOTH executors share the exact same terminal semantics:
//
//   - the in-process server worker (EnrichmentJobWorker), and
//   - distributed worker nodes reporting results/failures via
//     POST /api/nodes/:id/jobs/:jobId/result | /failure.
//
// Success: decay the provider-throttle ramp, then write succeeded + release the
// claim/lease. Failure: classify rate-limit vs normal error and route through
// the SAME deferral/exponential-retry state machine the server worker has
// always used — including tripping the shared ProviderThrottleService gate on
// a rate-limit, so a node-reported 429 backs off sibling server jobs too.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, JobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitError, classifyRateLimit } from './rate-limit.error';
import { computeQueueBackoffMs } from './backoff.util';
import { ProviderThrottleService } from './provider-throttle.service';

// ---------------------------------------------------------------------------
// Config helpers — read from env at startup (same pattern as the worker)
// ---------------------------------------------------------------------------

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// Normal-failure retry config.
// ENRICHMENT_MAX_ATTEMPTS is exported (and re-exported from the worker file for
// existing consumers) so other queue components (e.g. the admin stuck-reset
// path, which must fail — not requeue — jobs whose attempts budget is
// exhausted) share the exact same budget as the terminal writer.
export const ENRICHMENT_MAX_ATTEMPTS = getEnvInt('ENRICHMENT_MAX_ATTEMPTS', 3);
const MAX_ATTEMPTS = ENRICHMENT_MAX_ATTEMPTS;
const RETRY_BASE_MS = getEnvInt('ENRICHMENT_RETRY_BASE_MS', 2_000);
const RETRY_MAX_MS = getEnvInt('ENRICHMENT_RETRY_MAX_MS', 60_000);

// Rate-limit deferral config
const RL_BASE_MS = getEnvInt('ENRICHMENT_RATELIMIT_BASE_MS', 30_000);
const RL_MAX_MS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_MS', 900_000);
const RL_MAX_HITS = getEnvInt('ENRICHMENT_RATELIMIT_MAX_HITS', 10);

/** Optional overrides for node-reported failures (the node cannot throw a
 *  RateLimitError instance over the wire, so it reports the classification). */
export interface CompleteFailedOptions {
  rateLimited?: boolean;
  retryAfterMs?: number | null;
}

@Injectable()
export class EnrichmentTerminalService {
  private readonly logger = new Logger(EnrichmentTerminalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  // -------------------------------------------------------------------------
  // completeSucceeded
  // -------------------------------------------------------------------------

  /**
   * Terminal success: decay the shared provider-throttle ramp (when the job
   * type has a throttle key) and write succeeded + release the claim/lease.
   */
  async completeSucceeded(job: EnrichmentJob): Promise<void> {
    const throttleKey = ProviderThrottleService.resolveKey(job.type);

    // Successful call — decay the exponential ramp toward baseline.
    if (throttleKey) {
      this.throttle.recordSuccess(throttleKey);
    }

    await this.safeTerminalUpdate(job.id, job.type, {
      status: JobStatus.succeeded,
      finishedAt: new Date(),
      // Release the claim/lease so the terminal row is unowned. `executor` is
      // intentionally NOT nulled here — succeeded is always terminal, so the
      // audit value of which side (server/node) ran the job must be preserved.
      claimedByNode: { disconnect: true },
      leaseExpiresAt: null,
    });

    this.logger.log(
      `EnrichmentJob ${job.id} (type="${job.type}") succeeded for MediaItem ${job.mediaItemId ?? 'global'}`,
    );
  }

  // -------------------------------------------------------------------------
  // completeFailed
  // -------------------------------------------------------------------------

  /**
   * Terminal failure: EXACTLY the worker's historical catch-block behavior.
   *
   * Classification order:
   *  1. A thrown RateLimitError instance, or anything classifyRateLimit
   *     recognizes (HTTP 429/529 shapes, AWS throttle names) → rate-limit
   *     deferral path.
   *  2. Otherwise, when `opts.rateLimited` is set (node-reported failures,
   *     where the classification arrives as a flag rather than an error
   *     instance) → rate-limit deferral path with the node-supplied
   *     retryAfterMs.
   *  3. Everything else → normal exponential-retry path.
   *
   * Rate-limit deferrals also trip the shared throttle gate so sibling jobs
   * of the same provider back off together — including when the report comes
   * from a remote node.
   */
  async completeFailed(
    job: EnrichmentJob,
    error: unknown,
    opts?: CompleteFailedOptions,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    // Classify: did this handler throw (or cause) a rate-limit error?
    let rl = error instanceof RateLimitError ? error : classifyRateLimit(error);
    if (!rl && opts?.rateLimited) {
      rl = new RateLimitError(message, opts.retryAfterMs ?? undefined);
    }

    // Resolve a coarse provider key for the shared throttle gate.
    // null = job type does not need provider-level throttling.
    const throttleKey = ProviderThrottleService.resolveKey(job.type);

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
        // `executor` is only cleared when the job is being released back to
        // pending for a fresh, unowned claim. A given-up (terminal) failure
        // must preserve the audit value of which side ran the job.
        ...(giveUp ? {} : { executor: null }),
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
        // `executor` is only cleared when the job is being released back to
        // pending for a fresh, unowned claim. A given-up (terminal) failure
        // must preserve the audit value of which side ran the job.
        ...(shouldRetry ? { executor: null } : {}),
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

  // -------------------------------------------------------------------------
  // safeTerminalUpdate
  // -------------------------------------------------------------------------

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

  /** Unref'd sleep so the retry delay never keeps the process alive on its own. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref();
      }
    });
  }
}

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentClaimService } from './enrichment-claim.service';
import { EnrichmentTerminalService } from './enrichment-terminal.service';
import { EnrichmentJob, JobStatus } from '@prisma/client';
import { ProviderThrottleService } from './provider-throttle.service';

// The terminal state machine (succeeded / rate-limit deferral / exponential
// retry) lives in EnrichmentTerminalService so node-reported results share it.
// ENRICHMENT_MAX_ATTEMPTS is re-exported here for existing consumers.
export { ENRICHMENT_MAX_ATTEMPTS } from './enrichment-terminal.service';

// ---------------------------------------------------------------------------
// Config helpers — read from env at startup (same pattern as existing worker)
// ---------------------------------------------------------------------------

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// ---------------------------------------------------------------------------
// Worker mode (ENRICHMENT_WORKER_MODE=all|system|off)
// ---------------------------------------------------------------------------

export type EnrichmentWorkerMode = 'all' | 'system' | 'off';

const WORKER_MODES: readonly EnrichmentWorkerMode[] = ['all', 'system', 'off'];

const modeLogger = new Logger('EnrichmentWorkerMode');
// Warn-once latch for an unrecognized ENRICHMENT_WORKER_MODE value — the mode
// is re-resolved on every claim, so without the latch a typo would spam a warn
// line every few seconds.
let warnedInvalidWorkerMode = false;

/**
 * Resolve the in-process enrichment worker's operating mode.
 *
 * - `'all'`    — claim every registered handler type (classic single-box posture).
 * - `'system'` — claim ONLY server-only job types (light, DB-bound global jobs);
 *                all media compute is left for external worker nodes. The
 *                recommended posture when a distributed node fleet is running.
 * - `'off'`    — do not start the worker pool at all.
 *
 * An explicit `ENRICHMENT_WORKER_MODE` value wins; an unrecognized value warns
 * once and is treated as `'all'` (fail open — jobs must not be silently
 * stranded by a typo). When the mode var is unset, the legacy boolean
 * kill-switches decide: `ENRICHMENT_WORKER_ENABLED=false` or the older
 * `FACE_WORKER_ENABLED=false` alias → `'off'`, otherwise `'all'`.
 */
export function resolveWorkerMode(env: NodeJS.ProcessEnv = process.env): EnrichmentWorkerMode {
  const raw = env['ENRICHMENT_WORKER_MODE'];
  if (raw !== undefined && raw !== '') {
    if ((WORKER_MODES as readonly string[]).includes(raw)) {
      return raw as EnrichmentWorkerMode;
    }
    if (!warnedInvalidWorkerMode) {
      warnedInvalidWorkerMode = true;
      modeLogger.warn(
        `Unknown ENRICHMENT_WORKER_MODE "${raw}" — expected one of ${WORKER_MODES.join('|')}; treating as 'all'`,
      );
    }
    return 'all';
  }
  // Legacy fallback: the on/off boolean switches predate the mode var.
  return env['ENRICHMENT_WORKER_ENABLED'] === 'false' || env['FACE_WORKER_ENABLED'] === 'false'
    ? 'off'
    : 'all';
}

/**
 * Whether the shared enrichment worker runs at all (mode `'all'` or `'system'`).
 *
 * Kept exported for back-compat with earlier consumers of the boolean
 * kill-switch semantics; now a thin wrapper over {@link resolveWorkerMode}.
 * Extracted as a pure function (rather than inlined in the lifecycle hook) so
 * other consumers can check the same enabled/disabled state without
 * duplicating the logic.
 */
export function isEnrichmentWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveWorkerMode(env) !== 'off';
}

/**
 * The claim-eligibility set for `'system'` mode: every server-only type
 * (handlers WITHOUT the nodeResultSchema/persistNodeResult pair — they can
 * only ever run in-process, see EnrichmentHandlerRegistry.serverOnlyTypes)
 * PLUS `'thumbnail_repair'`, added explicitly because its handler DOES carry a
 * nodeResultSchema (interface parity with `thumbnail_regen`) but the job is a
 * global sweep (`mediaItemId: null`) that is not end-to-end node-claimable —
 * deriving the set purely from the schema pair would strand it entirely.
 *
 * `ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES` (comma-separated) is an operator escape
 * hatch to pin additional types to the server in system mode. Entries that are
 * not registered handler types are dropped with a warning — claiming an
 * unregistered type would permanently fail its jobs with "no handler
 * registered".
 */
export function systemModeEligibleTypes(
  registry: Pick<EnrichmentHandlerRegistry, 'serverOnlyTypes' | 'types'>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const eligible = new Set(registry.serverOnlyTypes());
  eligible.add('thumbnail_repair');

  const registered = new Set(registry.types());
  const extras = (env['ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const extra of extras) {
    if (registered.has(extra)) {
      eligible.add(extra);
    } else {
      modeLogger.warn(
        `ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES entry "${extra}" is not a registered handler type; ignoring`,
      );
    }
  }
  return Array.from(eligible);
}

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
    private readonly terminal: EnrichmentTerminalService,
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
    // ENRICHMENT_WORKER_MODE wins; falls back to the legacy on/off env vars.
    const mode = resolveWorkerMode();
    if (mode === 'off') {
      this.logger.log('EnrichmentJobWorker disabled via env var (mode: off)');
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
      `EnrichmentJobWorker starting (mode: ${mode}); pool size ${concurrency}, poll interval ${this.pollMs}ms`,
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

  /**
   * The job types this worker claims. In `'system'` mode the set is restricted
   * to server-only types (plus `thumbnail_repair` and any operator extras — see
   * systemModeEligibleTypes) so all media compute is left for external worker
   * nodes; in every other mode it is every registered handler type. Resolved
   * per claim (cheap env read) so the mode is honored even when tick() is
   * driven directly, without depending on bootstrap-time state.
   */
  private claimEligibleTypes(): string[] {
    return resolveWorkerMode() === 'system'
      ? systemModeEligibleTypes(this.registry)
      : this.registry.types();
  }

  private async claimNextJob(): Promise<EnrichmentJob | null> {
    // Multi-process-safe atomic claim via the shared claim service:
    // UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED). The server
    // in-process worker claims with nodeId=null / executor='server' over every
    // registered handler type (restricted to the server-only set in 'system'
    // mode — see claimEligibleTypes), one job at a time. `attempts` is charged at
    // CLAIM time inside the SQL (attempts + 1) — preserving the semantic that a
    // job which takes the whole process down (OOM SIGKILL) before the in-process
    // failure path still consumes its attempt, so the stuck/lease reaper can
    // permanently fail it once the budget is exhausted instead of requeueing it
    // into an infinite crash loop. `attempts` therefore means "attempts
    // STARTED", not "attempts failed".
    const claimed = await this.claimService.claim({
      nodeId: null,
      executor: 'server',
      eligibleTypes: this.claimEligibleTypes(),
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

    try {
      // Wait out any active cooldown window before hitting the remote API.
      // No-op (zero cost) when the gate is idle or key is null.
      const throttleKey = ProviderThrottleService.resolveKey(job.type);
      if (throttleKey) {
        await this.throttle.acquire(throttleKey);
      }

      const timeoutMs = timeoutMsForType(job.type);
      if (timeoutMs > 0) {
        await this.withTimeout(handler.process(job), timeoutMs, job);
      } else {
        await handler.process(job);
      }

      // Terminal success (throttle recordSuccess + succeeded write) is shared
      // with node-reported results via EnrichmentTerminalService.
      await this.terminal.completeSucceeded(job);
    } catch (error) {
      // Terminal failure (rate-limit deferral vs exponential retry, including
      // tripping the shared throttle gate) is shared with node-reported
      // failures via EnrichmentTerminalService.
      await this.terminal.completeFailed(job, error);
    }
  }
}

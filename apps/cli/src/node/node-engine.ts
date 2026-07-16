/**
 * node/node-engine.ts — Event-driven worker-node engine.
 *
 * Long-lived loop that claims enrichment jobs from the server, runs the compute
 * locally, and submits results. Modeled on sync/sync-engine.ts: fully UI-free
 * and dependency-injected so it is unit-testable and renderer-agnostic. All
 * observable behaviour is surfaced as typed events (see node-events.ts).
 *
 * Lifecycle:
 *   start()  → initial heartbeat, start heartbeat ticker, run the claim loop.
 *   drain()  → stop claiming, finish in-flight jobs, keep heartbeating as
 *              'draining' — does NOT deregister.
 *   stop()   → set draining, wake the idle sleep, await in-flight jobs,
 *              deregister (skippable via { deregister: false } for headless/
 *              container shutdowns that must re-attach on restart), emit
 *              'stopped'.
 *
 * Observability: getSnapshot() returns a point-in-time EngineSnapshot (active
 * jobs, last-50 history ring, counters, heartbeat age) consumed by `node
 * status` and the daemon IPC socket. setConcurrency() adjusts the cap live,
 * taking effect on the next loop iteration.
 *
 * Claim model: the loop is a continuous top-up pool, NOT a batch-drain barrier.
 * It keeps up to `concurrency` jobs in flight at all times — each iteration
 * claims only as many jobs as there are free slots and dispatches them without
 * waiting for the batch to finish, so a fast job never idles a slot behind a
 * slow one (e.g. a 2s face_detection behind a 40s video_face_detection).
 *
 * Per-job flow:
 *   download inputUrl → start lease-renew ticker → dispatcher.compute →
 *   submit result (or report failure) → cleanup temp file.
 *
 * Rate-limit classification: a compute failure caused by a remote provider
 * throttle (Anthropic 429/529 via auto-tagging, Nominatim/Google 429/5xx via
 * geocode) surfaces as a `ProviderRateLimitError`
 * (@memoriahub/enrichment-compute/rate-limit) — this is the ONE place that
 * detects it (`err instanceof ProviderRateLimitError`) and forwards
 * `{ rateLimited: true, retryAfterMs }` to the server's failure endpoint, so
 * the job backs off through the server's rate-limit deferral path
 * (`EnrichmentTerminalService.completeFailed`) instead of burning through
 * `ENRICHMENT_MAX_ATTEMPTS`. Every other compute module type stays on the
 * existing `{ willRetry: true }` path unchanged.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { NodeTypedEmitter, NODE_EV } from './node-events.js';
import { downloadToFile } from './download.js';
import {
  ComputeDispatcher,
  detectCapabilities,
  type CapabilityStatus,
} from './capabilities.js';
import { ProviderRateLimitError } from '@memoriahub/enrichment-compute/rate-limit';
import type { ApiClient, ClaimedNodeJob } from '../api.js';

export interface NodeEngineOptions {
  /** Simultaneous jobs processed per claimed batch. */
  concurrency: number;
  /** Job types this node advertises when claiming. */
  eligibleTypes: string[];
  /** Sleep (ms) between claim polls when the queue is empty. */
  pollIntervalMs: number;
  /** Heartbeat cadence (ms). Default 20_000. */
  heartbeatIntervalMs?: number;
  /** Lease-renew cadence (ms) per in-flight job. Default 30_000. */
  leaseRenewIntervalMs?: number;
  /** Lease duration (ms) requested on each renew. */
  leaseMs?: number;
  /** Max jobs claimed per poll. Default = concurrency. */
  maxClaim?: number;
  /** Face-detection provider this node runs face jobs on. Surfaced in status. */
  faceProvider?: 'human' | 'compreface';
  /**
   * Base URL of the local compreface-core sidecar (only meaningful when
   * faceProvider === 'compreface'). Passed to the capability probe on every
   * heartbeat so reported capabilities reflect the node's ACTUAL sidecar
   * rather than the localhost default.
   */
  comprefaceUrl?: string;
}

export interface NodeEngineDeps {
  api: ApiClient;
  dispatcher: ComputeDispatcher;
  nodeId: string;
  options: NodeEngineOptions;
  /** Injectable for tests — defaults to the real streaming download. */
  downloadFn?: typeof downloadToFile;
  /** Injectable for tests — defaults to the real capability probe. */
  detectFn?: (opts?: { comprefaceUrl?: string }) => Promise<Record<string, CapabilityStatus>>;
  /** Injectable temp directory (defaults to os.tmpdir()). */
  tmpDir?: () => string;
}

/** One entry of the completed/failed job ring buffer. */
export interface CompletedJobRecord {
  jobId: string;
  type: string;
  status: 'done' | 'error';
  durationMs?: number;
  error?: string;
  finishedAt: string;
}

/** A job currently being processed. */
export interface ActiveJobInfo {
  jobId: string;
  type: string;
  startedAt: string;
}

/** Point-in-time view of the engine, served over the daemon IPC socket. */
export interface EngineSnapshot {
  nodeId: string;
  /** ISO timestamp of start(); null before the engine has started. */
  startedAt: string | null;
  /** Current live concurrency cap (see setConcurrency). */
  concurrency: number;
  eligibleTypes: string[];
  /** Face-detection provider this node runs face jobs on ('human' | 'compreface'). */
  faceProvider: 'human' | 'compreface';
  /** Sidecar URL when faceProvider === 'compreface'; null otherwise. */
  comprefaceUrl: string | null;
  activeJobs: ActiveJobInfo[];
  /** Last 50 completed/failed jobs, oldest first. */
  history: CompletedJobRecord[];
  counters: { succeeded: number; failed: number; claimed: number };
  lastHeartbeatAt: string | null;
  draining: boolean;
}

/** Ring-buffer capacity for the completed-job history. */
const HISTORY_LIMIT = 50;

/**
 * Job types whose compute module reads the downloaded input file (via
 * `fs.readFile(inputPath)` / `sharp(buffer)`). For these, a falsy `inputUrl`
 * from the claim means the server could not presign the source object, so we
 * must NOT invoke compute with an empty path — that surfaces as the opaque
 * `ENOENT: no such file or directory, open ''`. Instead we fail the job with a
 * descriptive error and let the server requeue it (a transient not-ready object
 * will presign on a later claim). Types NOT listed here are input-less
 * (`geocode` reads stored lat/lng; the global `thumbnail_repair` sweep has no
 * media item) and legitimately run with an empty input path.
 */
const INPUT_REQUIRED_TYPES = new Set<string>([
  'face_detection',
  'video_face_detection',
  'duplicate_detection',
  'metadata_extraction',
  'social_media_detection',
  'thumbnail_regen',
  'auto_tagging',
]);

type Resolved = Required<Pick<NodeEngineDeps, 'downloadFn' | 'detectFn' | 'tmpDir'>>;

export class NodeEngine extends NodeTypedEmitter {
  private readonly api: ApiClient;
  private readonly dispatcher: ComputeDispatcher;
  private readonly nodeId: string;
  private readonly opts: NodeEngineOptions;
  private readonly resolved: Resolved;

  private running = false;
  private draining = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Resolver for the current idle sleep so stop() can wake it immediately. */
  private idleResolve: (() => void) | null = null;
  /** Promise for the running claim loop, awaited by stop(). */
  private loopPromise: Promise<void> | null = null;

  /**
   * Live-adjustable concurrency cap. Re-read at every loop iteration to size
   * the top-up: the loop claims only `cap - inFlight.size` jobs per pass, so
   * setConcurrency() takes effect on the next iteration. Lowering it does not
   * cancel already-running jobs — the pool just stops topping up until enough
   * finish to fall back under the new cap.
   */
  private concurrencyCap: number;
  /** ISO timestamp of start() — the uptime anchor for snapshots. */
  private startedAtIso: string | null = null;
  private lastHeartbeatAt: string | null = null;
  /** Last HISTORY_LIMIT completed/failed jobs, oldest first. */
  private readonly history: CompletedJobRecord[] = [];
  private readonly counters = { succeeded: 0, failed: 0, claimed: 0 };
  private readonly activeJobs = new Map<string, ActiveJobInfo>();

  constructor(deps: NodeEngineDeps) {
    super();
    this.api = deps.api;
    this.dispatcher = deps.dispatcher;
    this.nodeId = deps.nodeId;
    this.opts = deps.options;
    this.concurrencyCap = Math.max(1, Math.floor(deps.options.concurrency));
    this.resolved = {
      downloadFn: deps.downloadFn ?? downloadToFile,
      detectFn: deps.detectFn ?? detectCapabilities,
      tmpDir: deps.tmpDir ?? (() => os.tmpdir()),
    };
  }

  /**
   * Adjust the concurrency cap of a running engine. Takes effect on the next
   * loop iteration — already-running jobs are never cancelled; the top-up pool
   * simply claims up to the new cap from then on. The new value is also
   * propagated to the server immediately via a best-effort heartbeat (rather
   * than waiting for the next ~20s tick) so the claim endpoint stops capping
   * at the stale registration value within ~1s.
   */
  setConcurrency(n: number): void {
    this.concurrencyCap = Math.max(1, Math.floor(n));
    // beat() is try/catch-guarded and emits HEARTBEAT_FAIL on error, so this is
    // safe even before the engine has started (heartbeatNode may reject).
    void this.beat();
  }

  /**
   * Stop claiming new jobs but finish everything in flight, WITHOUT
   * deregistering from the server. Heartbeats keep running and report
   * status 'draining'. Call stop() to fully shut down and deregister.
   */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    this.idleResolve?.();
  }

  /** Point-in-time snapshot for status rendering and the IPC socket. */
  getSnapshot(): EngineSnapshot {
    return {
      nodeId: this.nodeId,
      startedAt: this.startedAtIso,
      concurrency: this.concurrencyCap,
      eligibleTypes: [...this.opts.eligibleTypes],
      faceProvider: this.opts.faceProvider ?? 'human',
      comprefaceUrl:
        (this.opts.faceProvider ?? 'human') === 'compreface'
          ? this.opts.comprefaceUrl ?? null
          : null,
      activeJobs: [...this.activeJobs.values()],
      history: [...this.history],
      counters: { ...this.counters },
      lastHeartbeatAt: this.lastHeartbeatAt,
      draining: this.draining,
    };
  }

  /** Start the engine: initial heartbeat + heartbeat ticker + claim loop.
   *  Resolves when the loop ends (after stop()). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.draining = false;
    this.startedAtIso = new Date().toISOString();

    // Initial heartbeat (best-effort) then periodic ticker.
    await this.beat();
    const hbInterval = this.opts.heartbeatIntervalMs ?? 20_000;
    this.heartbeatTimer = setInterval(() => {
      void this.beat();
    }, hbInterval);
    // NOTE: intentionally NOT unref'd — the heartbeat + idle-sleep timers are
    // what keep a long-lived idle worker process alive between polls.

    this.loopPromise = this.loop();
    await this.loopPromise;
  }

  /** Signal the engine to drain and stop: wakes the idle sleep, awaits the loop,
   *  deregisters (unless `opts.deregister` is false — used by headless/container
   *  SIGTERM so the node row persists and the replica re-attaches on restart),
   *  emits 'stopped'. Safe to call more than once. */
  async stop(reason = 'requested', opts?: { deregister?: boolean }): Promise<void> {
    if (!this.running && !this.loopPromise) return;
    this.draining = true;
    // Wake an in-progress idle sleep so the loop exits promptly.
    this.idleResolve?.();

    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Best-effort deregister (skipped when opts.deregister === false so the
    // server-side node row survives a container restart for re-attachment).
    if (opts?.deregister !== false) {
      try {
        await this.api.deregisterNode(this.nodeId);
      } catch {
        /* server may already have expired the node — non-fatal */
      }
    }

    this.running = false;
    this.loopPromise = null;
    this.emit(NODE_EV.STOPPED, { reason });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Continuous top-up claim loop. Keeps up to `concurrencyCap` jobs in flight
   * at all times: each pass claims only as many jobs as there are free slots
   * and dispatches them immediately, never blocking on a whole batch to finish.
   * This keeps fast jobs flowing past slow ones (the batch-drain barrier this
   * replaced collapsed effective concurrency to ~1 on mixed workloads).
   */
  private async loop(): Promise<void> {
    // Tracks the in-flight processJob() promises; each removes itself on finish.
    const inFlight = new Set<Promise<void>>();

    while (!this.draining) {
      // Re-read the mutable cap each iteration so setConcurrency() applies live.
      const cap = this.concurrencyCap;
      const free = cap - inFlight.size;

      if (free <= 0) {
        // All slots busy — wait for any one to free, then re-evaluate.
        await Promise.race(inFlight);
        continue;
      }

      // Claim only up to the number of open slots so the server never
      // over-delivers work this node has no slot to run.
      let claimed: ClaimedNodeJob[] = [];
      try {
        const res = await this.api.claimNodeJobs(this.nodeId, {
          max: free,
          types: this.opts.eligibleTypes,
        });
        claimed = res?.jobs ?? [];
      } catch (err) {
        // Claim failure is transient — surface via heartbeat:fail.
        this.emit(NODE_EV.HEARTBEAT_FAIL, {
          error: `claim failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        claimed = [];
      }

      if (claimed.length > 0) {
        this.counters.claimed += claimed.length;
        this.emit(NODE_EV.CLAIMED, { count: claimed.length });
        for (const claim of claimed) {
          const p = this.processJob(claim).finally(() => {
            inFlight.delete(p);
          });
          inFlight.add(p);
        }
        // Loop immediately to fill any remaining free slots.
        continue;
      }

      // Claim returned empty.
      if (inFlight.size > 0) {
        // Jobs still running: do NOT emit IDLE (the IDLE contract requires an
        // empty in-flight set). Wait for a slot to free OR a short poll delay
        // (so a freed slot re-polls for newly-queued work), then re-evaluate.
        await Promise.race([...inFlight, this.sleep(this.opts.pollIntervalMs)]);
        continue;
      }

      // Truly idle: no work and nothing in flight.
      this.emit(NODE_EV.IDLE, { pollIntervalMs: this.opts.pollIntervalMs });
      await this.sleep(this.opts.pollIntervalMs);
    }

    // Drain: the loop exited because draining was set — finish in-flight jobs
    // before returning so stop() (which awaits loopPromise) waits for them.
    await Promise.allSettled([...inFlight]);
  }

  /** Append to the completed-job ring buffer, evicting the oldest past the cap. */
  private recordHistory(record: CompletedJobRecord): void {
    this.history.push(record);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  private async processJob(claim: ClaimedNodeJob): Promise<void> {
    const { job, inputUrl, params } = claim;
    const jobId = job.id;
    const type = job.type;
    const startMs = Date.now();

    this.activeJobs.set(jobId, { jobId, type, startedAt: new Date().toISOString() });
    this.emit(NODE_EV.JOB_START, {
      jobId,
      type,
      mediaItemId: job.mediaItemId ?? null,
    });

    const tmpPath = path.join(
      this.resolved.tmpDir(),
      `memoriahub-node-${jobId}-${crypto.randomBytes(6).toString('hex')}`,
    );
    let downloaded = false;
    let leaseTimer: NodeJS.Timeout | null = null;

    // Start the lease-renew ticker so the server doesn't reclaim the job.
    const leaseInterval = this.opts.leaseRenewIntervalMs ?? 30_000;
    leaseTimer = setInterval(() => {
      void this.api
        .renewLease(
          this.nodeId,
          jobId,
          this.opts.leaseMs != null ? { leaseMs: this.opts.leaseMs } : {},
        )
        .then(() => this.emit(NODE_EV.LEASE_RENEW, { jobId }))
        .catch(() => {
          /* lease renew failure is non-fatal; server timeout will requeue */
        });
    }, leaseInterval);
    leaseTimer.unref?.();

    try {
      if (inputUrl) {
        await this.resolved.downloadFn(inputUrl, tmpPath);
        downloaded = true;
      } else if (INPUT_REQUIRED_TYPES.has(type)) {
        // Server returned no presigned URL for a job whose compute reads the
        // input file. Fail cleanly instead of calling compute with '' (which
        // would throw the opaque `ENOENT ... open ''`); the server requeues.
        throw new Error(
          `input bytes unavailable for job ${jobId} (${type}): server returned no download URL`,
        );
      }

      const result = await this.dispatcher.compute(type, downloaded ? tmpPath : '', params ?? {}, {
        nodeId: this.nodeId,
        jobId,
      });

      // Submit the typed result envelope; degrade gracefully on submit failure
      // (the server lease reaper will requeue the job for another attempt).
      let submitted = false;
      try {
        await this.api.submitJobResult(this.nodeId, jobId, type, result);
        submitted = true;
      } catch (err) {
        this.emit(NODE_EV.HEARTBEAT_FAIL, {
          error:
            `result submission failed for job ${jobId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const durationMs = Date.now() - startMs;
      this.counters.succeeded += 1;
      this.recordHistory({
        jobId,
        type,
        status: 'done',
        durationMs,
        finishedAt: new Date().toISOString(),
      });
      this.emit(NODE_EV.JOB_DONE, {
        jobId,
        type,
        durationMs,
        submitted,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A provider throttle (Anthropic 429/529, Nominatim/Google 429/5xx)
      // surfaces here as a ProviderRateLimitError regardless of which compute
      // module threw it — forward rateLimited/retryAfterMs so the server
      // defers with backoff instead of charging a normal retry attempt.
      const rateLimit = err instanceof ProviderRateLimitError ? err : null;
      // Report failure so the server can requeue for another worker / the server
      // itself. willRetry=true — the server owns final attempt accounting.
      try {
        await this.api.reportJobFailure(this.nodeId, jobId, {
          error: message,
          willRetry: true,
          ...(rateLimit && {
            rateLimited: true,
            ...(rateLimit.retryAfterMs !== undefined && { retryAfterMs: rateLimit.retryAfterMs }),
          }),
        });
      } catch {
        /* failure report is best-effort — server lease expiry requeues the job */
      }
      this.counters.failed += 1;
      this.recordHistory({
        jobId,
        type,
        status: 'error',
        durationMs: Date.now() - startMs,
        error: message,
        finishedAt: new Date().toISOString(),
      });
      this.emit(NODE_EV.JOB_ERROR, { jobId, type, error: message, willRetry: true });
    } finally {
      this.activeJobs.delete(jobId);
      if (leaseTimer) clearInterval(leaseTimer);
      if (downloaded) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort temp cleanup */
        }
      }
    }
  }

  /** Send one heartbeat with the current capability summary. */
  private async beat(): Promise<void> {
    try {
      const capabilities = await this.resolved.detectFn({
        comprefaceUrl: this.opts.comprefaceUrl,
      });
      await this.api.heartbeatNode(this.nodeId, {
        status: this.draining ? 'draining' : 'online',
        capabilities,
        concurrency: this.concurrencyCap,
      });
      this.lastHeartbeatAt = new Date().toISOString();
      this.emit(NODE_EV.HEARTBEAT_OK, { at: this.lastHeartbeatAt });
    } catch (err) {
      this.emit(NODE_EV.HEARTBEAT_FAIL, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Interruptible sleep — resolves early when stop() wakes it. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleResolve = null;
        resolve();
      }, ms);
      // NOT unref'd — during idle this timer keeps the worker process alive.
      this.idleResolve = () => {
        clearTimeout(timer);
        this.idleResolve = null;
        resolve();
      };
    });
  }
}

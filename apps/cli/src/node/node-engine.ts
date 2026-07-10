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
 *   stop()   → set draining, wake the idle sleep, await in-flight jobs,
 *              deregister, emit 'stopped'.
 *
 * Per-job flow (bounded by `concurrency` via runPool):
 *   download inputUrl → start lease-renew ticker → dispatcher.compute →
 *   submit result (or report failure) → cleanup temp file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { NodeTypedEmitter, NODE_EV } from './node-events.js';
import { runPool } from '../sync/worker-pool.js';
import { downloadToFile } from './download.js';
import {
  ComputeDispatcher,
  detectCapabilities,
  type CapabilityStatus,
} from './capabilities.js';
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
}

export interface NodeEngineDeps {
  api: ApiClient;
  dispatcher: ComputeDispatcher;
  nodeId: string;
  options: NodeEngineOptions;
  /** Injectable for tests — defaults to the real streaming download. */
  downloadFn?: typeof downloadToFile;
  /** Injectable for tests — defaults to the real capability probe. */
  detectFn?: () => Promise<Record<string, CapabilityStatus>>;
  /** Injectable temp directory (defaults to os.tmpdir()). */
  tmpDir?: () => string;
}

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

  constructor(deps: NodeEngineDeps) {
    super();
    this.api = deps.api;
    this.dispatcher = deps.dispatcher;
    this.nodeId = deps.nodeId;
    this.opts = deps.options;
    this.resolved = {
      downloadFn: deps.downloadFn ?? downloadToFile,
      detectFn: deps.detectFn ?? detectCapabilities,
      tmpDir: deps.tmpDir ?? (() => os.tmpdir()),
    };
  }

  /** Start the engine: initial heartbeat + heartbeat ticker + claim loop.
   *  Resolves when the loop ends (after stop()). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.draining = false;

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
   *  deregisters, emits 'stopped'. Safe to call more than once. */
  async stop(reason = 'requested'): Promise<void> {
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

    // Best-effort deregister.
    try {
      await this.api.deregisterNode(this.nodeId);
    } catch {
      /* server may already have expired the node — non-fatal */
    }

    this.running = false;
    this.loopPromise = null;
    this.emit(NODE_EV.STOPPED, { reason });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    const maxClaim = this.opts.maxClaim ?? this.opts.concurrency;

    while (!this.draining) {
      let claimed: ClaimedNodeJob[] = [];
      try {
        const res = await this.api.claimNodeJobs(this.nodeId, {
          max: maxClaim,
          types: this.opts.eligibleTypes,
        });
        claimed = res?.jobs ?? [];
      } catch (err) {
        // Claim failure is transient — surface via heartbeat:fail and idle.
        this.emit(NODE_EV.HEARTBEAT_FAIL, {
          error: `claim failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        claimed = [];
      }

      if (claimed.length === 0) {
        this.emit(NODE_EV.IDLE, { pollIntervalMs: this.opts.pollIntervalMs });
        await this.sleep(this.opts.pollIntervalMs);
        continue;
      }

      this.emit(NODE_EV.CLAIMED, { count: claimed.length });

      await runPool(claimed, this.opts.concurrency, async (claim) => {
        await this.processJob(claim);
      });
    }
  }

  private async processJob(claim: ClaimedNodeJob): Promise<void> {
    const { job, inputUrl, params } = claim;
    const jobId = job.id;
    const type = job.type;
    const startMs = Date.now();

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
      }

      const result = await this.dispatcher.compute(type, downloaded ? tmpPath : '', params ?? {});

      // Submit the result. The endpoint may not exist yet server-side — degrade.
      let submitted = false;
      try {
        await this.api.submitJobResult(this.nodeId, jobId, result);
        submitted = true;
      } catch (err) {
        this.emit(NODE_EV.HEARTBEAT_FAIL, {
          error:
            `result endpoint not yet available for job ${jobId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        });
      }

      this.emit(NODE_EV.JOB_DONE, {
        jobId,
        type,
        durationMs: Date.now() - startMs,
        submitted,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Report failure so the server can requeue for another worker / the server
      // itself. willRetry=true — the server owns final attempt accounting.
      try {
        await this.api.reportJobFailure(this.nodeId, jobId, {
          error: message,
          willRetry: true,
        });
      } catch {
        /* failure endpoint may not exist yet — degrade gracefully */
      }
      this.emit(NODE_EV.JOB_ERROR, { jobId, type, error: message, willRetry: true });
    } finally {
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
      const capabilities = await this.resolved.detectFn();
      await this.api.heartbeatNode(this.nodeId, {
        status: this.draining ? 'draining' : 'online',
        capabilities,
      });
      this.emit(NODE_EV.HEARTBEAT_OK, { at: new Date().toISOString() });
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

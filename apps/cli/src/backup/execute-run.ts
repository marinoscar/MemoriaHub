/**
 * backup/execute-run.ts — The `backup run` invocation seam (issue #316,
 * epic #308).
 *
 * `memoriahub backup run` calls executeRun() with resolved knobs; the engine
 * runs EMBEDDED in the command process for now. Child 5 (#317) reroutes this
 * same seam over the daemon IPC channel without touching the command layer —
 * which is why the function takes plain data in and returns a typed outcome,
 * with the renderer attached via a callback rather than imported here.
 */

import { ApiClient } from '../api.js';
import { CooldownGate, type CooldownGateConfig, DEFAULT_COOLDOWN_CONFIG } from '../http/cooldown-gate.js';
import type { RetryConfig } from '../http/retry.js';
import { openCatalogDb } from './catalog-db.js';
import { BackupEngine, type BackupRunOutcome } from './backup-engine.js';
import { TokenBucket } from './rate-limiter.js';

export interface ExecuteRunOptions {
  serverUrl: string;
  pat: string;
  /** Absolute backup root (from settings backup.root). */
  root: string;
  /** Worker-node id the root is bound to (from settings backup.nodeId). */
  nodeId: string;
  nodeName?: string;
  trigger: 'manual' | 'scheduled';
  cliVersion: string;
  concurrency: number;
  maxMbps: number;
  pageSize: number;
  pacingMs: number;
  retry?: RetryConfig;
  cooldown?: CooldownGateConfig;
  /** Attach a renderer BEFORE the run starts (headless printer, NDJSON, TUI). */
  attachRenderer?: (engine: BackupEngine) => void;
}

/**
 * Open the root's catalog, build the shared HTTP client (retry + cooldown gate
 * wired to the engine's throttle event) and token bucket, run one incremental
 * backup, and close the catalog. Throws RunAlreadyActiveError / CatalogOpenError
 * for the command layer to render; all other failures surface as a 'failed'
 * outcome (the engine finishes the server run best-effort).
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<BackupRunOutcome> {
  // The gate is created before the engine so the ApiClient can share it; the
  // trip hook reaches the engine through this holder.
  let engineRef: BackupEngine | null = null;
  const gate = new CooldownGate(opts.cooldown ?? DEFAULT_COOLDOWN_CONFIG, {
    onTrip: (delayMs) => engineRef?.emitThrottle(delayMs),
  });

  const api = new ApiClient({
    serverUrl: opts.serverUrl,
    pat: opts.pat,
    ...(opts.retry ? { retry: opts.retry } : {}),
    cooldownGate: gate,
  });

  const db = openCatalogDb(opts.root);
  try {
    const engine = new BackupEngine(
      {
        root: opts.root,
        nodeId: opts.nodeId,
        ...(opts.nodeName !== undefined ? { nodeName: opts.nodeName } : {}),
        serverUrl: opts.serverUrl,
        trigger: opts.trigger,
        cliVersion: opts.cliVersion,
        concurrency: opts.concurrency,
        maxMbps: opts.maxMbps,
        pageSize: opts.pageSize,
        pacingMs: opts.pacingMs,
      },
      { api, db, bucket: new TokenBucket(opts.maxMbps) },
    );
    engineRef = engine;
    opts.attachRenderer?.(engine);
    return await engine.runBackup();
  } finally {
    db.close();
  }
}

/**
 * Exit-code policy for `backup run`:
 *   - a failed run is always non-zero;
 *   - `--strict` additionally fails the process when ANY item errored,
 *     even on an otherwise-completed run;
 *   - an aborted (user-cancelled) run exits zero unless strict + errors.
 */
export function resolveBackupExitCode(outcome: BackupRunOutcome, strict: boolean): number {
  if (outcome.status === 'failed') return 1;
  if (strict && outcome.stats.errors > 0) return 1;
  return 0;
}

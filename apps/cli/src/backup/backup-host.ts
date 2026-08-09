/**
 * backup/backup-host.ts — Daemon-side owner of the backup engine (issue #318,
 * epic #308).
 *
 * When the central settings KV has a backup root bound (backup.root +
 * backup.nodeId), `node start` constructs a BackupHost NEXT TO the enrichment
 * NodeEngine and hands it to the daemon host (node/daemon.ts), which exposes
 * it over the IPC socket (backup-status / backup-run-now / backup-cancel /
 * backup-set-rate) and re-broadcasts engine events as
 * `{ kind: 'backup-event', ev, payload, ts }` frames.
 *
 * Isolation contract — backup and enrichment share ONLY the process:
 *   - Independent concurrency: the backup download pool is sized by the
 *     backup.concurrency setting, entirely separate from the NodeEngine's
 *     enrichment worker slots.
 *   - Independent HTTP braking: the CooldownGate is per-ApiClient, so the
 *     BackupHost builds its OWN ApiClient. An enrichment provider cooldown
 *     (429 from an AI provider, say) must never brake backup downloads, and a
 *     storage 503 hitting backup must never brake enrichment claims.
 *
 * Responsibilities:
 *   - Own AT MOST ONE BackupEngine run at a time — a second trigger while a
 *     run is active is rejected with BackupBusyError ('busy').
 *   - Re-emit every engine event as a single 'backup-event' host event that
 *     the daemon broadcasts over IPC.
 *   - Run the pull-based scheduler poll (backup-scheduler.ts) that fires
 *     trigger='scheduled' runs when the server-computed nextRunAt is due.
 *   - Apply set-rate changes LIVE: the engine re-reads its opts.concurrency
 *     per page (worker pool size) and the shared TokenBucket re-reads its
 *     rate per take(), so the host mutates the ACTIVE run's opts holder and
 *     bucket in place — the next page/chunk uses the new values — while also
 *     persisting to the settings KV for future runs.
 */

import { EventEmitter } from 'node:events';
import type BetterSqlite3 from 'better-sqlite3';
import { ApiClient } from '../api.js';
import {
  CooldownGate,
  DEFAULT_COOLDOWN_CONFIG,
  type CooldownGateConfig,
} from '../http/cooldown-gate.js';
import type { RetryConfig } from '../http/retry.js';
import type { NodeLogger } from '../node/logger.js';
import type { SettingsRepo } from '../repo/settings.js';
import { openCatalogDb } from './catalog-db.js';
import { CatalogRepo, type CatalogRun, type CatalogStats } from './catalog-repo.js';
import {
  BackupEngine,
  CHECKPOINT_CURSOR_KEY,
  type BackupApi,
  type BackupEngineOpts,
  type BackupRunOutcome,
} from './backup-engine.js';
import {
  BACKUP_EV,
  BACKUP_HOST_EVENT,
  BackupTypedEmitter,
  type BackupCursor,
  type BackupHostEventFrame,
} from './events.js';
import { TokenBucket } from './rate-limiter.js';
import {
  BackupScheduler,
  type BackupSchedulerApi,
  type BackupSchedulerOpts,
} from './backup-scheduler.js';

// Re-exported for existing consumers; the canonical definition lives in
// events.ts so daemon.ts can subscribe without importing this module's
// runtime graph (see the note there).
export { BACKUP_HOST_EVENT } from './events.js';
export type { BackupHostEventFrame } from './events.js';

/** Thrown by startRun() when a run is already active (serialized host). */
export class BackupBusyError extends Error {
  readonly code = 'busy';
  constructor() {
    super('a backup run is already active on this daemon');
    this.name = 'BackupBusyError';
  }
}

/** What the host needs from an engine: typed events + cooperative controls. */
export type AttachableBackupEngine = BackupTypedEmitter & {
  cancel(): void;
  emitThrottle?(delayMs: number): void;
};

/** The seam an injected test run implements (default: a real BackupEngine). */
export interface BackupRunContext {
  trigger: 'manual' | 'scheduled';
  /**
   * MUTABLE knob holder: the engine keeps this exact object reference and
   * reads `concurrency` per page, so a live set-rate takes effect on the
   * next page without restarting the run.
   */
  engineOpts: BackupEngineOpts;
  /** Shared bandwidth bucket; setRate() applies live to the next take(). */
  bucket: TokenBucket;
  /** Called with the engine once built, BEFORE the run starts. */
  attachEngine: (engine: AttachableBackupEngine) => void;
}

export interface BackupHostConfig {
  serverUrl: string;
  pat: string;
  /** Absolute backup root (settings backup.root). */
  root: string;
  /** Worker-node id the root is bound to (settings backup.nodeId). */
  nodeId: string;
  nodeName?: string;
  cliVersion: string;
}

/** API surface the host needs (engine data plane + scheduler config poll). */
export type BackupHostApi = BackupApi & BackupSchedulerApi;

export interface BackupHostDeps {
  settings: SettingsRepo;
  logger: NodeLogger;
  retry?: RetryConfig;
  cooldown?: CooldownGateConfig;
  /** Injectable API client (tests); default: an OWN ApiClient (see header). */
  api?: BackupHostApi;
  /** Injectable run seam (tests replace the whole engine). */
  runBackupFn?: (ctx: BackupRunContext) => Promise<BackupRunOutcome>;
  /** Injectable catalog opener for status snapshots. */
  openDb?: (root: string) => BetterSqlite3.Database;
  /** Scheduler cadence overrides (tests). */
  scheduler?: Omit<BackupSchedulerOpts, 'nodeId'>;
  now?: () => Date;
}

/** Snapshot served over IPC as `{ kind: 'backup-status', ...snapshot }`. */
export interface BackupHostSnapshot {
  configured: boolean;
  running: { trigger: 'manual' | 'scheduled'; startedAt: string } | null;
  lastRun: CatalogRun | null;
  checkpoint: BackupCursor | null;
  counters: CatalogStats | null;
  rate: { concurrency: number; maxMbps: number };
}

interface ActiveRun {
  trigger: 'manual' | 'scheduled';
  startedAt: string;
  engineOpts: BackupEngineOpts;
  bucket: TokenBucket;
  engine: AttachableBackupEngine | null;
  cancelRequested: boolean;
  promise: Promise<BackupRunOutcome | null>;
}

export class BackupHost extends EventEmitter {
  private readonly cfg: BackupHostConfig;
  private readonly settings: SettingsRepo;
  private readonly logger: NodeLogger;
  private readonly api: BackupHostApi;
  private readonly runBackupFn: (ctx: BackupRunContext) => Promise<BackupRunOutcome>;
  private readonly openDb: (root: string) => BetterSqlite3.Database;
  private readonly scheduler: BackupScheduler;
  private readonly now: () => Date;

  private active: ActiveRun | null = null;

  constructor(cfg: BackupHostConfig, deps: BackupHostDeps) {
    super();
    this.cfg = cfg;
    this.settings = deps.settings;
    this.logger = deps.logger;
    this.openDb = deps.openDb ?? openCatalogDb;
    this.now = deps.now ?? ((): Date => new Date());

    // OWN ApiClient + OWN CooldownGate: the gate is per-client, and sharing
    // the NodeEngine's client would couple backup braking to enrichment
    // braking (and vice versa). The trip hook surfaces on the ACTIVE engine
    // as a typed throttle event, mirroring execute-run.ts.
    const gate = new CooldownGate(deps.cooldown ?? DEFAULT_COOLDOWN_CONFIG, {
      onTrip: (delayMs) => this.active?.engine?.emitThrottle?.(delayMs),
    });
    this.api =
      deps.api ??
      (new ApiClient({
        serverUrl: cfg.serverUrl,
        pat: cfg.pat,
        ...(deps.retry ? { retry: deps.retry } : {}),
        cooldownGate: gate,
      }) as BackupHostApi);

    this.runBackupFn = deps.runBackupFn ?? ((ctx): Promise<BackupRunOutcome> => this.executeEngineRun(ctx));

    this.scheduler = new BackupScheduler(
      { nodeId: cfg.nodeId, ...(deps.scheduler ?? {}) },
      {
        api: this.api,
        logger: this.logger,
        isRunActive: () => this.isRunning(),
        startRun: (trigger) => {
          try {
            this.startRun(trigger);
          } catch (err) {
            // 'busy' race with a manual run — the next poll retries.
            this.logger.warn('scheduled backup run rejected', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        ...(deps.now ? { now: (): number => this.now().getTime() } : {}),
      },
    );
  }

  /** Begin the scheduler poll (immediate check + 60s cadence). */
  startScheduler(): void {
    this.scheduler.start();
  }

  /** Stop the scheduler poll. An in-flight backup run completes untouched. */
  stopScheduler(): void {
    this.scheduler.stop();
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  /** Resolves when the active run (if any) settles — used by tests/shutdown. */
  async waitForIdle(): Promise<void> {
    await this.active?.promise;
  }

  /**
   * Start one backup run. Rejects with BackupBusyError while a run is active
   * (the host serializes runs). Returns immediately — progress streams as
   * 'backup-event' emissions and the outcome is logged. `kind: 'reconcile'`
   * adds the manifest-diff phase (issue #320; forwarded from the
   * backup-run-now IPC verb).
   */
  startRun(trigger: 'manual' | 'scheduled', kind: 'incremental' | 'reconcile' = 'incremental'): void {
    if (this.active) throw new BackupBusyError();

    const engineOpts: BackupEngineOpts = {
      root: this.cfg.root,
      nodeId: this.cfg.nodeId,
      ...(this.cfg.nodeName !== undefined ? { nodeName: this.cfg.nodeName } : {}),
      serverUrl: this.cfg.serverUrl,
      kind,
      trigger,
      cliVersion: this.cfg.cliVersion,
      concurrency: Math.max(1, Math.floor(this.settings.backupConcurrency())),
      maxMbps: this.settings.backupMaxMbps(),
      pageSize: Math.max(1, Math.floor(this.settings.backupPageSize())),
      pacingMs: this.settings.backupPacingMs(),
    };
    const bucket = new TokenBucket(engineOpts.maxMbps);

    const active: ActiveRun = {
      trigger,
      startedAt: this.now().toISOString(),
      engineOpts,
      bucket,
      engine: null,
      cancelRequested: false,
      promise: Promise.resolve(null),
    };
    this.active = active;

    const ctx: BackupRunContext = {
      trigger,
      engineOpts,
      bucket,
      attachEngine: (engine) => {
        active.engine = engine;
        for (const ev of Object.values(BACKUP_EV)) {
          engine.on(ev, (payload: unknown) => {
            this.emit(BACKUP_HOST_EVENT, { ev, payload } satisfies BackupHostEventFrame);
          });
        }
        // A cancel that raced engine construction still lands.
        if (active.cancelRequested) engine.cancel();
      },
    };

    this.logger.info('backup run starting', { trigger, root: this.cfg.root });
    active.promise = this.runBackupFn(ctx)
      .then((outcome) => {
        this.logger.info('backup run finished', {
          trigger,
          status: outcome.status,
          items: outcome.stats.itemsDownloaded,
          errors: outcome.stats.errors,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        });
        return outcome as BackupRunOutcome | null;
      })
      .catch((err: unknown) => {
        // RunAlreadyActiveError (another machine's run), catalog-open
        // failures, etc. — logged, never thrown out of the daemon.
        this.logger.warn('backup run failed', {
          trigger,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });
  }

  /** Cooperative cancel of the active run; false when nothing is running. */
  cancel(): boolean {
    const active = this.active;
    if (!active) return false;
    active.cancelRequested = true;
    active.engine?.cancel();
    this.logger.info('backup run cancel requested');
    return true;
  }

  /**
   * Persist new throttle knobs to the settings KV AND apply them to the
   * active run (if any) live: the engine reads opts.concurrency per page and
   * the bucket re-reads its rate per chunk, so the NEXT page/chunk uses the
   * new values. Returns the effective persisted values.
   */
  setRate(update: { concurrency?: number; maxMbps?: number }): {
    concurrency: number;
    maxMbps: number;
  } {
    if (update.concurrency !== undefined) {
      this.settings.setBackupConcurrency(update.concurrency);
    }
    if (update.maxMbps !== undefined) {
      this.settings.setBackupMaxMbps(update.maxMbps);
    }
    if (this.active) {
      if (update.concurrency !== undefined) {
        this.active.engineOpts.concurrency = update.concurrency;
      }
      if (update.maxMbps !== undefined) {
        this.active.bucket.setRate(update.maxMbps);
      }
    }
    const effective = {
      concurrency: this.settings.backupConcurrency(),
      maxMbps: this.settings.backupMaxMbps(),
    };
    this.logger.info('backup rate updated', {
      ...effective,
      appliedLive: this.active !== null,
    });
    return effective;
  }

  /**
   * Status snapshot for the `backup-status` IPC verb. Catalog reads open a
   * fresh (WAL-safe) connection so an in-flight run's connection is never
   * shared; an unreadable catalog degrades to null sections, never a throw.
   */
  getSnapshot(): BackupHostSnapshot {
    let counters: CatalogStats | null = null;
    let checkpoint: BackupCursor | null = null;
    let lastRun: CatalogRun | null = null;
    try {
      const db = this.openDb(this.cfg.root);
      try {
        const repo = new CatalogRepo(db);
        counters = repo.stats();
        lastRun = repo.latestRun();
        const raw = repo.getCheckpoint(CHECKPOINT_CURSOR_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<BackupCursor>;
          if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string') {
            checkpoint = { updatedAt: parsed.updatedAt, id: parsed.id };
          }
        }
      } finally {
        db.close();
      }
    } catch (err) {
      this.logger.warn('backup status catalog read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const rate = this.active
      ? {
          concurrency: this.active.engineOpts.concurrency,
          maxMbps: this.active.bucket.maxMbps,
        }
      : {
          concurrency: this.settings.backupConcurrency(),
          maxMbps: this.settings.backupMaxMbps(),
        };

    return {
      configured: true,
      running: this.active
        ? { trigger: this.active.trigger, startedAt: this.active.startedAt }
        : null,
      lastRun,
      checkpoint,
      counters,
      rate,
    };
  }

  // ---------------------------------------------------------------------------
  // Default run seam: a real BackupEngine over the host's own ApiClient
  // ---------------------------------------------------------------------------

  private async executeEngineRun(ctx: BackupRunContext): Promise<BackupRunOutcome> {
    const db = this.openDb(this.cfg.root);
    try {
      const engine = new BackupEngine(ctx.engineOpts, {
        api: this.api,
        db,
        bucket: ctx.bucket,
      });
      ctx.attachEngine(engine);
      return await engine.runBackup();
    } finally {
      db.close();
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, DatabaseBackupTrigger } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';

import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import { DatabaseBackupAlreadyRunningError } from './db-backup.errors';
import {
  PgConnectionConfig,
  spawnPgDump,
  spawnPgRestoreList,
} from './pg-dump.util';

/**
 * How often the run's `lastHeartbeatAt` / `bytesWritten` are refreshed while
 * the dump streams. Epic #339's staleness sweep (#342) uses that timestamp to
 * distinguish a slow-but-alive run from a dead one, which no fixed timeout can
 * do; the UI uses `bytesWritten` for live progress. Kept well under
 * `databaseBackup.runStaleMinutes` (minimum 5 minutes) so an alive run is never
 * swept. Overridable for tests and for very chatty/quiet deployments.
 */
const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * Hard ceiling on a single `pg_dump`. Generous by design — epic #339 sizes a
 * real run at tens of minutes, and killing a legitimately slow dump is strictly
 * worse than letting it finish. This exists to bound a genuinely wedged process
 * (a hung socket), not to police duration.
 */
const DEFAULT_PG_DUMP_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h

/** Verification reads the archive back; far cheaper than producing it. */
const DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/** `lastError` is a display/diagnostic field, not a log sink. */
const MAX_LAST_ERROR_CHARS = 4000;

export interface StartBackupOptions {
  trigger: DatabaseBackupTrigger;
  /** User who triggered a manual run; null for scheduled/system runs. */
  createdById?: string | null;
}

export interface DatabaseBackupResult {
  runId: string;
  storageProvider: string;
  storageKey: string;
  bucket: string | null;
  sizeBytes: bigint;
  checksumSha256: string;
}

/**
 * DatabaseBackupRunnerService — the `pg_dump` engine (issue #341, epic #339).
 *
 * Deliberately NOT an `enrichment_jobs` job type. `jobs.stuckThresholdMinutes`
 * defaults to 3 minutes and `EnrichmentAdminService.stuckRunningWhere()` would
 * flag a 30-minute dump as stuck, reset it to `pending`, and let the worker
 * start a SECOND concurrent dump; and because the in-process worker has no
 * lease-renewal path (only remote nodes renew), exceeding `ENRICHMENT_LEASE_MS`
 * trips the stuck check unconditionally. The precedent this follows is
 * `NodeBackupRun` + `NodeBackupStaleTask` — a dedicated run table with its own
 * heartbeat — not `trash_purge`. See epic #339's rationale.
 *
 * The run is a straight line with one invariant at every step: **the archive is
 * never materialised in memory**. `pg_dump` stdout is piped, with backpressure,
 * through a pass-through transform (which computes the sha256 and counts bytes
 * on the same single pass) directly into `provider.upload(key, stream, …)`.
 */
@Injectable()
export class DatabaseBackupRunnerService {
  private readonly logger = new Logger(DatabaseBackupRunnerService.name);

  /**
   * Runs currently streaming IN THIS PROCESS, keyed by run id.
   *
   * Deliberately process-local rather than a DB flag: the only thing that can
   * actually stop a `pg_dump` is a signal to the child, and only the process
   * that spawned it can send one. The DB row remains the cross-replica source
   * of truth for run STATE; this map is purely the handle needed to interrupt.
   */
  private readonly activeRuns = new Map<string, { abort: (err: Error) => void }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly providerResolver: StorageProviderResolver,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a full logical backup end to end: claim → dump+upload → verify →
   * record metadata. Resolves once the run row is `completed`.
   *
   * @throws DatabaseBackupAlreadyRunningError when another run holds the slot.
   *   Every other failure marks the run `failed`, deletes the partial storage
   *   object, and rethrows. There is deliberately NO automatic retry — the next
   *   scheduled run is the natural retry, and silently re-running a 30-minute
   *   multi-GB dump is the wrong default.
   */
  async runBackup(opts: StartBackupOptions): Promise<DatabaseBackupResult> {
    const { completion } = await this.startBackup(opts);
    return completion;
  }

  /**
   * Claim the run slot and START the backup WITHOUT waiting for it to finish.
   *
   * Exists for #343's `POST /api/admin/db-backup/runs`, which must answer with
   * a `runId` in well under a second while a dump that takes tens of minutes
   * carries on in the background — the same posture as
   * `POST /api/nodes/:id/backup/runs`. The claim itself IS awaited, so the
   * caller either gets a real id or the `DatabaseBackupAlreadyRunningError`
   * that turns into a 409; only the dump is detached.
   *
   * `completion` carries the same success/failure semantics as `runBackup`
   * (including the failure path that deletes the partial object). A caller that
   * detaches MUST attach a `.catch()` to it — an unobserved rejection here would
   * be an unhandled rejection, which under Node's default kills the process.
   *
   * @throws DatabaseBackupAlreadyRunningError when another run holds the slot.
   */
  async startBackup(
    opts: StartBackupOptions,
  ): Promise<{ runId: string; completion: Promise<DatabaseBackupResult> }> {
    const runId = await this.claimRun(opts);

    const completion = (async () => {
      try {
        return await this.executeRun(runId);
      } catch (err) {
        await this.markFailed(runId, err);
        throw err;
      }
    })();

    return { runId, completion };
  }

  /**
   * Cooperatively cancel a run.
   *
   * When the run is executing IN THIS PROCESS, the registered aborter kills the
   * `pg_dump` child and destroys the metering stream, which tears the upload
   * down; the run then travels its ordinary failure path — which is what
   * deletes the partial storage object and writes `status='failed'`. Nothing
   * about cancellation is a second, parallel teardown.
   *
   * When it is NOT in this process (another replica, or a row orphaned by a
   * crash), there is no child to signal, so the same terminal bookkeeping is
   * applied directly: `markFailed` deletes whatever partial object the row
   * points at and marks it failed. This is the honest best effort — a dump
   * running on another replica keeps running there until its own upload fails
   * or its heartbeat goes stale.
   *
   * @returns `signalled: true` when an in-process run was aborted.
   */
  async cancelRun(runId: string): Promise<{ signalled: boolean }> {
    const entry = this.activeRuns.get(runId);
    if (entry) {
      this.logger.warn(`Cancelling in-flight database backup ${runId}`);
      entry.abort(new Error('Database backup cancelled by an administrator'));
      return { signalled: true };
    }

    this.logger.warn(
      `Cancelling database backup ${runId} with no in-process handle; marking failed`,
    );
    await this.markFailed(
      runId,
      new Error('Database backup cancelled by an administrator'),
    );
    return { signalled: false };
  }

  // -------------------------------------------------------------------------
  // Step 1 — claim the single-active-run slot
  // -------------------------------------------------------------------------

  /**
   * INSERT a `running` row. The partial unique index from #340 turns a
   * concurrent start into a P2002 rather than a second dump — the guard is in
   * the database, so it holds across replicas.
   */
  private async claimRun(opts: StartBackupOptions): Promise<string> {
    const now = new Date();
    try {
      const run = await this.prisma.databaseBackupRun.create({
        data: {
          status: 'running',
          trigger: opts.trigger,
          startedAt: now,
          lastHeartbeatAt: now,
          createdById: opts.createdById ?? null,
        },
        select: { id: true },
      });
      return run.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const active = await this.prisma.databaseBackupRun.findFirst({
          where: { status: { in: ['pending', 'running'] } },
          select: { id: true },
          orderBy: { startedAt: 'desc' },
        });
        throw new DatabaseBackupAlreadyRunningError(active?.id ?? null);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Steps 2–6 — dump, upload, verify, record
  // -------------------------------------------------------------------------

  private async executeRun(runId: string): Promise<DatabaseBackupResult> {
    const settings = (await this.systemSettings.getSettings()) as any;
    const dbBackup = settings?.databaseBackup ?? {};
    const compressionLevel: number =
      typeof dbBackup.compressionLevel === 'number'
        ? dbBackup.compressionLevel
        : 1;

    const { id: providerId, provider } = await this.resolveProvider(
      dbBackup.storageProvider ?? null,
    );

    const storageKey = buildStorageKey(runId, new Date());
    const bucket = safeGetBucket(provider);

    await this.prisma.databaseBackupRun.update({
      where: { id: runId },
      data: {
        storageProvider: providerId,
        storageKey,
        bucket,
        // `-Fc`: the pg_dump custom archive format.
        format: 'custom',
      },
    });

    const pg = this.pgConnection();

    const { sizeBytes, checksumSha256 } = await this.dumpAndUpload({
      runId,
      provider,
      storageKey,
      pg,
      compressionLevel,
    });

    // Step 5 — verify BEFORE declaring success. A backup that silently isn't
    // restorable is worse than no backup, and reading the TOC back costs a
    // rounding error next to producing the dump.
    await this.verifyUploadedArchive(provider, storageKey, pg);
    const verifiedAt = new Date();

    const [dbVersion, migrationName] = await Promise.all([
      this.readDbVersion(),
      this.readLatestMigrationName(),
    ]);

    await this.prisma.databaseBackupRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        lastHeartbeatAt: new Date(),
        bytesWritten: sizeBytes,
        sizeBytes,
        checksumSha256,
        verifiedAt,
        dbVersion,
        appVersion: resolveAppVersion(),
        migrationName,
        lastError: null,
      },
    });

    this.logger.log(
      `Database backup ${runId} completed: ${sizeBytes} bytes at ${providerId}:${storageKey}`,
    );

    return {
      runId,
      storageProvider: providerId,
      storageKey,
      bucket,
      sizeBytes,
      checksumSha256,
    };
  }

  /**
   * Resolve the destination provider: the explicit `databaseBackup.storageProvider`
   * override when configured, otherwise the active provider. Never hardcoded to
   * local disk (unlike the older media-backup feature) — when the active
   * provider IS local, an admin can point backups elsewhere so the dump does not
   * land on the same disk as the database it protects.
   */
  private async resolveProvider(
    override: string | null,
  ): Promise<{ id: string; provider: StorageProvider }> {
    if (override) {
      const provider = await this.providerResolver.getProviderFor(override);
      return { id: override, provider };
    }
    return this.providerResolver.getActiveProvider();
  }

  /**
   * Stream `pg_dump` stdout straight into storage.
   *
   * THE load-bearing property of this method: the archive is piped with
   * backpressure and is never buffered — no `.toBuffer()`, no chunk array, no
   * `await streamToString`. The sha256 and the byte count are computed by a
   * pass-through `Transform` on that same single pass, so the checksum costs no
   * second read of multiple gigabytes.
   */
  private async dumpAndUpload(args: {
    runId: string;
    provider: StorageProvider;
    storageKey: string;
    pg: PgConnectionConfig;
    compressionLevel: number;
  }): Promise<{ sizeBytes: bigint; checksumSha256: string }> {
    const { runId, provider, storageKey, pg, compressionLevel } = args;

    const hash = createHash('sha256');
    let bytes = 0n;

    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        bytes += BigInt(chunk.length);
        cb(null, chunk);
      },
    });

    const dump = spawnPgDump(pg, compressionLevel, {
      timeoutMs: this.numberFromEnv(
        'DB_BACKUP_PG_DUMP_TIMEOUT_MS',
        DEFAULT_PG_DUMP_TIMEOUT_MS,
      ),
    });

    // A pg_dump failure must tear the upload down rather than leaving it
    // waiting forever on a source that will never produce another byte.
    dump.done.catch((err: Error) => {
      meter.destroy(err);
    });

    dump.stdout.on('error', (err: Error) => meter.destroy(err));
    dump.stdout.pipe(meter);

    const heartbeat = this.startHeartbeat(runId, () => bytes);

    // Publish the abort handle for `cancelRun`. Killing the child and
    // destroying the meter is exactly what the failure path below already
    // reacts to, so a cancellation needs no separate teardown.
    this.activeRuns.set(runId, {
      abort: (err: Error) => {
        dump.kill();
        meter.destroy(err);
      },
    });

    try {
      const uploadPromise = provider.upload(storageKey, meter as Readable, {
        mimeType: 'application/octet-stream',
        metadata: { runId },
      });

      // Both must succeed: the upload can resolve on a truncated stream if the
      // dump died mid-flight, and the dump can exit non-zero after the last
      // byte was already accepted.
      await Promise.all([uploadPromise, dump.done]);
    } catch (err) {
      // Whichever side failed, stop the other one.
      dump.kill();
      meter.destroy();
      throw err;
    } finally {
      // Non-negotiable: neither the interval nor the abort handle may outlive
      // the run, in any path.
      heartbeat.stop();
      this.activeRuns.delete(runId);
    }

    // Final progress write so a UI polling `bytesWritten` lands on the true
    // total even if the run finished between heartbeat ticks.
    await this.safeUpdateProgress(runId, bytes);

    return { sizeBytes: bytes, checksumSha256: hash.digest('hex') };
  }

  /**
   * Step 5 — stream the UPLOADED object back through `pg_restore --list`.
   *
   * Reading the archive's table of contents proves the bytes that actually
   * landed in storage parse as a complete custom-format archive, which a
   * truncated or corrupted upload cannot do. Verifying the uploaded object (not
   * the local stream) is the point: the failure mode being guarded against is
   * in the transfer, not in pg_dump.
   */
  private async verifyUploadedArchive(
    provider: StorageProvider,
    storageKey: string,
    pg: PgConnectionConfig,
  ): Promise<void> {
    const source = await provider.download(storageKey);

    const restore = spawnPgRestoreList(pg, {
      timeoutMs: this.numberFromEnv(
        'DB_BACKUP_PG_RESTORE_LIST_TIMEOUT_MS',
        DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS,
      ),
    });

    let tocBytes = 0;
    // The TOC listing must be drained or the child blocks on a full stdout
    // pipe. It is not otherwise needed, so it is counted and discarded rather
    // than accumulated.
    restore.stdout?.on('data', (chunk: Buffer | string) => {
      tocBytes += chunk.length;
    });
    restore.stdout?.on('error', () => {});

    source.on('error', (err: Error) => {
      restore.kill();
      restore.done.catch(() => {});
      source.destroy(err);
    });

    if (restore.stdin) {
      source.pipe(restore.stdin);
    }

    await restore.done;

    if (tocBytes === 0) {
      throw new Error(
        'pg_restore --list produced an empty table of contents; the uploaded archive is not readable',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  /**
   * Refresh `lastHeartbeatAt`/`bytesWritten` on a timer while the dump streams.
   *
   * Failures are swallowed: a transient write error must not abort a backup
   * that is otherwise progressing, and the staleness sweep tolerates a missed
   * tick. `stop()` is idempotent and is called from a `finally` so the interval
   * can never leak past the run.
   */
  private startHeartbeat(
    runId: string,
    readBytes: () => bigint,
  ): { stop: () => void } {
    const intervalMs = this.numberFromEnv(
      'DB_BACKUP_HEARTBEAT_MS',
      DEFAULT_HEARTBEAT_MS,
    );

    const timer = setInterval(() => {
      void this.safeUpdateProgress(runId, readBytes());
    }, intervalMs);
    // Never hold the event loop open on account of progress reporting.
    timer.unref?.();

    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async safeUpdateProgress(runId: string, bytes: bigint): Promise<void> {
    try {
      await this.prisma.databaseBackupRun.update({
        where: { id: runId },
        data: { lastHeartbeatAt: new Date(), bytesWritten: bytes },
      });
    } catch (err) {
      this.logger.warn(
        `Heartbeat update failed for database backup ${runId}: ${errorMessage(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Failure path
  // -------------------------------------------------------------------------

  /**
   * Step 7 — mark the run failed AND delete the partial storage object.
   *
   * A failed multi-GB upload that leaves its bytes behind costs real money and
   * is invisible in the UI (the run says `failed`, so nothing points at the
   * object). Deletion is best-effort: it must never mask the original failure,
   * which is what the caller rethrows.
   */
  private async markFailed(runId: string, cause: unknown): Promise<void> {
    const message = errorMessage(cause).slice(0, MAX_LAST_ERROR_CHARS);

    let run: { storageProvider: string | null; storageKey: string | null; bucket: string | null } | null =
      null;
    try {
      run = await this.prisma.databaseBackupRun.findUnique({
        where: { id: runId },
        select: { storageProvider: true, storageKey: true, bucket: true },
      });
    } catch (err) {
      this.logger.warn(
        `Could not load database backup ${runId} while failing it: ${errorMessage(err)}`,
      );
    }

    if (run?.storageProvider && run.storageKey) {
      try {
        const provider = await this.providerResolver.getProviderFor(
          run.storageProvider,
          run.bucket,
        );
        await provider.delete(run.storageKey);
        this.logger.log(
          `Deleted partial database backup object ${run.storageProvider}:${run.storageKey} after failure`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to delete partial database backup object ${run.storageKey}: ${errorMessage(err)}`,
        );
      }
    }

    try {
      await this.prisma.databaseBackupRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          lastError: message,
        },
      });
    } catch (err) {
      this.logger.error(
        `Could not mark database backup ${runId} failed: ${errorMessage(err)}`,
      );
    }

    this.logger.error(`Database backup ${runId} failed: ${message}`);
  }

  // -------------------------------------------------------------------------
  // Metadata helpers
  // -------------------------------------------------------------------------

  /** `SELECT version()` — records which server produced the archive. */
  private async readDbVersion(): Promise<string | null> {
    try {
      const rows =
        await this.prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
      return rows?.[0]?.version ?? null;
    } catch (err) {
      this.logger.warn(`Could not read database version: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Latest APPLIED migration. Recorded so a restore can be checked against the
   * schema version the running code expects — restoring an archive from an
   * older migration into newer code is the failure this makes visible.
   */
  private async readLatestMigrationName(): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name
        FROM _prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `;
      return rows?.[0]?.migration_name ?? null;
    } catch (err) {
      this.logger.warn(
        `Could not read latest applied migration: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  private pgConnection(): PgConnectionConfig {
    return {
      host: this.config.get<string>('POSTGRES_HOST') ?? 'localhost',
      port: Number(this.config.get<string>('POSTGRES_PORT') ?? '5432'),
      user: this.config.get<string>('POSTGRES_USER') ?? 'postgres',
      password: this.config.get<string>('POSTGRES_PASSWORD') ?? 'postgres',
      database: this.config.get<string>('POSTGRES_DB') ?? 'appdb',
    };
  }

  private numberFromEnv(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * `db-backups/<utc-timestamp>-<runId>.dump`.
 *
 * The run id makes the key unique and traceable back to its row; the leading
 * timestamp makes a raw bucket listing chronologically sortable, which matters
 * during a disaster-recovery restore where the app (and its run table) may be
 * unavailable.
 */
export function buildStorageKey(runId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  return `db-backups/${stamp}-${runId}.dump`;
}

/**
 * Application version recorded alongside the archive. Sourced from the
 * environment rather than a bundled constant so it reflects the deployed image,
 * and is nullable because a bare `node dist/main` has neither variable set.
 */
export function resolveAppVersion(): string | null {
  return process.env.APP_VERSION || process.env.npm_package_version || null;
}

function safeGetBucket(provider: StorageProvider): string | null {
  try {
    return provider.getBucket() || null;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

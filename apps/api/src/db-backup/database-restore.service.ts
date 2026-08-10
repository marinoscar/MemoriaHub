/**
 * DatabaseRestoreService — restore via scratch database + atomic swap
 * (issue #344, epic #339).
 *
 * ==========================================================================
 * THE DESIGN, AND THE ONE THING THAT DICTATES IT
 * ==========================================================================
 *
 * A `pg_dump` archive stores `CREATE INDEX`, not index data. Restoring this
 * database therefore REBUILDS every HNSW index from scratch — three on
 * `faces.embedding_vec`, plus `media_item_embedding` (1536-d) and
 * `media_visual_embedding` (512-d), roughly a million vectors at projected
 * scale. That is plausibly HOURS, and every other decision here follows from
 * it:
 *
 *   1. Pre-flight gates (capability, disk, artifact, schema compatibility).
 *   2. `CREATE DATABASE memoriahub_restore_<suffix>`.
 *   3. `pg_restore -d <scratch> -j N --no-owner --no-acl` — THE APP STAYS FULLY
 *      UP AND SERVING ON THE LIVE DATABASE for this entire multi-hour phase.
 *   4. Verify the restored database (extension, tables, row counts, indexes).
 *   5. Swap, in SECONDS: maintenance mode → terminate connections →
 *      `ALTER DATABASE live RENAME TO old` + `ALTER DATABASE scratch RENAME TO
 *      live` → `process.exit(0)` so the orchestrator restarts with a clean pool.
 *
 * ==========================================================================
 * WHY IN-PLACE `pg_restore --clean` IS NOT AN OPTION
 * ==========================================================================
 *
 * It was rejected outright in epic #339, for two independent reasons:
 *
 *   - `--clean` drops every object IN THE ARCHIVE, including
 *     `database_backup_runs` itself. The restore would destroy the row tracking
 *     its own progress and replace the catalog with the one from backup time.
 *     You cannot record a restore's outcome inside the database being restored.
 *   - Its failure mode destroys the tool needed to recover from it: fail
 *     mid-rebuild and you have dropped tables, an app that cannot boot, no UI
 *     and no catalog — with the destructive window HOURS wide instead of the
 *     seconds a rename takes.
 *
 * Do not reintroduce it. The live database here is untouched until a
 * seconds-long rename, and a failure before that point costs only the scratch
 * database.
 *
 * ==========================================================================
 * THE TWO THINGS THE SWAP INTRODUCES
 * ==========================================================================
 *
 *   - CATALOG CARRY-OVER. The restored database holds `database_backup_runs`
 *     as of BACKUP time, so this restore's own record and every backup taken
 *     since would vanish at the swap. Rows are exported before the rename and
 *     re-inserted after it (see {@link exportCatalog}/{@link reinsertCatalog}).
 *   - MIGRATION ROLL-FORWARD. `_prisma_migrations` also comes from the backup,
 *     so restoring an older archive can leave the schema behind the running
 *     code. The schema-compatibility pre-flight detects this and BLOCKS by
 *     default; the remedy is `prisma migrate deploy` after the swap, which is
 *     exactly what the explicit override exists for.
 *
 * ==========================================================================
 * OPERATIONAL CONSTRAINTS (documented, not silently assumed)
 * ==========================================================================
 *
 *   - SINGLE API REPLICA. #348's maintenance flag is per-process, so with
 *     multiple replicas only the swapping replica stops serving; the others
 *     keep connections open, get terminated mid-request by
 *     `pg_terminate_backend`, and then talk to a database that has been renamed
 *     out from under them. Scale to one replica before restoring. The
 *     pre-flight WARNS when it can detect more than one distinct client
 *     address, which is a heuristic, not a guarantee.
 *   - RESTART POLICY REQUIRED. The swap ends in `process.exit(0)`, relying on
 *     the orchestrator to bring the process back with a fresh connection pool.
 *     The deployment MUST set `restart: unless-stopped` (or a Kubernetes
 *     equivalent); without it, an otherwise-successful restore leaves the app
 *     down.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseBackupTrigger } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { MaintenanceModeService } from '../common/maintenance/maintenance-mode.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { DatabaseBackupRunnerService } from './database-backup-runner.service';
import {
  buildOldDatabaseName,
  buildScratchDatabaseName,
  buildSuffix,
  countDistinctClientAddresses,
  createDatabase,
  databaseExists,
  dropDatabase,
  probeCreateDatabasePrivilege,
  probePgvectorAvailable,
  readDatabaseSizeBytes,
  readDataDirectory,
  renameDatabase,
  resolveMaintenanceDatabase,
  terminateConnections,
  withAdminConnection,
  type AdminClientLike,
} from './admin-connection.util';
import type { PgConnectionConfig } from './pg-dump.util';
import {
  resolveExitOnError,
  resolveParallelJobs,
  spawnPgRestore,
  spawnPgRestoreListFile,
} from './pg-restore.util';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `restoreError` is a display field, not a log sink. */
const MAX_RESTORE_ERROR_CHARS = 4000;

/** Generous by design: a legitimate HNSW rebuild is measured in hours. */
const DEFAULT_PG_RESTORE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12h

/** Reading an archive's TOC is cheap next to producing or restoring it. */
const DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS = 30 * 60 * 1000; // 30m

/** Headroom over the raw size requirement, matching the video-download guard. */
const DISK_HEADROOM_FACTOR = 1.2;

/**
 * Tables whose presence proves the archive really is a MemoriaHub database and
 * that the restore got past the schema phase. Deliberately a short, stable
 * list — a long one would need editing on every migration and would fail a
 * legitimate restore of a slightly older archive.
 */
const REQUIRED_TABLES = [
  'users',
  'circles',
  'media_items',
  'database_backup_runs',
  '_prisma_migrations',
];

/** Written to the runbook link in the guided payload. */
export const RESTORE_RUNBOOK_PATH = 'docs/runbooks/database-restore.md';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RestoreRollbackMode = 'retain_database' | 'pre_restore_dump';

export type PreflightStatus = 'ok' | 'warning' | 'blocked';

export interface PreflightCheck {
  key: string;
  label: string;
  status: PreflightStatus;
  message: string;
  actionItem?: string;
}

export interface RestorePreflightReport {
  /**
   * `ok` — proceed automatically.
   * `guided` — a CAPABILITY gate failed (no CREATEDB, no pgvector, no admin
   *   connection). Not an error state: the app cannot drive the restore, so it
   *   hands the admin a ready-to-paste command block instead.
   * `blocked` — a gate the admin can consciously override (today: schema
   *   compatibility) failed.
   */
  status: 'ok' | 'guided' | 'blocked';
  checks: PreflightCheck[];
  /** The mode actually in force, after any automatic downgrade. */
  rollbackMode: RestoreRollbackMode;
  /** What `databaseBackup.restoreRollbackMode` asked for. */
  rollbackModeRequested: RestoreRollbackMode;
  rollbackModeDowngraded: boolean;
  downgradeReason: string | null;
  scratchDatabase: string;
  oldDatabase: string;
}

export interface GuidedRestorePayload {
  reason: string;
  runbook: string;
  commands: string[];
  notes: string[];
}

export type StartRestoreResult =
  | {
      mode: 'running';
      runId: string;
      scratchDatabase: string;
      oldDatabase: string;
      rollbackMode: RestoreRollbackMode;
      rollbackModeDowngraded: boolean;
      preflight: RestorePreflightReport;
    }
  | {
      mode: 'guided';
      runId: string;
      guided: GuidedRestorePayload;
      preflight: RestorePreflightReport;
    }
  | {
      mode: 'blocked';
      runId: string;
      reason: string;
      preflight: RestorePreflightReport;
    };

export interface StartRestoreOptions {
  userId: string;
  /**
   * Proceed despite a schema-compatibility mismatch — the "restore old data,
   * then `prisma migrate deploy`" path. Never bypasses a CAPABILITY gate: no
   * amount of admin intent conjures a `CREATEDB` privilege.
   */
  overrideSchemaCheck?: boolean;
}

export type RollbackResult =
  | { mode: 'renamed'; runId: string; restoredDatabase: string }
  | { mode: 'restore_started'; runId: string; preRestoreBackupId: string }
  | { mode: 'unavailable'; runId: string; reason: string };

/** Typed errors so the controller can map them without re-deriving conditions. */
export class DatabaseRestoreNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseRestoreNotAllowedError';
  }
}

export class DatabaseRestoreNotFoundError extends Error {
  constructor(runId: string) {
    super(`Database backup run ${runId} not found`);
    this.name = 'DatabaseRestoreNotFoundError';
  }
}

export class DatabaseRestoreAlreadyRunningError extends Error {
  constructor(readonly activeRunId: string) {
    super(`A database restore is already in progress (runId=${activeRunId})`);
    this.name = 'DatabaseRestoreAlreadyRunningError';
  }
}

/** Non-terminal restore states — the ones that hold the single-restore slot. */
const ACTIVE_RESTORE_STATUSES = ['restoring', 'verifying', 'swapping'];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DatabaseRestoreService {
  private readonly logger = new Logger(DatabaseRestoreService.name);

  /**
   * Process exit seam. The swap ends by exiting so the orchestrator restarts
   * the process against the renamed database with a clean Prisma pool; tests
   * replace this to assert the exit happened without killing the test runner.
   */
  private exitProcess: (code: number) => void = (code) => process.exit(code);

  /** TEST-ONLY. Production code must never call this. */
  __setExitHookForTests(fn: ((code: number) => void) | null): void {
    this.exitProcess = fn ?? ((code) => process.exit(code));
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly providerResolver: StorageProviderResolver,
    private readonly maintenance: MaintenanceModeService,
    private readonly backupRunner: DatabaseBackupRunnerService,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a restore from a completed backup run.
   *
   * Returns as soon as the CHEAP pre-flight gates have been evaluated; the
   * multi-hour restore continues in the background and its progress is written
   * to the run's restore-audit fields. The three outcomes are all normal:
   * `running`, `guided` (capability gate failed — here is the command block),
   * and `blocked` (an overridable gate failed).
   */
  async startRestore(
    runId: string,
    opts: StartRestoreOptions,
  ): Promise<StartRestoreResult> {
    const run = await this.prisma.databaseBackupRun.findUnique({
      where: { id: runId },
    });
    if (!run) throw new DatabaseRestoreNotFoundError(runId);

    if (run.status !== 'completed') {
      throw new DatabaseRestoreNotAllowedError(
        `Backup run ${runId} is ${run.status}; only a completed backup can be restored`,
      );
    }
    if (!run.storageProvider || !run.storageKey) {
      throw new DatabaseRestoreNotAllowedError(
        `Backup run ${runId} has no recorded storage location`,
      );
    }

    await this.assertNoRestoreInProgress();

    const pg = this.pgConnection();
    const suffix = buildSuffix();
    const scratchDatabase = buildScratchDatabaseName(pg.database, suffix);
    const oldDatabase = buildOldDatabaseName(pg.database, suffix);

    const preflight = await this.preflight(run, {
      pg,
      scratchDatabase,
      oldDatabase,
      overrideSchemaCheck: opts.overrideSchemaCheck === true,
    });

    if (preflight.status === 'guided') {
      const guided = this.buildGuidedPayload(run, pg, preflight);
      await this.writeRestoreState(runId, {
        restoreStatus: 'guided',
        restoredById: opts.userId,
        restoreError: guided.reason.slice(0, MAX_RESTORE_ERROR_CHARS),
      });
      return { mode: 'guided', runId, guided, preflight };
    }

    if (preflight.status === 'blocked') {
      const reason = preflight.checks
        .filter((c) => c.status === 'blocked')
        .map((c) => c.message)
        .join('; ');
      await this.writeRestoreState(runId, {
        restoreStatus: 'blocked',
        restoredById: opts.userId,
        restoreError: reason.slice(0, MAX_RESTORE_ERROR_CHARS),
      });
      return { mode: 'blocked', runId, reason, preflight };
    }

    await this.writeRestoreState(runId, {
      restoreStatus: 'restoring',
      restoredById: opts.userId,
      restoreScratchDb: scratchDatabase,
      restoreOldDb: null,
      restoreError: null,
      restoredAt: null,
      swappedAt: null,
    });

    // Detached: the restore runs for hours and must outlive the HTTP request.
    // The terminal `.catch()` is mandatory — an unobserved rejection here is an
    // unhandled rejection, which under Node's default kills the process.
    void this.executeRestore(run.id, {
      pg,
      scratchDatabase,
      oldDatabase,
      rollbackMode: preflight.rollbackMode,
      userId: opts.userId,
    }).catch(() => {
      /* executeRestore records its own failure; nothing to add here. */
    });

    return {
      mode: 'running',
      runId,
      scratchDatabase,
      oldDatabase,
      rollbackMode: preflight.rollbackMode,
      rollbackModeDowngraded: preflight.rollbackModeDowngraded,
      preflight,
    };
  }

  /**
   * Undo a completed restore.
   *
   * `retain_database`: rename the retained pre-swap database back into place —
   * SECONDS, which is the entire justification for paying ~2× the Postgres
   * volume during the retention window.
   *
   * `pre_restore_dump`: there is no database to rename, only the safety dump
   * taken before the swap. Rolling back therefore means restoring THAT backup
   * — a full restore, hours again — which is delegated straight back into
   * {@link startRestore} rather than reimplemented. A rollback is worthless if
   * it requires knowing the `ALTER DATABASE` incantation during an incident,
   * so both paths are one API call.
   */
  async rollback(runId: string, opts: { userId: string }): Promise<RollbackResult> {
    const run = await this.prisma.databaseBackupRun.findUnique({
      where: { id: runId },
    });
    if (!run) throw new DatabaseRestoreNotFoundError(runId);

    if (run.restoreStatus !== 'completed') {
      throw new DatabaseRestoreNotAllowedError(
        `Backup run ${runId} has no completed restore to roll back (restoreStatus=${run.restoreStatus ?? 'none'})`,
      );
    }

    if (!run.restoreOldDb) {
      if (run.preRestoreBackupId) {
        this.logger.warn(
          `Rolling back restore ${runId} via pre-restore dump ${run.preRestoreBackupId} — this is a FULL restore and will take hours`,
        );
        await this.startRestore(run.preRestoreBackupId, {
          userId: opts.userId,
          // The pre-restore dump was taken from the schema the code was running
          // moments ago, so a compatibility block here would be spurious.
          overrideSchemaCheck: true,
        });
        return {
          mode: 'restore_started',
          runId,
          preRestoreBackupId: run.preRestoreBackupId,
        };
      }
      return {
        mode: 'unavailable',
        runId,
        reason:
          'No retained pre-swap database and no pre-restore dump was recorded; this restore cannot be rolled back automatically.',
      };
    }

    const pg = this.pgConnection();
    const oldDb = run.restoreOldDb;

    await withAdminConnection(pg, async (client) => {
      if (!(await databaseExists(client, oldDb))) {
        throw new DatabaseRestoreNotAllowedError(
          `Retained database ${oldDb} no longer exists (past oldDatabaseRetentionHours?)`,
        );
      }

      await this.maintenance.enable(
        'Rolling back a database restore. The application will be back in a moment.',
        opts.userId,
        { allowAdmins: false },
      );

      const supersededName = buildScratchDatabaseName(
        pg.database,
        `rb${buildSuffix()}`,
      );

      await this.prisma.$disconnect().catch(() => {});
      await terminateConnections(client, pg.database);

      // Same two-step, same ordering, same commitment point as the swap.
      await renameDatabase(client, pg.database, supersededName);
      try {
        await renameDatabase(client, oldDb, pg.database);
      } catch (err) {
        await renameDatabase(client, supersededName, pg.database).catch(() => {});
        throw err;
      }
    });

    this.logger.warn(
      `Rollback of restore ${runId} complete; exiting so the orchestrator restarts against ${oldDb}`,
    );
    this.exitProcess(0);

    return { mode: 'renamed', runId, restoredDatabase: pg.database };
  }

  // -------------------------------------------------------------------------
  // Pre-flight
  // -------------------------------------------------------------------------

  /**
   * Evaluate every gate that can be answered CHEAPLY, before anything is
   * created and before the caller's HTTP request has to wait on a multi-GB
   * download.
   *
   * Artifact verification (checksum + `pg_restore --list` on the real bytes) is
   * deliberately NOT here: it requires downloading the whole archive, which can
   * take minutes. It is the first phase of the async run instead, and it still
   * runs before the scratch database is created — so an unreadable artifact
   * costs nothing but time. The guided payload carries the checksum and the
   * verification commands so a manual restore performs the same check.
   */
  private async preflight(
    run: { sizeBytes: bigint | null; migrationName: string | null },
    ctx: {
      pg: PgConnectionConfig;
      scratchDatabase: string;
      oldDatabase: string;
      overrideSchemaCheck: boolean;
    },
  ): Promise<RestorePreflightReport> {
    const checks: PreflightCheck[] = [];
    const requested = await this.resolveRollbackMode();
    let rollbackMode = requested;
    let downgradeReason: string | null = null;

    let capabilityFailed = false;

    try {
      await withAdminConnection(ctx.pg, async (client) => {
        // --- capability: CREATEDB -------------------------------------------
        const canCreate = await probeCreateDatabasePrivilege(client);
        checks.push({
          key: 'capability.createdb',
          label: 'CREATE DATABASE privilege',
          status: canCreate ? 'ok' : 'blocked',
          message: canCreate
            ? `Role ${ctx.pg.user} can create databases`
            : `Role ${ctx.pg.user} lacks CREATEDB (common on managed Postgres)`,
          actionItem: canCreate
            ? undefined
            : 'Grant CREATEDB to the application role, or follow the guided restore below.',
        });
        if (!canCreate) capabilityFailed = true;

        // --- capability: pgvector -------------------------------------------
        const hasVector = await probePgvectorAvailable(client);
        checks.push({
          key: 'capability.pgvector',
          label: 'pgvector extension available',
          status: hasVector ? 'ok' : 'blocked',
          message: hasVector
            ? 'The `vector` extension can be created in this cluster'
            : 'The `vector` extension is not available; the archive issues CREATE EXTENSION vector',
          actionItem: hasVector
            ? undefined
            : 'Use a pgvector-capable image (pgvector/pgvector:pg16) or install the extension.',
        });
        if (!hasVector) capabilityFailed = true;

        // --- disk -------------------------------------------------------------
        const diskCheck = await this.checkDisk(client, ctx.pg, requested, run);
        checks.push(diskCheck.check);
        if (diskCheck.insufficient && requested === 'retain_database') {
          // NEVER refuse for want of disk while a workable mode exists: an
          // admin mid-incident must always have a path forward. Downgrading
          // costs the instant-rollback guarantee, which is why it is REPORTED
          // rather than applied quietly (#345 surfaces it in the UI).
          rollbackMode = 'pre_restore_dump';
          downgradeReason =
            'Not enough free disk to retain the pre-swap database alongside the restore; ' +
            'rollback mode was downgraded to pre_restore_dump, so rolling back becomes a full restore (hours) rather than a rename (seconds).';
          checks.push({
            key: 'rollback.downgraded',
            label: 'Rollback mode downgraded',
            status: 'warning',
            message: downgradeReason,
            actionItem:
              'Free space on the Postgres volume to keep instant rollback available.',
          });
        }

        // --- replicas ---------------------------------------------------------
        checks.push(await this.checkReplicas(client, ctx.pg));
      });
    } catch (err) {
      // Cannot even reach the maintenance database — no CREATE DATABASE, no
      // rename, no swap. Treat exactly like a failed capability probe.
      capabilityFailed = true;
      checks.push({
        key: 'capability.admin_connection',
        label: 'Cluster admin connection',
        status: 'blocked',
        message: `Could not connect to the ${resolveMaintenanceDatabase()} maintenance database: ${errorMessage(err)}`,
        actionItem:
          'The swap renames databases, which requires a connection to another database in the same cluster.',
      });
    }

    // --- schema compatibility ------------------------------------------------
    checks.push(
      await this.checkSchemaCompatibility(run.migrationName, ctx.overrideSchemaCheck),
    );

    // --- artifact (metadata only here; bytes are verified in the async phase) --
    checks.push({
      key: 'artifact.recorded',
      label: 'Artifact metadata',
      status: 'ok',
      message:
        'Checksum and `pg_restore --list` are re-verified against the downloaded bytes before the scratch database is created.',
    });

    const blocked = checks.some((c) => c.status === 'blocked');
    const status: RestorePreflightReport['status'] = capabilityFailed
      ? 'guided'
      : blocked
        ? 'blocked'
        : 'ok';

    return {
      status,
      checks,
      rollbackMode,
      rollbackModeRequested: requested,
      rollbackModeDowngraded: rollbackMode !== requested,
      downgradeReason,
      scratchDatabase: ctx.scratchDatabase,
      oldDatabase: ctx.oldDatabase,
    };
  }

  /**
   * Free-disk gate: ~1× the live database for the scratch copy, plus another
   * ~1× if the pre-swap database is to be retained, plus the artifact itself in
   * the temp filesystem.
   *
   * Honest about its own blind spot: the free-space number comes from
   * `statfs` on the Postgres data directory AS SEEN FROM THIS PROCESS. When the
   * database is on another host (managed Postgres) the directory is unreadable
   * or meaningless, and the check degrades to a WARNING rather than pretending
   * to know. A wrong "blocked" here would be worse than an honest "unknown".
   */
  private async checkDisk(
    client: AdminClientLike,
    pg: PgConnectionConfig,
    mode: RestoreRollbackMode,
    run: { sizeBytes: bigint | null },
  ): Promise<{ check: PreflightCheck; insufficient: boolean }> {
    let dbSize = 0n;
    try {
      dbSize = await readDatabaseSizeBytes(client, pg.database);
    } catch {
      // Fall through: reported as unknown below.
    }

    const copies = mode === 'retain_database' ? 2n : 1n;
    const required =
      (dbSize * copies * BigInt(Math.round(DISK_HEADROOM_FACTOR * 100))) / 100n +
      (run.sizeBytes ?? 0n);

    const dataDir = await readDataDirectory(client);
    const free = dataDir ? await freeBytes(dataDir) : null;

    if (dbSize === 0n || free === null) {
      return {
        insufficient: false,
        check: {
          key: 'disk.free',
          label: 'Free disk on the Postgres volume',
          status: 'warning',
          message:
            'Could not measure free space on the database volume (managed Postgres, or the data directory is not visible from the API container). ' +
            `The restore needs roughly ${formatBytes(required)} free.`,
          actionItem: 'Confirm free space on the database host manually.',
        },
      };
    }

    const ok = free >= required;
    return {
      insufficient: !ok,
      check: {
        key: 'disk.free',
        label: 'Free disk on the Postgres volume',
        status: ok ? 'ok' : 'warning',
        message: ok
          ? `${formatBytes(free)} free, ~${formatBytes(required)} required`
          : `Only ${formatBytes(free)} free, ~${formatBytes(required)} required for ${mode === 'retain_database' ? 'a scratch copy plus the retained pre-swap database' : 'the scratch copy'}`,
        actionItem: ok ? undefined : 'Free space on the Postgres volume.',
      },
    };
  }

  private async checkReplicas(
    client: AdminClientLike,
    pg: PgConnectionConfig,
  ): Promise<PreflightCheck> {
    let distinct = 0;
    try {
      distinct = await countDistinctClientAddresses(client, pg.database);
    } catch {
      distinct = 0;
    }

    if (distinct > 1) {
      return {
        key: 'replicas.single',
        label: 'Single API replica',
        status: 'warning',
        message: `${distinct} distinct client addresses are connected to ${pg.database}. The swap assumes a SINGLE API replica — other replicas will be terminated mid-request and will then talk to a renamed database.`,
        actionItem: 'Scale the API to one replica before swapping.',
      };
    }

    return {
      key: 'replicas.single',
      label: 'Single API replica',
      status: 'ok',
      message:
        'No evidence of additional API replicas (heuristic: distinct client addresses).',
    };
  }

  /**
   * Compare the archive's `migrationName` with the latest migration APPLIED to
   * the live database — the schema the running code is operating against.
   *
   * Reading the shipped `prisma/migrations` directory would be a more literal
   * reading of "what the code expects", but it is not reliably present in every
   * deployment image, whereas `_prisma_migrations` in the live database always
   * is and is by definition in sync with the running code.
   *
   * BLOCKING by default in BOTH directions: an archive behind the code leaves
   * the schema missing columns the code reads, and an archive AHEAD of the code
   * is a downgrade with its own hazards. The override is the documented
   * "restore old data, then `prisma migrate deploy`" path.
   */
  private async checkSchemaCompatibility(
    archiveMigration: string | null,
    override: boolean,
  ): Promise<PreflightCheck> {
    const current = await this.readLatestMigrationName();

    if (!archiveMigration || !current) {
      return {
        key: 'schema.compatible',
        label: 'Schema compatibility',
        status: 'warning',
        message:
          'Could not compare migrations (the backup or the live database has no recorded migration name).',
        actionItem: 'Run `prisma migrate deploy` after the swap if the app misbehaves.',
      };
    }

    if (archiveMigration === current) {
      return {
        key: 'schema.compatible',
        label: 'Schema compatibility',
        status: 'ok',
        message: `Archive and live database are both at ${current}`,
      };
    }

    return {
      key: 'schema.compatible',
      label: 'Schema compatibility',
      status: override ? 'warning' : 'blocked',
      message: `Archive was taken at migration ${archiveMigration}; the running code is at ${current}.${
        override ? ' Overridden by the caller.' : ''
      }`,
      actionItem:
        'Restore with the override, then run `prisma migrate deploy` to roll the schema forward.',
    };
  }

  // -------------------------------------------------------------------------
  // Guided restore
  // -------------------------------------------------------------------------

  /**
   * A ready-to-paste, fully parameterised command block.
   *
   * This is a DESIGNED-IN PATH, not an error message: when the deployment
   * cannot let the app create databases (managed Postgres with a restricted
   * role) the correct answer is to hand the admin the exact procedure, not to
   * refuse. Note the password never appears — `PGPASSWORD` is referenced as an
   * environment variable the operator sets, matching the same rule the dump
   * engine enforces for argv.
   */
  private buildGuidedPayload(
    run: {
      id: string;
      storageProvider: string | null;
      storageKey: string | null;
      bucket: string | null;
      checksumSha256: string | null;
    },
    pg: PgConnectionConfig,
    preflight: RestorePreflightReport,
  ): GuidedRestorePayload {
    const jobs = resolveParallelJobs();
    const conn = `-h ${pg.host} -p ${pg.port} -U ${pg.user}`;
    const maintenanceDb = resolveMaintenanceDatabase();

    return {
      reason: preflight.checks
        .filter((c) => c.status === 'blocked')
        .map((c) => c.message)
        .join('; '),
      runbook: RESTORE_RUNBOOK_PATH,
      commands: [
        '# 0. Export the database password once; never pass it in argv.',
        'export PGPASSWORD=<the POSTGRES_PASSWORD value>',
        '',
        `# 1. Download the archive (${run.storageProvider}${run.bucket ? `:${run.bucket}` : ''}).`,
        `#    Key: ${run.storageKey}`,
        '#    Use the admin UI download link, or your provider CLI.',
        '',
        '# 2. Verify the bytes BEFORE touching the cluster.',
        `sha256sum ./restore.dump   # expect ${run.checksumSha256 ?? '(no checksum recorded)'}`,
        'pg_restore --list ./restore.dump | head',
        '',
        '# 3. Create the scratch database (needs CREATEDB).',
        `createdb ${conn} ${preflight.scratchDatabase}`,
        '',
        '# 4. Restore into the SCRATCH database. The app keeps serving throughout.',
        `pg_restore ${conn} -d ${preflight.scratchDatabase} -j ${jobs} --no-owner --no-acl --exit-on-error ./restore.dump`,
        '',
        '# 5. Stop the API, then swap (seconds). Renames must run from another database.',
        `psql ${conn} -d ${maintenanceDb} -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${pg.database}' AND pid <> pg_backend_pid();"`,
        `psql ${conn} -d ${maintenanceDb} -c 'ALTER DATABASE "${pg.database}" RENAME TO "${preflight.oldDatabase}";'`,
        `psql ${conn} -d ${maintenanceDb} -c 'ALTER DATABASE "${preflight.scratchDatabase}" RENAME TO "${pg.database}";'`,
        '',
        '# 6. Start the API again. If the archive predates the running code:',
        '#    cd apps/api && npm run prisma:migrate',
        '',
        '# 7. Rollback, if needed (seconds):',
        `psql ${conn} -d ${maintenanceDb} -c 'ALTER DATABASE "${pg.database}" RENAME TO "${preflight.scratchDatabase}";'`,
        `psql ${conn} -d ${maintenanceDb} -c 'ALTER DATABASE "${preflight.oldDatabase}" RENAME TO "${pg.database}";'`,
      ],
      notes: [
        'The live database is untouched until step 5, so steps 1–4 can be abandoned at any time.',
        `The backup catalog inside the archive is as of backup time: rows for backups taken since (including this restore) will not be present after the swap. Re-add them from ${pg.database} before renaming if you need the history.`,
        'The swap assumes a single API replica.',
        `Full procedure and rollback detail: ${RESTORE_RUNBOOK_PATH}`,
      ],
    };
  }

  // -------------------------------------------------------------------------
  // The restore itself
  // -------------------------------------------------------------------------

  private async executeRestore(
    runId: string,
    ctx: {
      pg: PgConnectionConfig;
      scratchDatabase: string;
      oldDatabase: string;
      rollbackMode: RestoreRollbackMode;
      userId: string;
    },
  ): Promise<void> {
    const tmpPath = path.join(
      os.tmpdir(),
      // `memoriaHub-` prefix so TempFileJanitorTask reaps it if we are SIGKILLed.
      `memoriaHub-dbrestore-${runId}.dump`,
    );
    let scratchCreated = false;

    try {
      // --- 1. artifact: download + checksum + TOC --------------------------
      await this.downloadAndVerifyArtifact(runId, tmpPath, ctx.pg);

      // --- 2. pre-restore dump (safety net for the non-retaining mode) ------
      if (ctx.rollbackMode === 'pre_restore_dump') {
        await this.takePreRestoreDump(runId, ctx.userId);
      }

      // --- 3. scratch database ----------------------------------------------
      await withAdminConnection(ctx.pg, async (client) => {
        await createDatabase(client, ctx.scratchDatabase);
      });
      scratchCreated = true;

      // --- 4. the long part -------------------------------------------------
      await this.runPgRestore(tmpPath, ctx.pg, ctx.scratchDatabase);

      // --- 5. verify ---------------------------------------------------------
      await this.writeRestoreState(runId, { restoreStatus: 'verifying' });
      await this.verifyScratchDatabase(ctx.pg, ctx.scratchDatabase);

      // --- 6. swap -----------------------------------------------------------
      await this.swap(runId, ctx);
    } catch (err) {
      // The live database has not been touched at this point in any failure
      // path that reaches here — the swap has its own inner recovery. All that
      // is owed is an honest record and no orphaned scratch database.
      await this.markRestoreFailed(runId, err);
      if (scratchCreated) {
        await this.dropScratchQuietly(ctx.pg, ctx.scratchDatabase);
      }
      throw err;
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Download the archive to local disk, hashing on the same single pass, then
   * re-run `pg_restore --list` over the real bytes.
   *
   * Both halves matter and neither is redundant with #341's backup-time
   * verification: that one proved the bytes were readable WHEN UPLOADED, while
   * this one proves they are readable NOW — the failure it guards against
   * (bit-rot, a truncated download, a provider-side lifecycle rule) can only
   * have happened since.
   *
   * The download to disk is also not optional: `pg_restore -j` needs a seekable
   * file, so a streaming restore would forfeit all parallelism on the phase
   * that dominates the run.
   */
  private async downloadAndVerifyArtifact(
    runId: string,
    tmpPath: string,
    pg: PgConnectionConfig,
  ): Promise<void> {
    const run = await this.prisma.databaseBackupRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        storageProvider: true,
        storageKey: true,
        bucket: true,
        checksumSha256: true,
      },
    });

    const provider = await this.providerResolver.getProviderFor(
      run.storageProvider!,
      run.bucket,
    );
    const source = await provider.download(run.storageKey!);

    const hash = createHash('sha256');
    source.on('data', (chunk: Buffer) => hash.update(chunk));
    await pipeline(source, createWriteStream(tmpPath));

    const digest = hash.digest('hex');
    if (run.checksumSha256 && digest !== run.checksumSha256) {
      throw new Error(
        `Artifact checksum mismatch: expected ${run.checksumSha256}, downloaded ${digest}`,
      );
    }

    const list = spawnPgRestoreListFile(pg, tmpPath, {
      timeoutMs: this.numberFromEnv(
        'DB_RESTORE_PG_RESTORE_LIST_TIMEOUT_MS',
        DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS,
      ),
    });
    let tocBytes = 0;
    list.stdout?.on('data', (chunk: Buffer | string) => {
      tocBytes += chunk.length;
    });
    list.stdout?.on('error', () => {});
    await list.done;

    if (tocBytes === 0) {
      throw new Error(
        'pg_restore --list produced an empty table of contents; the downloaded archive is not readable',
      );
    }
  }

  /**
   * `pre_restore_dump` mode: take a fresh backup of the LIVE database before it
   * is renamed away, so there is still a way back once the old database is
   * dropped. Reuses #341's engine wholesale — a second dump implementation for
   * this one caller would be a second thing to keep correct.
   *
   * Recorded on the run being restored FROM (`preRestoreBackupId`), which is
   * what makes the safety net discoverable later from the run that caused it.
   */
  private async takePreRestoreDump(runId: string, userId: string): Promise<void> {
    this.logger.log(
      `Taking a pre-restore safety backup before restoring ${runId} (rollbackMode=pre_restore_dump)`,
    );
    const result = await this.backupRunner.runBackup({
      trigger: DatabaseBackupTrigger.pre_restore,
      createdById: userId,
    });
    await this.writeRestoreState(runId, { preRestoreBackupId: result.runId });
  }

  private async runPgRestore(
    filePath: string,
    pg: PgConnectionConfig,
    database: string,
  ): Promise<void> {
    const jobs = resolveParallelJobs();
    const exitOnError = resolveExitOnError();
    if (!exitOnError) {
      this.logger.warn(
        'PG_RESTORE_EXIT_ON_ERROR=false — pg_restore will continue past per-object errors; verify the restored database carefully',
      );
    }

    this.logger.log(
      `Restoring into ${database} with -j ${jobs}; this rebuilds every HNSW index and can take hours. The application stays up throughout.`,
    );

    const restore = spawnPgRestore(
      pg,
      { database, filePath, jobs, exitOnError },
      {
        timeoutMs: this.numberFromEnv(
          'DB_RESTORE_PG_RESTORE_TIMEOUT_MS',
          DEFAULT_PG_RESTORE_TIMEOUT_MS,
        ),
      },
    );
    // Progress chatter must be drained or a full stdout pipe stalls the child.
    restore.stdout?.on('data', () => {});
    restore.stdout?.on('error', () => {});
    await restore.done;
  }

  /**
   * Prove the scratch database is actually usable BEFORE swapping it in.
   *
   * Four properties, each corresponding to a way a restore can complete without
   * being correct: the extension is missing (vector columns unusable), tables
   * are missing (schema phase failed), the data is empty (an archive of the
   * wrong database, or a restore that loaded nothing), or an index is still
   * invalid (a build that failed — the exact phase that dominates the runtime,
   * and the one whose failure a `--exit-on-error`-less run would hide).
   */
  private async verifyScratchDatabase(
    pg: PgConnectionConfig,
    scratchDatabase: string,
  ): Promise<void> {
    await withAdminConnection(
      pg,
      async (client) => {
        const ext = await client.query<{ ok: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok",
        );
        if (!ext.rows[0]?.ok) {
          throw new Error(
            'Restored database is missing the `vector` extension; refusing to swap',
          );
        }

        const tables = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ANY($1)`,
          [REQUIRED_TABLES],
        );
        const found = new Set(tables.rows.map((r) => r.table_name));
        const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
        if (missing.length > 0) {
          throw new Error(
            `Restored database is missing expected tables: ${missing.join(', ')}; refusing to swap`,
          );
        }

        const users = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM users',
        );
        if (Number(users.rows[0]?.count ?? '0') < 1) {
          throw new Error(
            'Restored database contains no users; refusing to swap an apparently empty restore',
          );
        }

        const invalid = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
            WHERE NOT i.indisvalid AND c.relnamespace = 'public'::regnamespace`,
        );
        if (Number(invalid.rows[0]?.count ?? '0') > 0) {
          throw new Error(
            `Restored database has ${invalid.rows[0]?.count} invalid index(es) — an index build did not complete; refusing to swap`,
          );
        }
      },
      { database: scratchDatabase },
    );
  }

  /**
   * The seconds-long destructive window.
   *
   * ORDERING IS THE WHOLE DESIGN:
   *   1. Export the catalog while the live database still answers.
   *   2. Maintenance mode ON, via the IN-MEMORY override with admins blocked —
   *      the persisted flag lives in `system_settings`, i.e. inside the database
   *      about to be renamed, so it is unreadable at exactly this moment. That
   *      is why #348 has two layers.
   *   3. Disconnect the Prisma pool, then terminate whatever is left: a rename
   *      fails while any session holds the database open.
   *   4. Rename live → old, then scratch → live. Between those two statements
   *      there is no `<live>` database at all; that gap is why traffic must
   *      already be stopped.
   *   5. Re-insert the carried-over catalog into the NEW live database.
   *   6. Exit, so the orchestrator restarts with a pool bound to the new
   *      database (the old pool's connections are dead and its cached state
   *      describes a database that no longer exists under that name).
   */
  private async swap(
    runId: string,
    ctx: {
      pg: PgConnectionConfig;
      scratchDatabase: string;
      oldDatabase: string;
      rollbackMode: RestoreRollbackMode;
      userId: string;
    },
  ): Promise<void> {
    await this.writeRestoreState(runId, { restoreStatus: 'swapping' });

    const swappedAt = new Date();
    const catalog = await this.exportCatalog(runId, {
      restoreStatus: 'completed',
      restoreScratchDb: ctx.scratchDatabase,
      restoreOldDb: ctx.rollbackMode === 'retain_database' ? ctx.oldDatabase : null,
      restoredAt: swappedAt,
      restoredById: ctx.userId,
      swappedAt,
    });

    await this.maintenance.enable(
      'Restoring the database. The application will be back in a moment.',
      ctx.userId,
      // Even an admin request would hit a database that is momentarily gone.
      { allowAdmins: false },
    );

    await withAdminConnection(ctx.pg, async (client) => {
      await this.prisma.$disconnect().catch(() => {});
      await terminateConnections(client, ctx.pg.database);

      await renameDatabase(client, ctx.pg.database, ctx.oldDatabase);
      try {
        await renameDatabase(client, ctx.scratchDatabase, ctx.pg.database);
      } catch (err) {
        // The only genuinely dangerous moment in the whole design: the live
        // database has been renamed away and its replacement did not land.
        // Put the original back rather than leaving the deployment with no
        // database under the expected name.
        this.logger.error(
          `Second rename failed; restoring ${ctx.oldDatabase} back to ${ctx.pg.database}`,
        );
        await renameDatabase(client, ctx.oldDatabase, ctx.pg.database).catch(
          (inner) =>
            this.logger.error(
              `CRITICAL: could not restore ${ctx.oldDatabase} to ${ctx.pg.database}: ${errorMessage(inner)}`,
            ),
        );
        throw err;
      }

      await this.reinsertCatalog(ctx.pg, catalog);

      if (ctx.rollbackMode === 'pre_restore_dump') {
        // The safety net is the dump, not the database; keeping both would
        // defeat the entire point of this mode (no extra Postgres disk).
        await dropDatabase(client, ctx.oldDatabase).catch((err) =>
          this.logger.warn(
            `Could not drop ${ctx.oldDatabase} after the swap: ${errorMessage(err)}`,
          ),
        );
      }
    });

    this.logger.warn(
      `Database restore ${runId} swapped in. Exiting so the orchestrator restarts with a clean pool — the deployment MUST set a restart policy.`,
    );
    this.exitProcess(0);
  }

  // -------------------------------------------------------------------------
  // Catalog carry-over
  // -------------------------------------------------------------------------

  /**
   * Snapshot `database_backup_runs` from the LIVE database, with this run's
   * restore-audit fields already updated to their post-swap values.
   *
   * They have to be applied here rather than written to the live row: the live
   * row is about to be renamed out of existence, and the copy that survives is
   * the one carried across. Writing "restore completed" to a database nobody
   * will ever open again is the mistake the whole carry-over exists to avoid.
   */
  private async exportCatalog(
    runId: string,
    overrides: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.databaseBackupRun.findMany({
      orderBy: { startedAt: 'asc' },
    });
    return rows.map((row) =>
      row.id === runId
        ? ({ ...row, ...overrides } as Record<string, unknown>)
        : (row as unknown as Record<string, unknown>),
    );
  }

  /**
   * Re-insert the carried-over catalog into the newly-renamed live database.
   *
   * Three deliberate details:
   *   - `ON CONFLICT (id) DO UPDATE`: the restored database already contains
   *     rows for every backup that existed at backup time, and the carried-over
   *     copy — which knows about this restore — must win.
   *   - User FKs are resolved through `(SELECT id FROM users WHERE id = $n)`,
   *     which yields NULL for a user created after the archive was taken. A
   *     plain insert would raise a foreign-key violation and abort the whole
   *     carry-over at the worst possible moment.
   *   - `pre_restore_backup_id` (a self-FK) is applied in a SECOND pass, since
   *     the row it points at may not have been inserted yet during the first.
   *
   * Runs over its OWN short-lived connection to the (newly renamed) live
   * database rather than Prisma: the Prisma pool has just been disconnected and
   * its client is bound to a database name whose meaning changed a moment ago.
   * The caller's maintenance connection cannot be reused either — it is
   * attached to the `postgres` database, not to the one these rows belong in.
   */
  private async reinsertCatalog(
    pg: PgConnectionConfig,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;

    await withAdminConnection(
      pg,
      async (live) => {
        for (const row of rows) {
          try {
            await live.query(
              `INSERT INTO database_backup_runs (
                 id, status, trigger, started_at, finished_at, last_heartbeat_at,
                 bytes_written, size_bytes, storage_provider, storage_key, bucket,
                 format, checksum_sha256, db_version, app_version, migration_name,
                 verified_at, last_error, created_by_id,
                 restore_status, restore_error, restored_at, restored_by_id,
                 restore_scratch_db, restore_old_db, swapped_at
               ) VALUES (
                 $1::uuid, $2::"DatabaseBackupStatus", $3::"DatabaseBackupTrigger",
                 $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18,
                 (SELECT id FROM users WHERE id = $19::uuid),
                 $20, $21, $22,
                 (SELECT id FROM users WHERE id = $23::uuid),
                 $24, $25, $26
               )
               ON CONFLICT (id) DO UPDATE SET
                 status = EXCLUDED.status,
                 finished_at = EXCLUDED.finished_at,
                 bytes_written = EXCLUDED.bytes_written,
                 size_bytes = EXCLUDED.size_bytes,
                 storage_provider = EXCLUDED.storage_provider,
                 storage_key = EXCLUDED.storage_key,
                 bucket = EXCLUDED.bucket,
                 checksum_sha256 = EXCLUDED.checksum_sha256,
                 verified_at = EXCLUDED.verified_at,
                 last_error = EXCLUDED.last_error,
                 restore_status = EXCLUDED.restore_status,
                 restore_error = EXCLUDED.restore_error,
                 restored_at = EXCLUDED.restored_at,
                 restored_by_id = EXCLUDED.restored_by_id,
                 restore_scratch_db = EXCLUDED.restore_scratch_db,
                 restore_old_db = EXCLUDED.restore_old_db,
                 swapped_at = EXCLUDED.swapped_at`,
              [
                row.id,
                row.status,
                row.trigger,
                row.startedAt ?? null,
                row.finishedAt ?? null,
                row.lastHeartbeatAt ?? null,
                bigintToParam(row.bytesWritten) ?? '0',
                bigintToParam(row.sizeBytes),
                row.storageProvider ?? null,
                row.storageKey ?? null,
                row.bucket ?? null,
                row.format ?? null,
                row.checksumSha256 ?? null,
                row.dbVersion ?? null,
                row.appVersion ?? null,
                row.migrationName ?? null,
                row.verifiedAt ?? null,
                row.lastError ?? null,
                row.createdById ?? null,
                row.restoreStatus ?? null,
                row.restoreError ?? null,
                row.restoredAt ?? null,
                row.restoredById ?? null,
                row.restoreScratchDb ?? null,
                row.restoreOldDb ?? null,
                row.swappedAt ?? null,
              ],
            );
          } catch (err) {
            // One unrepresentable row must not cost the entire catalog.
            this.logger.warn(
              `Could not carry over backup catalog row ${String(row.id)}: ${errorMessage(err)}`,
            );
          }
        }

        for (const row of rows) {
          if (!row.preRestoreBackupId) continue;
          await live
            .query(
              `UPDATE database_backup_runs
                  SET pre_restore_backup_id = $2::uuid
                WHERE id = $1::uuid
                  AND EXISTS (SELECT 1 FROM database_backup_runs r WHERE r.id = $2::uuid)`,
              [row.id, row.preRestoreBackupId],
            )
            .catch(() => {});
        }
      },
      { database: pg.database },
    );
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private async assertNoRestoreInProgress(): Promise<void> {
    const active = await this.prisma.databaseBackupRun.findFirst({
      where: { restoreStatus: { in: ACTIVE_RESTORE_STATUSES } },
      select: { id: true },
    });
    if (active) throw new DatabaseRestoreAlreadyRunningError(active.id);
  }

  private async writeRestoreState(
    runId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.databaseBackupRun.update({
        where: { id: runId },
        data: data as never,
      });
    } catch (err) {
      this.logger.warn(
        `Could not update restore state for ${runId}: ${errorMessage(err)}`,
      );
    }
  }

  private async markRestoreFailed(runId: string, cause: unknown): Promise<void> {
    const message = errorMessage(cause).slice(0, MAX_RESTORE_ERROR_CHARS);
    this.logger.error(`Database restore ${runId} failed: ${message}`);
    await this.writeRestoreState(runId, {
      restoreStatus: 'failed',
      restoreError: message,
    });
  }

  /**
   * Remove the scratch database after a failure.
   *
   * Best-effort, and never allowed to mask the original error — but genuinely
   * important: a several-hundred-GB abandoned database is the most expensive
   * kind of leak this feature can produce, and it is invisible in the UI.
   */
  private async dropScratchQuietly(
    pg: PgConnectionConfig,
    scratchDatabase: string,
  ): Promise<void> {
    try {
      await withAdminConnection(pg, async (client) => {
        await dropDatabase(client, scratchDatabase);
      });
      this.logger.log(`Dropped scratch database ${scratchDatabase} after failure`);
    } catch (err) {
      this.logger.error(
        `Could not drop scratch database ${scratchDatabase}: ${errorMessage(err)}`,
      );
    }
  }

  private async resolveRollbackMode(): Promise<RestoreRollbackMode> {
    try {
      const settings = (await this.systemSettings.getSettings()) as any;
      const mode = settings?.databaseBackup?.restoreRollbackMode;
      return mode === 'pre_restore_dump' ? 'pre_restore_dump' : 'retain_database';
    } catch {
      return 'retain_database';
    }
  }

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
    } catch {
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
// Pure helpers
// ---------------------------------------------------------------------------

/** `statfs` free bytes for the filesystem holding `dir`; null when unknowable. */
async function freeBytes(dir: string): Promise<bigint | null> {
  try {
    const stats = await (fsp as any).statfs(dir);
    return BigInt(stats.bavail) * BigInt(stats.bsize);
  } catch {
    return null;
  }
}

function formatBytes(bytes: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** BigInt columns cross the `pg` boundary as strings (never as JS BigInt). */
function bigintToParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseBackupRun, DatabaseBackupStatus } from '@prisma/client';

import {
  assertSupportedTimeZone,
  wallClockParts,
  wallClockToUtc,
} from '../common/time/zone.util';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { getStorageProviderDescriptor } from '../storage-settings/providers/storage-provider.registry';
import { DatabaseBackupRunnerService } from './database-backup-runner.service';
import { DatabaseBackupAlreadyRunningError } from './db-backup.errors';
import type { UpdateDatabaseBackupConfigDto } from './dto/db-backup-config.dto';
import type {
  DownloadDatabaseBackupDto,
  ListDatabaseBackupRunsDto,
} from './dto/db-backup-runs.dto';

/** Fallback signed-URL lifetime, matching `ObjectsService.getDownloadUrl`. */
const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 3600;

/** Statuses that still hold the single-active-run slot. */
const ACTIVE_STATUSES: DatabaseBackupStatus[] = ['pending', 'running'];

/**
 * Shape returned for a single run. Every BigInt column is a STRING here —
 * `bytesWritten` and `sizeBytes` are Prisma `BigInt`s and `JSON.stringify`
 * throws on a raw one, so a Prisma row must never be returned directly. See
 * CLAUDE.md's BigInt gotcha.
 */
export interface DatabaseBackupRunDto {
  id: string;
  status: DatabaseBackupStatus;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  verifiedAt: string | null;
  /** Wall time from start to finish (or to now, while still running). */
  elapsedMs: number | null;
  bytesWritten: string;
  sizeBytes: string | null;
  storageProvider: string | null;
  storageKey: string | null;
  bucket: string | null;
  format: string | null;
  checksumSha256: string | null;
  dbVersion: string | null;
  appVersion: string | null;
  migrationName: string | null;
  lastError: string | null;
  createdById: string | null;
  restoreStatus: string | null;
  restoreError: string | null;
  restoredAt: string | null;
  restoredById: string | null;
  restoreScratchDb: string | null;
  restoreOldDb: string | null;
  swappedAt: string | null;
  preRestoreBackupId: string | null;
}

export interface DatabaseBackupConfigDto {
  config: {
    enabled: boolean;
    frequency: 'daily' | 'weekly' | 'monthly';
    dayOfWeek: number;
    dayOfMonth: number;
    timeOfDay: string;
    timezone: string;
    retentionCount: number;
    storageProvider: string | null;
    runStaleMinutes: number;
    compressionLevel: number;
    restoreRollbackMode: 'retain_database' | 'pre_restore_dump';
    oldDatabaseRetentionHours: number;
  };
  /** Computed next fire time (ISO 8601), or null when disabled/uncomputable. */
  nextRunAt: string | null;
  /** The run currently holding the single-active-run slot, if any. */
  activeRunId: string | null;
}

/**
 * DatabaseBackupAdminService — the HTTP-facing half of the PostgreSQL backup
 * feature (issue #343, epic #339).
 *
 * Holds everything the controller needs that is NOT the dump engine itself:
 * config read/write (delegated to `SystemSettingsService` so there is exactly
 * one settings writer), run listing/detail, signed downloads, deletion, and
 * cancellation. The engine (`DatabaseBackupRunnerService`, #341) is injected,
 * never reimplemented.
 *
 * Restore and rollback are #344's; this service is deliberately built so that
 * work extends it rather than standing up a second admin surface.
 */
@Injectable()
export class DatabaseBackupAdminService {
  private readonly logger = new Logger(DatabaseBackupAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemSettings: SystemSettingsService,
    private readonly providerResolver: StorageProviderResolver,
    private readonly runner: DatabaseBackupRunnerService,
  ) {}

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  async getConfig(): Promise<DatabaseBackupConfigDto> {
    const settings = (await this.systemSettings.getSettings()) as any;
    const config = settings.databaseBackup as DatabaseBackupConfigDto['config'];

    const active = await this.prisma.databaseBackupRun.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      select: { id: true },
      orderBy: { startedAt: 'desc' },
    });

    return {
      config,
      nextRunAt: computeNextRunAt(config, new Date())?.toISOString() ?? null,
      activeRunId: active?.id ?? null,
    };
  }

  /**
   * Partial update of the `databaseBackup.*` namespace.
   *
   * Two checks run BEFORE the write, both because a bad value here fails
   * silently and invisibly hours later rather than at save time:
   *   - an unknown IANA `timezone` would make every schedule computation throw
   *   - a `storageProvider` that is not configured-and-enabled is a schedule
   *     pointing at a dead destination: the cron fires, the dump runs, and the
   *     upload fails every time
   */
  async updateConfig(
    dto: UpdateDatabaseBackupConfigDto,
    userId: string,
  ): Promise<DatabaseBackupConfigDto> {
    if (dto.timezone !== undefined) {
      assertSupportedTimeZone(dto.timezone);
    }

    if (dto.storageProvider) {
      await this.assertUsableStorageProvider(dto.storageProvider);
    }

    await this.systemSettings.patchSettings(
      { databaseBackup: dto } as any,
      userId,
    );

    return this.getConfig();
  }

  /**
   * A provider is usable when it is enabled AND actually configured — with the
   * one carve-out that a provider whose descriptor declares
   * `requiresCredentials: false` (local disk) needs no credential row at all.
   */
  private async assertUsableStorageProvider(provider: string): Promise<void> {
    const descriptor = getStorageProviderDescriptor(provider);
    if (!descriptor) {
      throw new BadRequestException(
        `Unknown storage provider "${provider}"`,
      );
    }

    const credential = await this.prisma.storageProviderCredential.findUnique({
      where: { provider },
      select: { enabled: true },
    });

    if (!credential) {
      if (!descriptor.requiresCredentials) return;
      throw new BadRequestException(
        `Storage provider "${provider}" is not configured; configure it before pointing database backups at it`,
      );
    }

    if (!credential.enabled) {
      throw new BadRequestException(
        `Storage provider "${provider}" is disabled; enable it before pointing database backups at it`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Trigger a manual backup and return IMMEDIATELY.
   *
   * The claim is awaited (so the caller gets a real id, or the 409), the dump
   * is not. The detached promise is given a terminal `.catch()` right here:
   * `runner.startBackup` already records the failure on the run row, so this
   * handler exists purely so an expected rejection cannot surface as an
   * unhandled rejection and take the process down.
   */
  async startRun(userId: string): Promise<{ runId: string; status: string }> {
    try {
      const { runId, completion } = await this.runner.startBackup({
        trigger: 'manual',
        createdById: userId,
      });

      completion.catch((err: unknown) => {
        this.logger.warn(
          `Manual database backup ${runId} failed: ${errorMessage(err)}`,
        );
      });

      return { runId, status: 'running' };
    } catch (err) {
      if (err instanceof DatabaseBackupAlreadyRunningError) {
        // `activeRunId` MUST go inside `details`. The app-wide
        // `HttpExceptionFilter` rebuilds the response body from a fixed
        // allowlist (message, code, details, error, error_description,
        // startedAt) — a top-level custom field on the payload is silently
        // dropped and never reaches the client.
        throw new ConflictException({
          message: 'A database backup run is already in progress',
          details: { activeRunId: err.activeRunId },
        });
      }
      throw err;
    }
  }

  async listRuns(query: ListDatabaseBackupRunsDto): Promise<{
    items: DatabaseBackupRunDto[];
    meta: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = query.status ? { status: query.status } : {};

    const [rows, totalItems] = await Promise.all([
      this.prisma.databaseBackupRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.databaseBackupRun.count({ where }),
    ]);

    return {
      items: rows.map((r) => toRunDto(r)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
      },
    };
  }

  async getRun(id: string): Promise<DatabaseBackupRunDto> {
    return toRunDto(await this.loadRun(id));
  }

  /**
   * Signed download URL for a completed backup.
   *
   * Resolves the provider RECORDED ON THE RUN, never the currently-active one:
   * an admin who switches storage providers must still be able to download the
   * backups taken before the switch. Same reasoning (and same
   * `getProviderFor(provider, bucket)` call) as `StorageObject.storageProvider`
   * in `ObjectsService.getDownloadUrl`.
   */
  async getDownloadUrl(
    id: string,
    query: DownloadDatabaseBackupDto,
  ): Promise<{ url: string; expiresIn: number }> {
    const run = await this.loadRun(id);

    if (run.status !== 'completed') {
      throw new BadRequestException(
        `Backup is not downloadable. Current status: ${run.status}`,
      );
    }

    if (!run.storageProvider || !run.storageKey) {
      throw new BadRequestException(
        'Backup has no recorded storage location to download from',
      );
    }

    const expiresIn =
      query.expiresIn ??
      this.config.get<number>(
        'storage.signedUrlExpiry',
        DEFAULT_DOWNLOAD_EXPIRY_SECONDS,
      );

    const provider = await this.providerResolver.getProviderFor(
      run.storageProvider,
      run.bucket,
    );

    const url = await provider.getSignedDownloadUrl(run.storageKey, {
      expiresIn,
    });

    return { url, expiresIn };
  }

  /**
   * Delete a run: the storage object FIRST (via the recorded provider), then
   * the row.
   *
   * That order matters — dropping the row first would orphan a multi-GB object
   * nothing points at any more. Object deletion is best-effort: an object
   * already gone (or a provider that can no longer be resolved) must not leave
   * an undeletable row behind, so the failure is logged and the row still goes.
   *
   * A `pending`/`running` row is refused: it holds the single-active-run slot
   * and its bytes are still being written. Cancel it first.
   */
  async deleteRun(id: string): Promise<{ deleted: true; objectDeleted: boolean }> {
    const run = await this.loadRun(id);

    if (ACTIVE_STATUSES.includes(run.status)) {
      throw new BadRequestException(
        `Cannot delete a backup with status "${run.status}"; cancel it first`,
      );
    }

    let objectDeleted = false;
    if (run.storageProvider && run.storageKey) {
      try {
        const provider = await this.providerResolver.getProviderFor(
          run.storageProvider,
          run.bucket,
        );
        await provider.delete(run.storageKey);
        objectDeleted = true;
      } catch (err) {
        this.logger.warn(
          `Could not delete backup object ${run.storageProvider}:${run.storageKey}: ${errorMessage(err)}`,
        );
      }
    }

    await this.prisma.databaseBackupRun.delete({ where: { id } });

    return { deleted: true, objectDeleted };
  }

  /**
   * Cancel an in-flight run. Delegates to the runner, which owns the child
   * process and the partial-object cleanup.
   */
  async cancelRun(id: string): Promise<{ runId: string; signalled: boolean }> {
    const run = await this.loadRun(id);

    if (!ACTIVE_STATUSES.includes(run.status)) {
      throw new BadRequestException(
        `Backup is not in progress. Current status: ${run.status}`,
      );
    }

    const { signalled } = await this.runner.cancelRun(id);
    return { runId: id, signalled };
  }

  private async loadRun(id: string): Promise<DatabaseBackupRun> {
    const run = await this.prisma.databaseBackupRun.findUnique({
      where: { id },
    });
    if (!run) {
      throw new NotFoundException(`Database backup run ${id} not found`);
    }
    return run;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Map a Prisma row to the wire shape.
 *
 * The ONLY correct way to return a `DatabaseBackupRun`: `bytesWritten` and
 * `sizeBytes` are `BigInt` columns, and `JSON.stringify` throws
 * "Do not know how to serialize a BigInt" on a raw one — a runtime-only failure
 * that object-comparing unit tests happily miss.
 */
export function toRunDto(run: DatabaseBackupRun): DatabaseBackupRunDto {
  const startedMs = run.startedAt?.getTime() ?? null;
  const endMs = run.finishedAt?.getTime() ?? Date.now();

  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    lastHeartbeatAt: iso(run.lastHeartbeatAt),
    verifiedAt: iso(run.verifiedAt),
    elapsedMs: startedMs === null ? null : Math.max(0, endMs - startedMs),
    bytesWritten: run.bytesWritten.toString(),
    sizeBytes: run.sizeBytes === null ? null : run.sizeBytes.toString(),
    storageProvider: run.storageProvider,
    storageKey: run.storageKey,
    bucket: run.bucket,
    format: run.format,
    checksumSha256: run.checksumSha256,
    dbVersion: run.dbVersion,
    appVersion: run.appVersion,
    migrationName: run.migrationName,
    lastError: run.lastError,
    createdById: run.createdById,
    restoreStatus: run.restoreStatus,
    restoreError: run.restoreError,
    restoredAt: iso(run.restoredAt),
    restoredById: run.restoredById,
    restoreScratchDb: run.restoreScratchDb,
    restoreOldDb: run.restoreOldDb,
    swappedAt: iso(run.swappedAt),
    preRestoreBackupId: run.preRestoreBackupId,
  };
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// The time-zone helpers this file used to define privately now live in
// common/time/zone.util.ts (issue #444), since per-user time zones need the
// same validation and the same civil<->UTC conversion. They are re-exported
// here so existing importers of `assertSupportedTimeZone` from this module keep
// working; behavior is unchanged apart from 'UTC' now always being accepted
// (see the util's header — `Intl.supportedValuesOf` omits it on Node 22, and it
// is `databaseBackup.timezone`'s own default).
export {
  assertSupportedTimeZone,
  isSupportedTimeZone,
  wallClockParts,
  zoneOffsetMs,
  wallClockToUtc,
} from '../common/time/zone.util';

/** How far ahead `computeNextRunAt` will search before giving up. */
const MAX_SCHEDULE_LOOKAHEAD_DAYS = 400;

/**
 * Compute the next time the configured schedule fires, as a real UTC instant.
 *
 * This exists so `GET /config` can show an admin what their schedule actually
 * MEANS — "daily at 02:00 America/Costa_Rica" is easy to get wrong, and a
 * concrete next-fire timestamp is the only way to confirm it before waiting a
 * day to find out. It reads config only; it never writes, and it is not a
 * scheduler (the cron that consumes a schedule is #342's).
 *
 * Returns null when backups are disabled — there is no next run to show.
 *
 * The search is a bounded day-by-day walk over wall-clock civil dates rather
 * than closed-form arithmetic, because "the same local time tomorrow" is not a
 * fixed number of milliseconds away across a DST boundary; each candidate day is
 * converted to UTC independently, so every result is correct in its own offset.
 */
export function computeNextRunAt(
  config: DatabaseBackupConfigDto['config'] | null | undefined,
  now: Date,
): Date | null {
  if (!config?.enabled) return null;

  const timeZone = config.timezone || 'UTC';
  let parts: ReturnType<typeof wallClockParts>;
  try {
    parts = wallClockParts(now, timeZone);
  } catch {
    return null;
  }

  const [hh, mm] = (config.timeOfDay || '02:00').split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  // Walk civil dates forward from today, in the configured zone.
  for (let offset = 0; offset <= MAX_SCHEDULE_LOOKAHEAD_DAYS; offset++) {
    const civil = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day + offset),
    );
    const year = civil.getUTCFullYear();
    const month = civil.getUTCMonth() + 1;
    const day = civil.getUTCDate();

    if (config.frequency === 'weekly' && civil.getUTCDay() !== config.dayOfWeek) {
      continue;
    }
    if (config.frequency === 'monthly' && day !== config.dayOfMonth) {
      continue;
    }

    const candidate = wallClockToUtc(year, month, day, hh, mm, timeZone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }

  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// Legacy database-backup data transform (RETRO-D4, #580)
// =============================================================================
//
// Two idempotent steps that move MemoriaHub's pre-platform backup state onto the
// db-backup slice. `scripts/migrate-db-backup-settings.ts` wires them to Postgres
// (`--dry-run` by default, `--apply`); everything here is pure or takes the
// client as an argument, so it is unit-tested with fixtures.
//
// 1. SETTINGS. The `databaseBackup` namespace keeps its key; the platform's shape
//    differs in three places, rewritten in place:
//      storageProvider     null (no pin)          -> ''
//      restoreRollbackMode 'pre_restore_dump'     -> 'drop_database' (the platform name;
//                                                    its effective mode IS pre_restore_dump)
//      nodeOffloadEnabled  absent                 -> false (Open decision 2: off until RETRO-C10)
//    `timezone` and `frequency` are validated (an unknown zone falls back to 'UTC',
//    with a warning), numbers outside the platform's bounds are clamped, and
//    `retentionCount` is mirrored into `retention.count` only when `retention` is
//    already present (the platform alias). The ORIGINAL value is copied once to the
//    top-level key `mhLegacyDatabaseBackup` of the same row (set-if-absent), which
//    no namespace declares and every write carries forward: reverting the release
//    restores it by hand (docs/runbooks/database-restore.md, "Rollback").
//
// 2. RUN HISTORY. Before the slice MemoriaHub wrote `database_backup_runs`; RETRO-A5
//    renamed that table `mh_legacy_database_backup_runs` so the platform's own
//    `database_backup_runs` could be created empty beside it. The rows that point
//    at an archive (a storage key and a provider) are copied into the platform
//    table under their ORIGINAL id with `INSERT ... ON CONFLICT (id) DO NOTHING`,
//    so the history, downloads, restores and retention keep working and a re-run
//    copies nothing twice. Archives are never moved: `storage_key` keeps
//    `db-backups/<stamp>-<runId>.dump`. Rules:
//      - pending/running rows are REFUSED (drain first: no backup or restore in flight);
//      - rows with no storage key (a run that failed before it wrote anything) stay
//        in the legacy table only, counted;
//      - users are re-resolved (`NULL` for a deleted user); the self-link
//        `pre_restore_backup_id` is applied in a second pass, only to a copied row;
//      - `restore_status` values the platform does not publish (MemoriaHub's
//        `guided` / `blocked`) become NULL; the legacy row keeps the original.
//    The legacy table is left untouched; a later migration-lock PR drops it.
// =============================================================================

import { isSupportedTimeZone } from '../common/time/zone.util';

/** The top-level key the original `databaseBackup` value is kept under (set-if-absent). */
export const LEGACY_DATABASE_BACKUP_SETTINGS_KEY = 'mhLegacyDatabaseBackup';

/** The platform's `databaseBackup` frequencies. */
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'cron'] as const;

/** The restore statuses the platform's run DTO publishes. */
export const PLATFORM_RESTORE_STATUSES = ['restoring', 'verifying', 'swapping', 'completed', 'failed', 'rolled_back'] as const;

type Json = Record<string, unknown>;

export interface SettingsTransform {
  /** The value to store under `databaseBackup`. */
  next: Json;
  /** What changed, one line each (no secret: the namespace holds none). */
  changes: string[];
  /** Values that could not be kept as they were. */
  warnings: string[];
  /** Whether `next` differs from the stored value. */
  changed: boolean;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * The stored `databaseBackup` value rewritten into the platform's shape.
 * Idempotent: a value already in the platform's shape comes back unchanged.
 *
 * @param stored - the stored value (`undefined` when the namespace was never written).
 */
export function transformDatabaseBackupSettings(stored: unknown): SettingsTransform {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!isObject(stored)) return { next: {}, changes, warnings, changed: false };

  const next: Json = { ...stored };

  if (next.storageProvider === null || next.storageProvider === undefined) {
    if (next.storageProvider === null) changes.push("storageProvider: null -> '' (no pin)");
    next.storageProvider = '';
  }

  if (next.restoreRollbackMode === 'pre_restore_dump') {
    next.restoreRollbackMode = 'drop_database';
    changes.push("restoreRollbackMode: 'pre_restore_dump' -> 'drop_database'");
  } else if (next.restoreRollbackMode !== undefined && next.restoreRollbackMode !== 'retain_database' && next.restoreRollbackMode !== 'drop_database') {
    warnings.push(`restoreRollbackMode ${JSON.stringify(next.restoreRollbackMode)} is unknown; reset to 'retain_database'`);
    next.restoreRollbackMode = 'retain_database';
  }

  if (next.nodeOffloadEnabled === undefined) {
    next.nodeOffloadEnabled = false;
    changes.push('nodeOffloadEnabled: absent -> false');
  }

  if (next.timezone !== undefined && (typeof next.timezone !== 'string' || !isSupportedTimeZone(next.timezone))) {
    warnings.push(`timezone ${JSON.stringify(next.timezone)} is not a zone this runtime knows; reset to 'UTC'`);
    next.timezone = 'UTC';
  }

  if (next.frequency !== undefined && !(FREQUENCIES as readonly unknown[]).includes(next.frequency)) {
    warnings.push(`frequency ${JSON.stringify(next.frequency)} is unknown; reset to 'daily'`);
    next.frequency = 'daily';
  }

  // The platform's bounds (the old ones were narrower, so a stored value only moves if it was invalid).
  const bounds: Array<[string, number, number]> = [
    ['retentionCount', 1, 365],
    ['runStaleMinutes', 1, 10080],
    ['compressionLevel', 0, 9],
    ['oldDatabaseRetentionHours', 1, 8760],
    ['dayOfWeek', 0, 6],
    ['dayOfMonth', 1, 28],
  ];
  for (const [field, min, max] of bounds) {
    if (next[field] === undefined) continue;
    const clamped = clampInt(next[field], min, max);
    if (clamped === undefined) {
      warnings.push(`${field} ${JSON.stringify(next[field])} is not a number; dropped (the default applies)`);
      delete next[field];
    } else if (clamped !== next[field]) {
      warnings.push(`${field} ${String(next[field])} is outside ${min}..${max}; clamped to ${clamped}`);
      next[field] = clamped;
    }
  }

  if (isObject(next.retention) && typeof next.retentionCount === 'number' && next.retention.count !== next.retentionCount) {
    next.retention = { ...next.retention, count: next.retentionCount };
    changes.push('retention.count mirrored from retentionCount');
  }

  const changed = JSON.stringify(next) !== JSON.stringify(stored);
  return { next, changes, warnings, changed };
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

/** The rows the copy refuses to move (a backup or restore in flight). */
export const LEGACY_ACTIVE_RUNS_SQL = `
SELECT id::text AS id, status::text AS status
FROM mh_legacy_database_backup_runs
WHERE status IN ('pending', 'running')
   OR restore_status IN ('restoring', 'verifying', 'swapping')
ORDER BY started_at NULLS LAST, id`;

/** What the copy would do, counted. */
export const LEGACY_RUN_COUNTS_SQL = `
SELECT
  count(*)::int AS total,
  count(*) FILTER (WHERE l.storage_key IS NOT NULL AND l.storage_provider IS NOT NULL)::int AS with_archive,
  count(*) FILTER (WHERE l.storage_key IS NOT NULL AND l.storage_provider IS NOT NULL
                   AND EXISTS (SELECT 1 FROM database_backup_runs d WHERE d.id = l.id))::int AS already_copied
FROM mh_legacy_database_backup_runs l`;

/**
 * Copies every legacy run that points at an archive into `database_backup_runs`,
 * keeping its id. `ON CONFLICT (id) DO NOTHING` makes it idempotent. The
 * `status`/`trigger` enums have the same values on both sides; casting through
 * text maps the legacy enum types onto the platform's.
 */
export const COPY_LEGACY_RUNS_SQL = `
INSERT INTO database_backup_runs (
  id, status, trigger, started_at, finished_at, last_heartbeat_at,
  bytes_written, size_bytes, storage_provider, storage_key, bucket, format,
  checksum_sha256, db_version, app_version, migration_name, verified_at, last_error,
  created_by_id, restore_status, restore_error, restored_at, restored_by_id,
  restore_scratch_db, restore_old_db, swapped_at, created_at, updated_at
)
SELECT
  l.id,
  l.status::text::"DatabaseBackupStatus",
  l.trigger::text::"DatabaseBackupTrigger",
  l.started_at, l.finished_at, l.last_heartbeat_at,
  l.bytes_written, COALESCE(l.size_bytes, l.bytes_written, 0),
  l.storage_provider, l.storage_key, COALESCE(l.bucket, ''), COALESCE(l.format, 'custom'),
  l.checksum_sha256, l.db_version, l.app_version, l.migration_name, l.verified_at, l.last_error,
  (SELECT u.id FROM users u WHERE u.id = l.created_by_id),
  CASE WHEN l.restore_status IN (${PLATFORM_RESTORE_STATUSES.map((s) => `'${s}'`).join(', ')}) THEN l.restore_status ELSE NULL END,
  l.restore_error, l.restored_at,
  (SELECT u.id FROM users u WHERE u.id = l.restored_by_id),
  l.restore_scratch_db, l.restore_old_db, l.swapped_at,
  COALESCE(l.started_at, l.finished_at, now()), now()
FROM mh_legacy_database_backup_runs l
WHERE l.storage_key IS NOT NULL
  AND l.storage_provider IS NOT NULL
  AND l.status IN ('completed', 'failed', 'stale')
ON CONFLICT (id) DO NOTHING`;

/** Second pass: the self-link, only between copied rows, never overwriting one already set. */
export const LINK_PRE_RESTORE_SQL = `
UPDATE database_backup_runs d
SET pre_restore_backup_id = l.pre_restore_backup_id, updated_at = now()
FROM mh_legacy_database_backup_runs l
WHERE d.id = l.id
  AND d.pre_restore_backup_id IS NULL
  AND l.pre_restore_backup_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM database_backup_runs p WHERE p.id = l.pre_restore_backup_id)`;

/** The minimal client the copy needs (a `pg.Client` or `PoolClient`). */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface RunCopyPlan {
  total: number;
  withArchive: number;
  alreadyCopied: number;
  /** Rows a copy would add now. */
  toCopy: number;
  /** Legacy rows without an archive; they stay in the legacy table. */
  withoutArchive: number;
  /** pending/running rows (or a restore mid-flight): the copy refuses while any exists. */
  active: Array<{ id: string; status: string }>;
}

/** Counts what {@link applyRunCopy} would do. Reads only. */
export async function planRunCopy(client: SqlClient): Promise<RunCopyPlan> {
  const counts = (await client.query<{ total: number; with_archive: number; already_copied: number }>(LEGACY_RUN_COUNTS_SQL)).rows[0] ?? {
    total: 0,
    with_archive: 0,
    already_copied: 0,
  };
  const active = (await client.query<{ id: string; status: string }>(LEGACY_ACTIVE_RUNS_SQL)).rows;
  return {
    total: counts.total,
    withArchive: counts.with_archive,
    alreadyCopied: counts.already_copied,
    toCopy: Math.max(0, counts.with_archive - counts.already_copied),
    withoutArchive: counts.total - counts.with_archive,
    active,
  };
}

/**
 * Copies the rows in one transaction (both passes or neither).
 *
 * @throws Error when a legacy run or restore is still in flight (drain first).
 * @returns the number of rows inserted and links set.
 */
export async function applyRunCopy(client: SqlClient): Promise<{ copied: number; linked: number }> {
  const active = (await client.query<{ id: string; status: string }>(LEGACY_ACTIVE_RUNS_SQL)).rows;
  if (active.length > 0) {
    throw new Error(
      `A legacy backup or restore is still in flight (${active.map((r) => `${r.id}:${r.status}`).join(', ')}); ` +
        'let it finish (or mark it failed) before copying the history.',
    );
  }
  await client.query('BEGIN');
  try {
    const copied = (await client.query(COPY_LEGACY_RUNS_SQL)).rowCount ?? 0;
    const linked = (await client.query(LINK_PRE_RESTORE_SQL)).rowCount ?? 0;
    await client.query('COMMIT');
    return { copied, linked };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Settings against Postgres
// ---------------------------------------------------------------------------

const GLOBAL_KEY = 'global';

export interface SettingsApplyResult {
  transform: SettingsTransform;
  /** Whether the original value was copied to {@link LEGACY_DATABASE_BACKUP_SETTINGS_KEY} now. */
  keptOriginal: boolean;
  written: boolean;
}

/**
 * Reads (and with `apply`, rewrites) `databaseBackup` in the `global` settings row,
 * keeping the original under {@link LEGACY_DATABASE_BACKUP_SETTINGS_KEY} the first
 * time. Row-locked; one transaction.
 */
export async function migrateDatabaseBackupSettings(client: SqlClient, apply: boolean): Promise<SettingsApplyResult> {
  await client.query('BEGIN');
  try {
    const res = await client.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = $1${apply ? ' FOR UPDATE' : ''}`,
      [GLOBAL_KEY],
    );
    const doc: Json = isObject(res.rows[0]?.value) ? { ...(res.rows[0]!.value as Json) } : {};
    const transform = transformDatabaseBackupSettings(doc.databaseBackup);
    const keepOriginal = isObject(doc.databaseBackup) && doc[LEGACY_DATABASE_BACKUP_SETTINGS_KEY] === undefined && transform.changed;

    if (!apply || res.rows.length === 0 || (!transform.changed && !keepOriginal)) {
      await client.query('ROLLBACK');
      return { transform, keptOriginal: false, written: false };
    }

    if (keepOriginal) doc[LEGACY_DATABASE_BACKUP_SETTINGS_KEY] = doc.databaseBackup;
    doc.databaseBackup = transform.next;
    await client.query(
      `UPDATE system_settings SET value = $2::jsonb, version = version + 1, updated_at = now() WHERE key = $1`,
      [GLOBAL_KEY, JSON.stringify(doc)],
    );
    await client.query('COMMIT');
    return { transform, keptOriginal: keepOriginal, written: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

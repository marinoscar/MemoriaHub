// =============================================================================
// MemoriaHub's database backup and restore registrations (RETRO-D4, #580)
// =============================================================================
//
// Imported FIRST by `platform/db-backup/db-backup.config.ts`, so it runs before
// the registries freeze when the application bootstraps. Three registrations:
//
// RESTORE GATE `memoriahub-extensions`
// -----------------------------------------------------------------------------
// MemoriaHub's schema needs the `vector` (pgvector) extension: `faces.embedding_vec`
// (128-d), `media_item_embedding` (1536-d) and `media_visual_embedding` (512-d)
// and their HNSW indexes cannot be restored onto a cluster that cannot install
// it, and the archive issues `CREATE EXTENSION vector`. `uuid-ossp` ships with
// every PostgreSQL contrib build, so it is not named. The platform's built-in
// `extensions` gate compares what the LIVE database has with what the cluster
// offers; this gate states the application's own requirement by name, so the
// restore dialog shows it even on a database that has lost the extension.
//
// The id is `${APP_SLUG}-extensions` (the registry accepts lowercase letters,
// digits, `_` and `-`; the kvox gate is the precedent).
//
// The check is READ-ONLY: one `SELECT` on `pg_available_extensions` over a
// short-lived connection to the cluster's maintenance database, outside the
// Prisma pool. It never creates, drops or renames anything (the restore
// pre-flight invariant). The extension itself is created by the migrations run
// as the bootstrap superuser, never by this gate.
//
// Rebuilding the HNSW indexes is the bulk of a restore's run time (an archive
// stores `CREATE INDEX`, not index data: hours at ~1M vectors). Nothing to
// register for it: the restore replays into a scratch database while the live
// one keeps serving, which is what makes the duration acceptable.
//
// RESTORE CARRY-OVER `mh_legacy_android_app_releases`  (Open decision 1 of #580)
// -----------------------------------------------------------------------------
// A restore replaces the live database with an archive, so a row written after
// the archive was taken is gone. That is right for almost every table and wrong
// for one that records a fact OUTSIDE the database. The Android APK releases are
// such a table: each row points at an APK uploaded to object storage, and
// restoring last week's database must not forget this week's release (installed
// phones are offered "the current release"). The platform carries the backup
// catalog itself (`database_backup_runs`), the restore's own job row and the
// completion audit row; this file adds the releases.
//
//   - The table is `mh_legacy_android_app_releases` until RETRO-D5 moves the
//     releases onto the android-app slice's `android_app_releases`; D5 retargets
//     (or drops, if the slice registers its own) this carry.
//   - Rows are exported `is_current` FALSE first, so the row losing the current
//     flag is updated before the new current one is inserted: the raw-SQL partial
//     unique index `mh_legacy_android_app_releases_one_current_uniq_idx` admits one current
//     release, and the carry upserts one row at a time.
//   - The uploader is re-resolved against `users` (`NULL` for a user the archive
//     does not know), the same rule the backup catalog carry uses.
//
// Media rows (`media_items`, `storage_objects`) are deliberately NOT carried: a
// restore is a point-in-time of the library. An object uploaded after the
// archive is orphaned (the storage purge reclaims it) and a row whose object was
// deleted after the archive answers 404 for its bytes; the runbook says so.
//
// LEGACY KEY PREFIX `db-backups/`
// -----------------------------------------------------------------------------
// Before this slice MemoriaHub wrote archives under `db-backups/<stamp>-<runId>.dump`
// (the platform writes `database-backups/memoriahub/YYYY/MM/...`). The objects are
// never moved: the run rows keep their stored `storage_key`, so download, restore,
// retention and delete keep finding them. The prefix is registered (deployment
// scope, survives a factory reset) so purge and offboarding enumerate it.
// PLATFORM-ADOPTION-SHIM(RETRO-D1): registered here because the app's storage
// key-prefix manifest (`platform/storage/storage-key-prefix.manifest.ts`) arrives
// with the storage slice; D1 moves this entry there.
// =============================================================================

import { Client } from 'pg';
import { APP_SLUG } from '@app/shared';
import { registerRestoreCarryOver, registerRestoreGate } from '@marinoscar/platform-api/db-backup';
import type {
  RestoreCarryOver,
  RestoreGateContext,
  RestoreGateOutcome,
} from '@marinoscar/platform-api/db-backup';
import {
  registerStorageKeyPrefixes,
  storageKeyPrefixRegistry,
  type StorageKeyPrefixDef,
} from '@marinoscar/platform-api/storage';

import { buildDatabaseUrl } from '../config/database-url.util';

// ---------------------------------------------------------------------------
// Restore gate
// ---------------------------------------------------------------------------

/** The extensions MemoriaHub's schema needs that a plain PostgreSQL build may lack. */
export const MEMORIAHUB_REQUIRED_EXTENSIONS = ['vector'] as const;

/** Upper bound on the connection and the query. The pre-flight bounds the gate at 10 s as well. */
const PROBE_TIMEOUT_MS = 5_000;

/** Which of the required extensions the cluster cannot offer, read from `pg_available_extensions`. */
async function readUnavailableExtensions(ctx: RestoreGateContext): Promise<string[]> {
  // Coordinates come from the pre-flight's own admin connection (host, port, user,
  // the maintenance database it attached to); the password and the TLS mode come
  // from the same connection string the API itself uses.
  const url = new URL(buildDatabaseUrl());
  const sslMode = url.searchParams.get('sslmode');
  const ssl =
    sslMode === null || sslMode === 'disable' || sslMode === 'allow' || sslMode === 'prefer'
      ? false
      : { rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full' };
  const { connection } = ctx.facts;

  const client = new Client({
    host: connection.host,
    port: Number.parseInt(connection.port, 10),
    user: connection.user,
    password: decodeURIComponent(url.password),
    database: connection.database,
    ssl,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>(
      'SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])',
      [[...MEMORIAHUB_REQUIRED_EXTENSIONS]],
    );
    const offered = new Set(result.rows.map((row) => row.name));
    return MEMORIAHUB_REQUIRED_EXTENSIONS.filter((name) => !offered.has(name));
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The gate's check, exported for its unit test. */
export async function checkMemoriaHubExtensions(ctx: RestoreGateContext): Promise<RestoreGateOutcome> {
  const missing = await readUnavailableExtensions(ctx);
  if (missing.length === 0) {
    return {
      status: 'pass',
      message: `${MEMORIAHUB_REQUIRED_EXTENSIONS.join(' and ')} is installable on the target cluster.`,
    };
  }
  return {
    status: 'fail',
    message: `The target cluster cannot offer ${missing.join(' and ')}, which MemoriaHub's schema requires (face, semantic and visual embeddings).`,
    action:
      `Install the PostgreSQL package that provides ${missing.join(' and ')} on the database server ` +
      '(for pgvector: the postgresql-<major>-pgvector package, or the pgvector/pgvector image), then retry. ' +
      'The restore creates nothing itself.',
  };
}

/** The gate's registry id. */
export const MEMORIAHUB_EXTENSIONS_GATE_ID = `${APP_SLUG}-extensions`;

registerRestoreGate({
  id: MEMORIAHUB_EXTENSIONS_GATE_ID,
  label: 'pgvector is available on the target cluster',
  async check(ctx) {
    return checkMemoriaHubExtensions(ctx);
  },
});

// ---------------------------------------------------------------------------
// Restore carry-over
// ---------------------------------------------------------------------------

/** The Android APK releases survive a restore (their APKs live in object storage). */
export const ANDROID_RELEASES_CARRY_OVER: RestoreCarryOver = Object.freeze({
  id: 'mh_legacy_android_app_releases',
  // After the four built-in carries; nothing else references this table.
  order: 10,
  // `is_current` FALSE first: see the header (one current release at a time).
  exportSql: 'SELECT * FROM mh_legacy_android_app_releases ORDER BY is_current, created_at, id',
  reinsertSql:
    'INSERT INTO mh_legacy_android_app_releases (' +
    'id, package_name, version_name, version_code, signing_sha256, file_sha256, size_bytes, ' +
    'storage_key, storage_provider, bucket, notes, is_current, uploaded_by_id, created_at) ' +
    'SELECT r.id, r.package_name, r.version_name, r.version_code, r.signing_sha256, r.file_sha256, ' +
    'r.size_bytes, r.storage_key, r.storage_provider, r.bucket, r.notes, r.is_current, ' +
    '(SELECT u.id FROM users u WHERE u.id = r.uploaded_by_id), r.created_at ' +
    'FROM jsonb_populate_record(NULL::mh_legacy_android_app_releases, $1::jsonb) r ' +
    'ON CONFLICT (id) DO UPDATE SET ' +
    'version_name = EXCLUDED.version_name, signing_sha256 = EXCLUDED.signing_sha256, ' +
    'file_sha256 = EXCLUDED.file_sha256, size_bytes = EXCLUDED.size_bytes, ' +
    'storage_key = EXCLUDED.storage_key, storage_provider = EXCLUDED.storage_provider, ' +
    'bucket = EXCLUDED.bucket, notes = EXCLUDED.notes, is_current = EXCLUDED.is_current',
});

registerRestoreCarryOver(ANDROID_RELEASES_CARRY_OVER);

/** Carry-over ids the `dbBackup` conformance suite requires to be registered (and to bind `$1`). */
export const MEMORIAHUB_REQUIRED_CARRY_OVER_IDS = [ANDROID_RELEASES_CARRY_OVER.id] as const;

// ---------------------------------------------------------------------------
// Legacy archive key prefix
// ---------------------------------------------------------------------------

/** Where MemoriaHub wrote archives before the platform slice (`db-backups/<stamp>-<runId>.dump`). */
export const LEGACY_DB_BACKUP_KEY_PREFIX: StorageKeyPrefixDef = Object.freeze({
  id: 'legacy-db-backups',
  prefix: 'db-backups/',
  owner: 'db-backup',
  scope: 'deployment' as const,
  description: 'Database backup archives written before the platform slice (RETRO-D4); never moved.',
  survivesFactoryReset: true,
});

if (!storageKeyPrefixRegistry.has(LEGACY_DB_BACKUP_KEY_PREFIX.id) && !storageKeyPrefixRegistry.frozen) {
  registerStorageKeyPrefixes([LEGACY_DB_BACKUP_KEY_PREFIX]);
}

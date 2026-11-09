// =============================================================================
// Copy the pre-slice Android releases into the platform table (RETRO-D5, #586)
// =============================================================================
//
// Before RETRO-D5 MemoriaHub hosted its APKs in its own `android_app_releases`
// table, renamed `mh_legacy_android_app_releases` by RETRO-A5 so the platform's
// migration `0033_add_android_app` could create the slice's table under the
// original name. Since D5 the android-app slice serves every release route from
// `android_app_releases`, so the rows must be copied across, or installed
// phones would be told "no release" and the admin page would lose its history.
//
// THE COPY (one transaction, idempotent, keyed on the legacy id):
//   1. Every legacy row whose id is not yet in the platform table, and whose
//      (package_name, version_code) does not already belong to a DIFFERENT
//      platform row, is inserted under its ORIGINAL id with every column as is,
//      except `is_current`, which is inserted FALSE. Ids are kept so a signed
//      download link's claims, the audit rows (`targetId`) and the stored key
//      `android-releases/<id>.apk` all keep naming the same release; the APK
//      objects are never moved.
//   2. The current flag: when the platform table has NO current release and the
//      legacy current release is now present there, it is made current. When an
//      administrator already made a release current through the slice, that
//      choice is kept and the command reports it. At most one row is ever
//      current (the raw-SQL partial unique index
//      `android_app_releases_one_current_uniq_idx` would refuse a second).
//   3. A legacy row whose (package_name, version_code) is already taken by a
//      different platform row is reported as a CONFLICT and left out: the
//      platform row wins (it is what the slice has been serving).
//
// The legacy table is NEVER modified (rollback is "revert the code": the
// pre-slice API reads it unchanged). The uploader is re-resolved against
// `users`, so a user deleted in the meantime yields NULL rather than an error.
// The trusted-signer list (`android_app` system-settings row) needs no copy:
// the slice reads the same row, key and shape.
// =============================================================================

import type { SqlClient } from './legacy-db-backup-migration';

export type { SqlClient };

/** What {@link applyReleaseCopy} would do, read-only. */
export interface ReleaseCopyPlan {
  /** Rows in `mh_legacy_android_app_releases`. */
  legacyTotal: number;
  /** Legacy rows already present in `android_app_releases` under their id. */
  alreadyCopied: number;
  /** Legacy rows the copy would insert. */
  toCopy: number;
  /** Legacy rows left out: their (package, versionCode) belongs to another platform row. */
  conflicts: Array<{ id: string; packageName: string; versionCode: number; platformId: string }>;
  /** The legacy current release, if any. */
  legacyCurrentId: string | null;
  /** The platform table's current release, if any. */
  platformCurrentId: string | null;
  /** Legacy rows by recorded storage provider (`(unrecorded)` for a NULL provider). */
  byStorageProvider: Array<{ provider: string; count: number }>;
}

/** Whether the legacy table exists (it does until a later release drops it). */
export const LEGACY_TABLE_EXISTS_SQL = `SELECT to_regclass('public.mh_legacy_android_app_releases') IS NOT NULL AS present`;

const COUNTS_SQL = `
  SELECT
    (SELECT count(*)::int FROM mh_legacy_android_app_releases) AS legacy_total,
    (SELECT count(*)::int FROM mh_legacy_android_app_releases l
       WHERE EXISTS (SELECT 1 FROM android_app_releases p WHERE p.id = l.id)) AS already_copied,
    (SELECT id::text FROM mh_legacy_android_app_releases WHERE is_current LIMIT 1) AS legacy_current_id,
    (SELECT id::text FROM android_app_releases WHERE is_current LIMIT 1) AS platform_current_id`;

const CONFLICTS_SQL = `
  SELECT l.id::text AS id, l.package_name AS package_name, l.version_code AS version_code, p.id::text AS platform_id
    FROM mh_legacy_android_app_releases l
    JOIN android_app_releases p
      ON p.package_name = l.package_name AND p.version_code = l.version_code AND p.id <> l.id
   ORDER BY l.package_name, l.version_code`;

const BY_PROVIDER_SQL = `
  SELECT COALESCE(storage_provider, '(unrecorded)') AS provider, count(*)::int AS count
    FROM mh_legacy_android_app_releases
   GROUP BY 1 ORDER BY 1`;

/**
 * Inserts the copyable legacy rows under their ids, never current. `ON CONFLICT DO NOTHING`
 * (no target) also absorbs a concurrent writer racing either unique constraint.
 */
export const COPY_LEGACY_RELEASES_SQL = `
  INSERT INTO android_app_releases (
    id, package_name, version_name, version_code, signing_sha256, file_sha256, size_bytes,
    storage_key, storage_provider, bucket, notes, is_current, uploaded_by_id, created_at)
  SELECT l.id, l.package_name, l.version_name, l.version_code, l.signing_sha256, l.file_sha256, l.size_bytes,
         l.storage_key, l.storage_provider, l.bucket, l.notes, false,
         (SELECT u.id FROM users u WHERE u.id = l.uploaded_by_id), l.created_at
    FROM mh_legacy_android_app_releases l
   WHERE NOT EXISTS (SELECT 1 FROM android_app_releases p WHERE p.id = l.id)
     AND NOT EXISTS (SELECT 1 FROM android_app_releases p
                      WHERE p.package_name = l.package_name AND p.version_code = l.version_code)
   ORDER BY l.created_at, l.id
  ON CONFLICT DO NOTHING`;

/**
 * Makes the legacy current release current in the platform table, only when the platform
 * table has no current release yet and the row is present there.
 */
export const PROMOTE_LEGACY_CURRENT_SQL = `
  UPDATE android_app_releases p
     SET is_current = true
   WHERE p.id = (SELECT l.id FROM mh_legacy_android_app_releases l WHERE l.is_current LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM android_app_releases c WHERE c.is_current)`;

/** Reads what the copy would do. Never writes. */
export async function planReleaseCopy(client: SqlClient): Promise<ReleaseCopyPlan | null> {
  const present = (await client.query<{ present: boolean }>(LEGACY_TABLE_EXISTS_SQL)).rows[0]?.present === true;
  if (!present) return null;
  const counts = (
    await client.query<{
      legacy_total: number;
      already_copied: number;
      legacy_current_id: string | null;
      platform_current_id: string | null;
    }>(COUNTS_SQL)
  ).rows[0] ?? { legacy_total: 0, already_copied: 0, legacy_current_id: null, platform_current_id: null };
  const conflicts = (
    await client.query<{ id: string; package_name: string; version_code: number; platform_id: string }>(CONFLICTS_SQL)
  ).rows.map((row) => ({
    id: row.id,
    packageName: row.package_name,
    versionCode: Number(row.version_code),
    platformId: row.platform_id,
  }));
  const byStorageProvider = (await client.query<{ provider: string; count: number }>(BY_PROVIDER_SQL)).rows.map(
    (row) => ({ provider: row.provider, count: Number(row.count) }),
  );
  const legacyTotal = Number(counts.legacy_total);
  const alreadyCopied = Number(counts.already_copied);
  return {
    legacyTotal,
    alreadyCopied,
    toCopy: Math.max(0, legacyTotal - alreadyCopied - conflicts.length),
    conflicts,
    legacyCurrentId: counts.legacy_current_id,
    platformCurrentId: counts.platform_current_id,
    byStorageProvider,
  };
}

/** The outcome of {@link applyReleaseCopy}. */
export interface ReleaseCopyResult {
  copied: number;
  /** Whether the legacy current release was made current in the platform table. */
  promotedCurrent: boolean;
  /** The platform's current release after the copy. */
  currentId: string | null;
}

/**
 * Copies the rows and settles the current flag in ONE transaction (both or neither).
 * Idempotent: a second run copies nothing and promotes nothing.
 */
export async function applyReleaseCopy(client: SqlClient): Promise<ReleaseCopyResult> {
  const present = (await client.query<{ present: boolean }>(LEGACY_TABLE_EXISTS_SQL)).rows[0]?.present === true;
  if (!present) return { copied: 0, promotedCurrent: false, currentId: null };
  await client.query('BEGIN');
  try {
    const copied = (await client.query(COPY_LEGACY_RELEASES_SQL)).rowCount ?? 0;
    const promoted = (await client.query(PROMOTE_LEGACY_CURRENT_SQL)).rowCount ?? 0;
    const current =
      (await client.query<{ id: string }>('SELECT id::text AS id FROM android_app_releases WHERE is_current LIMIT 1'))
        .rows[0]?.id ?? null;
    await client.query('COMMIT');
    return { copied, promotedCurrent: promoted > 0, currentId: current };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

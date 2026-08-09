-- PostgreSQL Database Backup & Restore (epic #339, issue #340) — schema-only
-- foundation. No service/API/CLI logic lands in this migration, mirroring the
-- precedent set by migration 20260808010000_add_backup_feed_foundations
-- (issue #310). Adds:
--   1. DatabaseBackupStatus / DatabaseBackupTrigger enums.
--   2. database_backup_runs — one row per pg_dump/pg_restore backup attempt
--      of the application's own PostgreSQL database, with a nullable
--      "restore-audit" column group on the SAME row for when that backup is
--      later used to drive a restore (a restore is always defined in terms
--      of exactly one backup, so a join buys nothing a nullable group
--      doesn't already give for free).
--   3. A raw-SQL-only partial unique index enforcing the single-active-run
--      guard, appended below — not representable in Prisma's schema DSL.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "DatabaseBackupStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'stale');

CREATE TYPE "DatabaseBackupTrigger" AS ENUM ('manual', 'scheduled', 'pre_restore');

-- -----------------------------------------------------------------------------
-- Table: database_backup_runs
-- -----------------------------------------------------------------------------

CREATE TABLE "database_backup_runs" (
    "id"                    UUID                     NOT NULL DEFAULT gen_random_uuid(),
    "status"                "DatabaseBackupStatus"   NOT NULL DEFAULT 'pending',
    "trigger"               "DatabaseBackupTrigger"  NOT NULL,

    "started_at"            TIMESTAMPTZ(6),
    "finished_at"           TIMESTAMPTZ(6),
    "last_heartbeat_at"     TIMESTAMPTZ(6),

    "bytes_written"         BIGINT                   NOT NULL DEFAULT 0,
    "size_bytes"            BIGINT,

    "storage_provider"      TEXT,
    "storage_key"           TEXT,
    "bucket"                TEXT,
    "format"                TEXT,
    "checksum_sha256"       TEXT,

    "db_version"            TEXT,
    "app_version"           TEXT,
    "migration_name"        TEXT,

    "verified_at"           TIMESTAMPTZ(6),
    "last_error"            TEXT,

    "created_by_id"         UUID,

    -- Restore-audit fields — populated only once this backup is used to
    -- drive a restore.
    "restore_status"        TEXT,
    "restore_error"         TEXT,
    "restored_at"           TIMESTAMPTZ(6),
    "restored_by_id"        UUID,
    "restore_scratch_db"    TEXT,
    "restore_old_db"        TEXT,
    "swapped_at"            TIMESTAMPTZ(6),
    -- Self-relation: when restoreRollbackMode='pre_restore_dump', a fresh
    -- safety backup is taken immediately before a restore runs; its row id
    -- is recorded here on the run being restored FROM.
    "pre_restore_backup_id" UUID,

    CONSTRAINT "database_backup_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_backup_runs_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "database_backup_runs_restored_by_id_fkey"
        FOREIGN KEY ("restored_by_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "database_backup_runs_pre_restore_backup_id_fkey"
        FOREIGN KEY ("pre_restore_backup_id") REFERENCES "database_backup_runs"("id") ON DELETE SET NULL
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX "database_backup_runs_status_idx" ON "database_backup_runs" ("status");

CREATE INDEX "database_backup_runs_started_at_idx" ON "database_backup_runs" ("started_at" DESC);

-- -----------------------------------------------------------------------------
-- Single-active-run guard — raw SQL, not representable in Prisma's schema
-- DSL (same precedent as notifications_review_queue_live_uniq_idx and
-- media_items_gallery_idx). At most one row may be "pending" or "running"
-- at a time app-wide, so a scheduled backup can never start while a manual
-- one (or a pre-restore safety backup) is already in flight, and vice versa.
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX "database_backup_runs_active_uniq_idx"
    ON "database_backup_runs" ("status")
    WHERE "status" IN ('pending', 'running');

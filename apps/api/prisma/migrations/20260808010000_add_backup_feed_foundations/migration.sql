-- Local Media Backup via Worker Nodes (issue #310, child 1 of epic #308).
--
-- Prisma-schema foundation only — no service/API/CLI logic lands in this
-- migration. Adds:
--   1. media_items(updated_at, id) — serves the backup feed's cursor-based
--      incremental scan (a node backup run pages through media_items
--      ordered by (updated_at, id) since its config's checkpoint).
--   2. NodeBackupRunKind / NodeBackupRunStatus enums.
--   3. node_backup_configs — per-node backup schedule/scope/checkpoint,
--      one row per WorkerNode (1:1, unique node_id).
--   4. node_backup_runs — one row per backup run attempt for a node,
--      mirroring the existing WorkerNode job-run pattern (e.g.
--      StorageMigrationRun, TrashEmptyRun).

-- -----------------------------------------------------------------------------
-- Index: media_items (updated_at, id)
-- -----------------------------------------------------------------------------

CREATE INDEX "media_items_updated_at_id_idx" ON "media_items" ("updated_at", "id");

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "NodeBackupRunKind" AS ENUM ('incremental', 'reconcile');

CREATE TYPE "NodeBackupRunStatus" AS ENUM ('running', 'completed', 'failed', 'aborted', 'stale');

-- -----------------------------------------------------------------------------
-- Table: node_backup_configs
-- -----------------------------------------------------------------------------

CREATE TABLE "node_backup_configs" (
    "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
    "node_id"                UUID         NOT NULL,
    "enabled"                BOOLEAN      NOT NULL DEFAULT true,
    "schedule_cron"          TEXT,
    "timezone"               TEXT,
    "next_run_at"            TIMESTAMPTZ(6),
    "circle_ids"             UUID[]       NOT NULL,
    "checkpoint_updated_at"  TIMESTAMPTZ(6),
    "checkpoint_id"          UUID,
    "items_acked"            BIGINT       NOT NULL DEFAULT 0,
    "bytes_acked"            BIGINT       NOT NULL DEFAULT 0,
    "last_run_at"            TIMESTAMPTZ(6),
    "last_completed_run_at"  TIMESTAMPTZ(6),
    "last_reconcile_at"      TIMESTAMPTZ(6),
    "created_at"             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at"             TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "node_backup_configs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "node_backup_configs_node_id_fkey"
        FOREIGN KEY ("node_id") REFERENCES "worker_nodes"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "node_backup_configs_node_id_key" ON "node_backup_configs" ("node_id");

CREATE INDEX "node_backup_configs_next_run_at_idx" ON "node_backup_configs" ("next_run_at");

-- -----------------------------------------------------------------------------
-- Table: node_backup_runs
-- -----------------------------------------------------------------------------

CREATE TABLE "node_backup_runs" (
    "id"                       UUID                    NOT NULL DEFAULT gen_random_uuid(),
    "node_id"                  UUID                    NOT NULL,
    "kind"                     "NodeBackupRunKind"     NOT NULL,
    "status"                   "NodeBackupRunStatus"   NOT NULL DEFAULT 'running',
    "trigger"                  TEXT                    NOT NULL,
    "started_at"               TIMESTAMPTZ(6)          NOT NULL DEFAULT now(),
    "finished_at"              TIMESTAMPTZ(6),
    "last_ack_at"              TIMESTAMPTZ(6),
    "items_downloaded"         INTEGER                 NOT NULL DEFAULT 0,
    "items_skipped"            INTEGER                 NOT NULL DEFAULT 0,
    "sidecars_written"         INTEGER                 NOT NULL DEFAULT 0,
    "bytes_downloaded"         BIGINT                  NOT NULL DEFAULT 0,
    "error_count"              INTEGER                 NOT NULL DEFAULT 0,
    "last_error"               TEXT,
    "cli_version"              TEXT,
    "cursor_start_updated_at"  TIMESTAMPTZ(6),
    "cursor_start_id"          UUID,
    "cursor_end_updated_at"    TIMESTAMPTZ(6),
    "cursor_end_id"            UUID,

    CONSTRAINT "node_backup_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "node_backup_runs_node_id_fkey"
        FOREIGN KEY ("node_id") REFERENCES "worker_nodes"("id") ON DELETE CASCADE
);

CREATE INDEX "node_backup_runs_node_id_started_at_idx" ON "node_backup_runs" ("node_id", "started_at" DESC);

CREATE INDEX "node_backup_runs_status_idx" ON "node_backup_runs" ("status");

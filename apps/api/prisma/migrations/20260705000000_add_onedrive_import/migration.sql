-- OneDrive Data Import migration: adds the per-user Microsoft OneDrive token
-- vault (onedrive_connections) plus the import run/item table pair
-- (onedrive_import_runs / onedrive_import_items), modeled directly on the
-- storage_migration_runs / storage_migration_items pattern.
--
-- onedrive_connections stores exactly one active Microsoft connection per
-- MemoriaHub user (@@unique(user_id)) — unlike ai_provider_credentials /
-- face_provider_credentials / geo_provider_credentials / storage_provider_credentials
-- (all system-wide, one row per provider key), this is a personal OAuth grant.
-- The refresh token is stored AES-256-GCM encrypted (encrypted_refresh_token);
-- access tokens are never persisted.
--
-- onedrive_import_runs is one row per import initiated by a user; status moves
-- pending -> running -> completed/failed/cancelled. imported/failed/skipped
-- counts are recomputed from item rows at read time rather than tracked as
-- denormalized counters (same rationale as storage_migration_runs).
--
-- onedrive_import_items is one row per remote file discovered during
-- enumeration; @@unique(run_id, remote_item_id) gives re-enqueue idempotency
-- identical to storage_migration_items' @@unique(run_id, object_id).
-- media_item_id is nullable and SET NULL on media item delete, set once the
-- item is imported (or dedup-matched) into a MediaItem row.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "OneDriveImportRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

CREATE TYPE "OneDriveImportItemStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');

-- -----------------------------------------------------------------------------
-- Table: onedrive_connections
-- -----------------------------------------------------------------------------

CREATE TABLE "onedrive_connections" (
    "id"                      UUID        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"                 UUID        NOT NULL,
    "microsoft_account_id"    TEXT        NOT NULL,
    "microsoft_email"         TEXT        NOT NULL,
    "encrypted_refresh_token" TEXT        NOT NULL,
    "scopes"                  TEXT        NOT NULL,
    "connected_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "onedrive_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "onedrive_connections_user_id_key" UNIQUE ("user_id"),
    CONSTRAINT "onedrive_connections_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Table: onedrive_import_runs
-- -----------------------------------------------------------------------------

CREATE TABLE "onedrive_import_runs" (
    "id"                  UUID                      NOT NULL DEFAULT gen_random_uuid(),
    "user_id"             UUID                      NOT NULL,
    "circle_id"           UUID                      NOT NULL,
    "remote_folder_path"  TEXT,
    "recursive"           BOOLEAN                   NOT NULL DEFAULT false,
    "status"              "OneDriveImportRunStatus" NOT NULL DEFAULT 'pending',
    "total_count"         INTEGER                   NOT NULL DEFAULT 0,
    "started_at"          TIMESTAMPTZ,
    "finished_at"         TIMESTAMPTZ,
    "last_error"          TEXT,
    "created_at"          TIMESTAMPTZ               NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ               NOT NULL DEFAULT now(),

    CONSTRAINT "onedrive_import_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "onedrive_import_runs_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "onedrive_import_runs_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE
);

CREATE INDEX "onedrive_import_runs_user_id_status_idx" ON "onedrive_import_runs" ("user_id", "status");

-- -----------------------------------------------------------------------------
-- Table: onedrive_import_items
-- -----------------------------------------------------------------------------

CREATE TABLE "onedrive_import_items" (
    "id"              UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "run_id"          UUID                       NOT NULL,
    "remote_item_id"  TEXT                       NOT NULL,
    "remote_path"     TEXT                       NOT NULL,
    "remote_name"     TEXT                       NOT NULL,
    "remote_size"     BIGINT                     NOT NULL,
    "status"          "OneDriveImportItemStatus" NOT NULL DEFAULT 'pending',
    "media_item_id"   UUID,
    "last_error"      TEXT,
    "created_at"      TIMESTAMPTZ                NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ                NOT NULL DEFAULT now(),

    CONSTRAINT "onedrive_import_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "onedrive_import_items_run_id_remote_item_id_key" UNIQUE ("run_id", "remote_item_id"),
    CONSTRAINT "onedrive_import_items_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "onedrive_import_runs"("id") ON DELETE CASCADE,
    CONSTRAINT "onedrive_import_items_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL
);

CREATE INDEX "onedrive_import_items_run_id_status_idx" ON "onedrive_import_items" ("run_id", "status");

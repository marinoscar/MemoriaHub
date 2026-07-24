-- Empty Trash at Scale migration (Step 1, issue #165): add
-- TrashEmptyRunStatus and TrashEmptyRunItemStatus enums plus the
-- trash_empty_runs / trash_empty_run_items tables.
--
-- This is a strict simplification of the Media Workflow Automation
-- workflow_runs / workflow_run_items pattern (see
-- 20260719000000_add_workflow_tables): no conditions, no action list, no
-- approval gate — every matched (trashed) media item in one circle is
-- hard-deleted. Adding these run-record tables lets the empty-trash feature
-- run asynchronously through the enrichment queue with chunked batch jobs
-- and live progress instead of a single synchronous request.
--
-- trash_empty_runs is one row per "empty trash" run for a circle.
-- matched_count is the number of trashed media items discovered when the
-- run was evaluated; processed_count/succeeded_count/failed_count/
-- skipped_count track progress as chunked batch jobs work through the
-- matched set. status walks evaluating -> running -> completed |
-- completed_with_errors | failed | cancelled.
--
-- trash_empty_run_items is one row per matched media item within a
-- TrashEmptyRun. @@unique([runId, mediaItemId]) is the idempotency anchor
-- for batch retries, mirroring the workflow_run_items /
-- storage_migration_items precedent. media_item_id cascades on delete
-- because a successful purge deletes the MediaItem itself and must
-- cascade-remove this row along with it.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "TrashEmptyRunStatus" AS ENUM ('evaluating', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled');

CREATE TYPE "TrashEmptyRunItemStatus" AS ENUM ('matched', 'deleted', 'failed', 'skipped');

-- -----------------------------------------------------------------------------
-- Table: trash_empty_runs
-- -----------------------------------------------------------------------------

CREATE TABLE "trash_empty_runs" (
    "id"               UUID                    NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"        UUID                    NOT NULL,
    "status"           "TrashEmptyRunStatus"   NOT NULL DEFAULT 'evaluating',
    "matched_count"    INTEGER                 NOT NULL DEFAULT 0,
    "processed_count"  INTEGER                 NOT NULL DEFAULT 0,
    "succeeded_count"  INTEGER                 NOT NULL DEFAULT 0,
    "failed_count"     INTEGER                 NOT NULL DEFAULT 0,
    "skipped_count"    INTEGER                 NOT NULL DEFAULT 0,
    "started_by_id"    UUID,
    "last_error"       TEXT,
    "created_at"       TIMESTAMPTZ             NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ             NOT NULL DEFAULT now(),
    "started_at"       TIMESTAMPTZ,
    "finished_at"      TIMESTAMPTZ,

    CONSTRAINT "trash_empty_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trash_empty_runs_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "trash_empty_runs_started_by_id_fkey"
        FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "trash_empty_runs_circle_id_status_idx"  ON "trash_empty_runs" ("circle_id", "status");
CREATE INDEX "trash_empty_runs_status_updated_at_idx" ON "trash_empty_runs" ("status", "updated_at");

-- -----------------------------------------------------------------------------
-- Table: trash_empty_run_items
-- -----------------------------------------------------------------------------

CREATE TABLE "trash_empty_run_items" (
    "id"             UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "run_id"         UUID                       NOT NULL,
    "media_item_id"  UUID                       NOT NULL,
    "status"         "TrashEmptyRunItemStatus"  NOT NULL DEFAULT 'matched',
    "error"          TEXT,
    "created_at"     TIMESTAMPTZ                NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ                NOT NULL DEFAULT now(),

    CONSTRAINT "trash_empty_run_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trash_empty_run_items_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "trash_empty_runs"("id") ON DELETE CASCADE,
    CONSTRAINT "trash_empty_run_items_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "trash_empty_run_items_run_id_media_item_id_key" ON "trash_empty_run_items" ("run_id", "media_item_id");
CREATE INDEX "trash_empty_run_items_run_id_status_idx"               ON "trash_empty_run_items" ("run_id", "status");

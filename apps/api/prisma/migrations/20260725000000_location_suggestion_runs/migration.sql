-- Location Suggestion Bulk Accept/Reject at Scale migration: add
-- LocationSuggestionRunAction, LocationSuggestionRunStatus, and
-- LocationSuggestionRunItemStatus enums plus the location_suggestion_runs /
-- location_suggestion_run_items tables.
--
-- This mirrors the Empty Trash at Scale run-record pattern (see
-- 20260724000000_trash_empty_runs): no conditions, no action list, no
-- approval gate — every pending LocationSuggestion in a circle at/above a
-- snapshotted confidence threshold is either accepted or rejected. Adding
-- these run-record tables lets the bulk accept/reject feature run
-- asynchronously through the enrichment queue with chunked batch jobs and
-- live progress instead of a single synchronous request.
--
-- location_suggestion_runs is one row per bulk accept/reject run for a
-- circle. threshold is a snapshot (0-100) of the confidence threshold used
-- when the run was evaluated. matched_count is the number of pending
-- suggestions discovered when the run was evaluated; processed_count/
-- succeeded_count/failed_count/skipped_count track progress as chunked
-- batch jobs work through the matched set. status walks evaluating ->
-- running -> completed | completed_with_errors | failed | cancelled.
--
-- location_suggestion_run_items is one row per matched suggestion within a
-- LocationSuggestionRun. @@unique([runId, suggestionId]) is the idempotency
-- anchor for batch retries, mirroring the trash_empty_run_items /
-- workflow_run_items precedent. suggestion_id cascades on delete so a
-- deleted LocationSuggestion removes its run-item rows too. Unlike
-- trash_empty_run_items (where a successful purge cascade-deletes the row,
-- so 'deleted' doubles as both claim-marker and terminal-success), an
-- accept/reject leaves the row in place: the execute-batch handler
-- atomically claims matched -> processing (updateMany), does the per-item
-- work, then transitions to a terminal applied (success) / skipped
-- (suggestion no longer pending) / failed. processing is the transient
-- in-flight/claim marker that makes retries crash-safe without
-- double-counting.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "LocationSuggestionRunAction" AS ENUM ('accept', 'reject');

CREATE TYPE "LocationSuggestionRunStatus" AS ENUM ('evaluating', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled');

CREATE TYPE "LocationSuggestionRunItemStatus" AS ENUM ('matched', 'processing', 'applied', 'failed', 'skipped');

-- -----------------------------------------------------------------------------
-- Table: location_suggestion_runs
-- -----------------------------------------------------------------------------

CREATE TABLE "location_suggestion_runs" (
    "id"               UUID                            NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"        UUID                            NOT NULL,
    "action"           "LocationSuggestionRunAction"   NOT NULL,
    "threshold"        INTEGER                         NOT NULL,
    "status"           "LocationSuggestionRunStatus"   NOT NULL DEFAULT 'evaluating',
    "matched_count"    INTEGER                         NOT NULL DEFAULT 0,
    "processed_count"  INTEGER                         NOT NULL DEFAULT 0,
    "succeeded_count"  INTEGER                         NOT NULL DEFAULT 0,
    "failed_count"     INTEGER                         NOT NULL DEFAULT 0,
    "skipped_count"    INTEGER                         NOT NULL DEFAULT 0,
    "started_by_id"    UUID,
    "last_error"       TEXT,
    "created_at"       TIMESTAMPTZ                     NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ                     NOT NULL DEFAULT now(),
    "started_at"       TIMESTAMPTZ,
    "finished_at"      TIMESTAMPTZ,

    CONSTRAINT "location_suggestion_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_suggestion_runs_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "location_suggestion_runs_started_by_id_fkey"
        FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "location_suggestion_runs_circle_id_status_idx"  ON "location_suggestion_runs" ("circle_id", "status");
CREATE INDEX "location_suggestion_runs_status_updated_at_idx" ON "location_suggestion_runs" ("status", "updated_at");

-- -----------------------------------------------------------------------------
-- Table: location_suggestion_run_items
-- -----------------------------------------------------------------------------

CREATE TABLE "location_suggestion_run_items" (
    "id"             UUID                               NOT NULL DEFAULT gen_random_uuid(),
    "run_id"         UUID                               NOT NULL,
    "suggestion_id"  UUID                               NOT NULL,
    "status"         "LocationSuggestionRunItemStatus"  NOT NULL DEFAULT 'matched',
    "error"          TEXT,
    "created_at"     TIMESTAMPTZ                        NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ                        NOT NULL DEFAULT now(),

    CONSTRAINT "location_suggestion_run_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_suggestion_run_items_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "location_suggestion_runs"("id") ON DELETE CASCADE,
    CONSTRAINT "location_suggestion_run_items_suggestion_id_fkey"
        FOREIGN KEY ("suggestion_id") REFERENCES "location_suggestions"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "location_suggestion_run_items_run_id_suggestion_id_key" ON "location_suggestion_run_items" ("run_id", "suggestion_id");
CREATE INDEX "location_suggestion_run_items_run_id_status_idx"              ON "location_suggestion_run_items" ("run_id", "status");

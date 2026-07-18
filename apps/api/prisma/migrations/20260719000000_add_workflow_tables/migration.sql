-- Media Workflow Automation migration (Phase 1, issue #139): add
-- WorkflowSubject, WorkflowTrigger, WorkflowRunStatus, and
-- WorkflowRunItemStatus enums plus the workflows / workflow_runs /
-- workflow_run_items tables.
--
-- workflows is a circle-scoped, user-authored automation definition: a
-- subject (v1 only supports 'media_item' — the enum is the extension point
-- for future subjects), a match/filter + action document (`definition`
-- JSONB, versioned and subject-tagged), and a trigger (manual run,
-- on_media_enriched event, or a cron schedule via cron_expression).
-- cron_expression is required only when trigger='scheduled' — enforced in
-- the application layer, not the DB, same precedent as other
-- conditionally-required text columns elsewhere in this schema (e.g.
-- media_shares' XOR-by-CHECK-constraint is the exception, not the rule).
-- next_run_at is maintained by the Phase 4 scheduler for scheduled
-- workflows.
--
-- workflow_runs is one row per execution attempt of a Workflow.
-- definition_snapshot freezes the parent Workflow's `definition` at run
-- time so edits to the workflow after a run has started never change what
-- that run evaluates/applies. circle_id is denormalized from the parent
-- Workflow for direct circle-scoped queries without a join (mirrors the
-- media_visual_embedding.circle_id / media_tag_status.circle_id precedent).
-- status walks evaluating -> (awaiting_approval ->) running -> completed |
-- completed_with_errors | failed | cancelled | expired.
--
-- workflow_run_items is one row per matched media item within a
-- WorkflowRun, tracking the per-item outcome of applying the workflow's
-- actions. @@unique([runId, mediaItemId]) is the idempotency anchor for
-- batch retries, mirroring the storage_migration_items
-- @@unique([runId, objectId]) precedent.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "WorkflowSubject" AS ENUM ('media_item');

CREATE TYPE "WorkflowTrigger" AS ENUM ('manual', 'on_media_enriched', 'scheduled');

CREATE TYPE "WorkflowRunStatus" AS ENUM ('evaluating', 'awaiting_approval', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'expired');

CREATE TYPE "WorkflowRunItemStatus" AS ENUM ('matched', 'excluded', 'applied', 'partially_applied', 'failed', 'skipped');

-- -----------------------------------------------------------------------------
-- Table: workflows
-- -----------------------------------------------------------------------------

CREATE TABLE "workflows" (
    "id"              UUID               NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"       UUID               NOT NULL,
    "name"            TEXT               NOT NULL,
    "description"     TEXT,
    "subject_type"    "WorkflowSubject"  NOT NULL,
    "enabled"         BOOLEAN            NOT NULL DEFAULT true,
    "trigger"         "WorkflowTrigger"  NOT NULL,
    "cron_expression" TEXT,
    "next_run_at"     TIMESTAMPTZ,
    "definition"      JSONB              NOT NULL,
    "created_by_id"   UUID,
    "created_at"      TIMESTAMPTZ        NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ        NOT NULL DEFAULT now(),

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflows_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "workflows_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "workflows_circle_id_enabled_idx"           ON "workflows" ("circle_id", "enabled");
CREATE INDEX "workflows_trigger_enabled_next_run_at_idx" ON "workflows" ("trigger", "enabled", "next_run_at");

-- -----------------------------------------------------------------------------
-- Table: workflow_runs
-- -----------------------------------------------------------------------------

CREATE TABLE "workflow_runs" (
    "id"                   UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id"          UUID                 NOT NULL,
    "circle_id"            UUID                 NOT NULL,
    "status"               "WorkflowRunStatus"  NOT NULL,
    "trigger_type"         "WorkflowTrigger"    NOT NULL,
    "definition_snapshot"  JSONB                NOT NULL,
    "matched_count"        INTEGER              NOT NULL DEFAULT 0,
    "truncated"            BOOLEAN              NOT NULL DEFAULT false,
    "processed_count"      INTEGER              NOT NULL DEFAULT 0,
    "succeeded_count"      INTEGER              NOT NULL DEFAULT 0,
    "failed_count"         INTEGER              NOT NULL DEFAULT 0,
    "skipped_count"        INTEGER              NOT NULL DEFAULT 0,
    "started_by_id"        UUID,
    "approved_by_id"       UUID,
    "created_at"           TIMESTAMPTZ          NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ          NOT NULL DEFAULT now(),
    "approved_at"          TIMESTAMPTZ,
    "started_at"           TIMESTAMPTZ,
    "finished_at"          TIMESTAMPTZ,
    "last_error"           TEXT,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_runs_workflow_id_fkey"
        FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_runs_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_runs_started_by_id_fkey"
        FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "workflow_runs_approved_by_id_fkey"
        FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "workflow_runs_workflow_id_created_at_idx" ON "workflow_runs" ("workflow_id", "created_at");
CREATE INDEX "workflow_runs_circle_id_status_idx"       ON "workflow_runs" ("circle_id", "status");
CREATE INDEX "workflow_runs_status_updated_at_idx"      ON "workflow_runs" ("status", "updated_at");

-- -----------------------------------------------------------------------------
-- Table: workflow_run_items
-- -----------------------------------------------------------------------------

CREATE TABLE "workflow_run_items" (
    "id"              UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "run_id"          UUID                       NOT NULL,
    "media_item_id"   UUID                       NOT NULL,
    "status"          "WorkflowRunItemStatus"    NOT NULL,
    "action_results"  JSONB,
    "error"           TEXT,
    "updated_at"      TIMESTAMPTZ                NOT NULL DEFAULT now(),

    CONSTRAINT "workflow_run_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_run_items_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
    CONSTRAINT "workflow_run_items_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "workflow_run_items_run_id_media_item_id_key" ON "workflow_run_items" ("run_id", "media_item_id");
CREATE INDEX "workflow_run_items_run_id_status_idx"               ON "workflow_run_items" ("run_id", "status");

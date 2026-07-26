-- Unify review-queue bulk actions on one async run model (issue #190).
--
-- Three bulk review-queue operations already ran as async runs (a run
-- record -> an "evaluate" job -> chunked "execute_batch" jobs -> progress
-- polling -> cancel): Workflows, Empty Trash, and Location Suggestion bulk
-- accept/reject (location_suggestion_runs / location_suggestion_run_items,
-- added in 20260725000000_location_suggestion_runs). The Burst and
-- Duplicate review queues never got this treatment — their four
-- "*-by-threshold" endpoints ran synchronously in the request, capped at
-- 500 groups, with a client-side auto-loop as the only progress feedback.
--
-- This migration introduces a single ReviewRun / ReviewRunItem table pair
-- that will back all three review queues going forward — bursts,
-- duplicates, AND location suggestions — and folds the existing
-- location_suggestion_runs / location_suggestion_run_items data and tables
-- into it. Burst and duplicate runs will start being written by the
-- backend module landing in a follow-up change; this migration's job is
-- purely the schema consolidation plus a lossless data migration of what
-- already exists for location suggestions.
--
-- ReviewRunItem uses an "exclusive arc": exactly one of burst_group_id /
-- duplicate_group_id / location_suggestion_id is populated per row,
-- matching subject_type. This is the same pattern already shipped for
-- media_shares (target_type + media_item_id/album_id XOR CHECK, see
-- migration 20260628130000_add_media_shares) — established precedent, not
-- a new idea. It was chosen over a polymorphic subject_id with no FK
-- (no referential integrity — a subject deleted mid-run would leave an
-- orphaned item row with nothing to explain what it pointed at) and over
-- three separate typed item tables under one parent (stricter, but pushes
-- per-subject-type branching into every generic handler query the
-- consolidation exists to avoid).
--
-- Execution order in this file, deliberately: (1) create the new enums and
-- BARE tables (primary keys only, no FKs/CHECKs yet); (2) copy
-- location_suggestion_runs -> review_runs and (INNER JOIN'd against
-- location_suggestions, so no orphan can slip through)
-- location_suggestion_run_items -> review_run_items, preserving every row's
-- original id so existing /location-suggestion-runs/:id links and any
-- in-flight job payloads referencing a run id stay valid; (3) THEN add the
-- full FK/CHECK/index constraint set, so the copied data is validated by
-- real constraints with no NOT VALID escape hatch; (4) drop the two old
-- tables and their now-unused enums.
--
-- Prisma's schema DSL cannot express CHECK constraints or partial unique
-- indexes, so those pieces of the exclusive-arc constraint set are
-- hand-authored here as raw SQL and are documented as intentional schema
-- drift in schema.prisma's ReviewRunItem comment — the same precedent as
-- media_items_gallery_idx / media_items_map_locations_idx.

-- =============================================================================
-- Step 1: New enums
-- =============================================================================

CREATE TYPE "ReviewRunSubject" AS ENUM ('burst_group', 'duplicate_group', 'location_suggestion');

CREATE TYPE "ReviewRunAction" AS ENUM ('resolve_archive', 'resolve_trash', 'dismiss', 'accept', 'reject');

CREATE TYPE "ReviewRunStatus" AS ENUM ('evaluating', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled');

CREATE TYPE "ReviewRunItemStatus" AS ENUM ('matched', 'processing', 'applied', 'failed', 'skipped');

-- =============================================================================
-- Step 2: New tables (bare — FKs/CHECKs/indexes added in Step 4, after the
-- data copy in Step 3, so the copy is not blocked by constraints that don't
-- exist yet and the copied rows are validated by the real constraints once
-- they land)
-- =============================================================================

CREATE TABLE "review_runs" (
    "id"               UUID                 NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"        UUID                 NOT NULL,
    "subject_type"     "ReviewRunSubject"   NOT NULL,
    "action"           "ReviewRunAction"    NOT NULL,
    "threshold"        INTEGER              NOT NULL,
    "status"           "ReviewRunStatus"    NOT NULL DEFAULT 'evaluating',
    "matched_count"    INTEGER              NOT NULL DEFAULT 0,
    "processed_count"  INTEGER              NOT NULL DEFAULT 0,
    "succeeded_count"  INTEGER              NOT NULL DEFAULT 0,
    "failed_count"     INTEGER              NOT NULL DEFAULT 0,
    "skipped_count"    INTEGER              NOT NULL DEFAULT 0,
    "started_by_id"    UUID,
    "last_error"       TEXT,
    "created_at"       TIMESTAMPTZ          NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ          NOT NULL DEFAULT now(),
    "started_at"       TIMESTAMPTZ,
    "finished_at"      TIMESTAMPTZ,

    CONSTRAINT "review_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_run_items" (
    "id"                     UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "run_id"                 UUID                   NOT NULL,
    "subject_type"           "ReviewRunSubject"     NOT NULL,
    "burst_group_id"         UUID,
    "duplicate_group_id"     UUID,
    "location_suggestion_id" UUID,
    "status"                 "ReviewRunItemStatus"  NOT NULL DEFAULT 'matched',
    "error"                  TEXT,
    "created_at"             TIMESTAMPTZ            NOT NULL DEFAULT now(),
    "updated_at"             TIMESTAMPTZ            NOT NULL DEFAULT now(),

    CONSTRAINT "review_run_items_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- Step 3: Data migration — copy location_suggestion_runs / _run_items
-- forward, preserving ids. action/status enum values are textually
-- identical between the old and new enums, so a text round-trip cast is
-- sufficient. The run_items copy INNER JOINs location_suggestions so a
-- suggestion that vanished between the old table's last write and this
-- migration is silently excluded rather than becoming an orphan the new FK
-- would reject.
-- =============================================================================

INSERT INTO "review_runs" (
    "id", "circle_id", "subject_type", "action", "threshold", "status",
    "matched_count", "processed_count", "succeeded_count", "failed_count", "skipped_count",
    "started_by_id", "last_error", "created_at", "updated_at", "started_at", "finished_at"
)
SELECT
    "id",
    "circle_id",
    'location_suggestion'::"ReviewRunSubject",
    "action"::text::"ReviewRunAction",
    "threshold",
    "status"::text::"ReviewRunStatus",
    "matched_count", "processed_count", "succeeded_count", "failed_count", "skipped_count",
    "started_by_id", "last_error", "created_at", "updated_at", "started_at", "finished_at"
FROM "location_suggestion_runs";

INSERT INTO "review_run_items" (
    "id", "run_id", "subject_type", "location_suggestion_id", "status", "error", "created_at", "updated_at"
)
SELECT
    lsri."id",
    lsri."run_id",
    'location_suggestion'::"ReviewRunSubject",
    lsri."suggestion_id",
    lsri."status"::text::"ReviewRunItemStatus",
    lsri."error",
    lsri."created_at",
    lsri."updated_at"
FROM "location_suggestion_run_items" lsri
INNER JOIN "location_suggestions" ls ON ls."id" = lsri."suggestion_id";

-- =============================================================================
-- Step 4: Constraints and indexes, added now that the copied data is in
-- place and can be validated by them directly (no NOT VALID needed).
-- =============================================================================

-- review_runs FKs
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_circle_id_fkey"
    FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE;

ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_started_by_id_fkey"
    FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- Guarantee: (id, subject_type) is unique on review_runs — the FK target
-- for review_run_items' composite FK below, which is what makes it
-- impossible for an item to belong to a run of a different subject type.
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_id_subject_type_key"
    UNIQUE ("id", "subject_type");

CREATE INDEX "review_runs_circle_id_subject_type_status_idx" ON "review_runs" ("circle_id", "subject_type", "status");
CREATE INDEX "review_runs_status_updated_at_idx" ON "review_runs" ("status", "updated_at");

-- review_run_items FKs
-- Guarantee: no dangling subject reference — three real FKs, each cascading
-- so a deleted subject removes its run-item row rather than orphaning it.
ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE;

ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_burst_group_id_fkey"
    FOREIGN KEY ("burst_group_id") REFERENCES "burst_groups"("id") ON DELETE CASCADE;

ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_duplicate_group_id_fkey"
    FOREIGN KEY ("duplicate_group_id") REFERENCES "duplicate_groups"("id") ON DELETE CASCADE;

ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_location_suggestion_id_fkey"
    FOREIGN KEY ("location_suggestion_id") REFERENCES "location_suggestions"("id") ON DELETE CASCADE;

-- Guarantee: an item can never belong to a run of a different subject type
-- than its own — composite FK against the (id, subject_type) unique
-- constraint on review_runs added above. This is on top of (not instead
-- of) the plain run_id FK above; the two do not conflict.
ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_run_id_subject_type_fkey"
    FOREIGN KEY ("run_id", "subject_type") REFERENCES "review_runs"("id", "subject_type") ON DELETE CASCADE;

-- Guarantee: exactly one subject column is populated per row.
ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_exactly_one_subject_check"
    CHECK (num_nonnulls("burst_group_id", "duplicate_group_id", "location_suggestion_id") = 1);

-- Guarantee: the populated subject column agrees with subject_type.
ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_subject_type_burst_group_check"
    CHECK (("subject_type" = 'burst_group') = ("burst_group_id" IS NOT NULL));

ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_subject_type_duplicate_group_check"
    CHECK (("subject_type" = 'duplicate_group') = ("duplicate_group_id" IS NOT NULL));

ALTER TABLE "review_run_items" ADD CONSTRAINT "review_run_items_subject_type_location_suggestion_check"
    CHECK (("subject_type" = 'location_suggestion') = ("location_suggestion_id" IS NOT NULL));

-- Guarantee: idempotency anchor per subject for batch retries (mirrors the
-- trash_empty_run_items / workflow_run_items @@unique([runId, subjectId])
-- precedent, split three ways since a single column pair can't serve all
-- three nullable FK columns). Postgres treats NULLs as distinct in a unique
-- index, so each partial index applies only to rows of its own subject
-- type — a duplicate (run_id, burst_group_id) pair is rejected while rows
-- of the other two subject types are unaffected.
CREATE UNIQUE INDEX "review_run_items_run_id_burst_group_id_key"
    ON "review_run_items" ("run_id", "burst_group_id") WHERE "burst_group_id" IS NOT NULL;

CREATE UNIQUE INDEX "review_run_items_run_id_duplicate_group_id_key"
    ON "review_run_items" ("run_id", "duplicate_group_id") WHERE "duplicate_group_id" IS NOT NULL;

CREATE UNIQUE INDEX "review_run_items_run_id_location_suggestion_id_key"
    ON "review_run_items" ("run_id", "location_suggestion_id") WHERE "location_suggestion_id" IS NOT NULL;

CREATE INDEX "review_run_items_run_id_status_idx" ON "review_run_items" ("run_id", "status");

-- =============================================================================
-- Step 5: Drop the superseded location-suggestion-only tables and enums.
-- Children before parent; enums last, once nothing references them.
-- =============================================================================

DROP TABLE "location_suggestion_run_items";

DROP TABLE "location_suggestion_runs";

DROP TYPE "LocationSuggestionRunItemStatus";

DROP TYPE "LocationSuggestionRunStatus";

DROP TYPE "LocationSuggestionRunAction";

-- Notification Center (epic #240) — schema-only foundation (issue #244).
--
-- Adds the notifications table and its NotificationType enum. No producer
-- writes a row yet and no API/UI reads one — this migration is pure schema,
-- landing ahead of the endpoints/producers that come in later child issues
-- of epic #240 (e.g. #248's retention purge, which is what the
-- (dismissed_at, updated_at) and (read_at) indexes below exist to serve).
--
-- STATE vs. EVENT notification types:
--   review_queue_bursts / review_queue_duplicates /
--   review_queue_location_suggestions / review_queue_enhancements are
--   STATE notifications — one row per (user, circle, type) tracking a
--   review queue's current pending count for that user, refreshed in place
--   rather than appended. A circle with 929 pending duplicate groups must
--   produce exactly ONE row for a given user, never 929.
--
--   upload_completed / enrichment_failed / workflow_run_completed /
--   share_expiring are EVENT notifications — one row per occurrence,
--   appended freely, never deduplicated.
--
-- DEDUP CONSTRAINT (the critical piece): a partial unique index enforces
-- "at most one LIVE (non-dismissed) row per (user_id, circle_id, type)" for
-- the four review_queue_* types only. The WHERE clause is exactly what
-- makes the four event types exempt — they never match this index's
-- predicate, so they are never deduplicated against each other. circle_id
-- IS NOT NULL is included in the predicate even though the column is
-- nullable because Postgres unique indexes treat every NULL as distinct
-- from every other NULL; without that clause, two different global
-- (circle_id = NULL) notifications of the same type for the same user would
-- silently defeat uniqueness — moot in practice since a review_queue_* row's
-- circle_id is always non-null (there is no "global" review queue), but the
-- predicate makes that invariant explicit rather than accidental.
--
-- This partial unique index is raw-SQL-only, not representable in Prisma's
-- schema DSL — the same precedent already established in this repo for
-- media_items_gallery_idx, media_items_map_locations_idx,
-- people_circle_id_hidden_at_idx, and the review_run_items partial uniques
-- (migration 20260726010000_review_runs). See the Notification model's
-- header comment in schema.prisma for the full rationale.

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE "NotificationType" AS ENUM (
    'review_queue_bursts',
    'review_queue_duplicates',
    'review_queue_location_suggestions',
    'review_queue_enhancements',
    'upload_completed',
    'enrichment_failed',
    'workflow_run_completed',
    'share_expiring'
);

-- -----------------------------------------------------------------------------
-- Table: notifications
-- -----------------------------------------------------------------------------

CREATE TABLE "notifications" (
    "id"            UUID                NOT NULL DEFAULT gen_random_uuid(),
    "user_id"       UUID                NOT NULL,
    "circle_id"     UUID,
    "type"          "NotificationType"  NOT NULL,
    "title"         TEXT                NOT NULL,
    "body"          TEXT,
    "link"          TEXT,
    "data"          JSONB,
    "read_at"       TIMESTAMPTZ,
    "dismissed_at"  TIMESTAMPTZ,
    "created_at"    TIMESTAMPTZ         NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ         NOT NULL DEFAULT now(),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "notifications_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Unread-count query and unread filter.
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications" ("user_id", "read_at");

-- Paginated list, newest first.
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" ("user_id", "created_at" DESC);

-- Dismissed filtering.
CREATE INDEX "notifications_user_id_dismissed_at_idx" ON "notifications" ("user_id", "dismissed_at");

-- Serves the #248 retention purge (dismissed rows gone stale by update time).
CREATE INDEX "notifications_dismissed_at_updated_at_idx" ON "notifications" ("dismissed_at", "updated_at");

-- Serves the #248 retention purge (unread-forever sweep).
CREATE INDEX "notifications_read_at_idx" ON "notifications" ("read_at");

-- Guarantee: at most one LIVE row per (user_id, circle_id, type) for the
-- four review_queue_* STATE types — see this file's header comment for the
-- full state-vs-event rationale. Event types (upload_completed,
-- enrichment_failed, workflow_run_completed, share_expiring) never match
-- this predicate and are therefore exempt, appended freely per occurrence.
CREATE UNIQUE INDEX "notifications_review_queue_live_uniq_idx"
    ON "notifications" ("user_id", "circle_id", "type")
    WHERE "dismissed_at" IS NULL
      AND "circle_id" IS NOT NULL
      AND "type" IN (
          'review_queue_bursts',
          'review_queue_duplicates',
          'review_queue_location_suggestions',
          'review_queue_enhancements'
      );

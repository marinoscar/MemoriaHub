-- Location Inference migration: add coord_source provenance column to
-- media_items, add LocationSuggestionStatus enum and location_suggestions
-- table, and add a device-timeline scan index used by the interpolation
-- algorithm.
--
-- coord_source records where taken_lat/taken_lng came from:
--   'exif'     - read directly from the file's EXIF GPS tags
--   'manual'   - set by a user (via bulk edit or the properties pane)
--   'inferred' - filled in by the location-inference feature (interpolated
--                between, or copied from, chronologically nearby items from
--                the same device that do have coordinates)
-- null means the item has no coordinates at all.
--
-- location_suggestions holds one candidate coordinate guess per media item
-- that currently lacks coordinates but has usable timeline neighbors.
-- anchor_before_id / anchor_after_id intentionally have NO database-level FK
-- constraint (mirrors the media_visual_embedding.circle_id "denormalized, no
-- FK" precedent from the duplicate-detection migration) so that deleting the
-- anchor media item never blocks or cascades against a pending suggestion row.
--
-- The final index below (idx_media_circle_device_captured) is a partial index
-- that Prisma cannot express (WHERE clause), so it is added here only and is
-- intentionally NOT reflected in schema.prisma — same precedent as
-- people_circle_id_hidden_at_idx in migration 20260628000000_person_hidden_at.

-- -----------------------------------------------------------------------------
-- Column: media_items.coord_source
-- -----------------------------------------------------------------------------

ALTER TABLE "media_items" ADD COLUMN "coord_source" TEXT;

-- Backfill provenance for existing rows that already have coordinates.
-- Rows whose geo_source is 'manual' were set by a human (bulk edit / manual
-- pin drop) - preserve that as coord_source='manual'. Every other row that
-- has coordinates got them from the uploaded file's EXIF GPS tags.
UPDATE "media_items"
    SET "coord_source" = 'manual'
    WHERE "geo_source" = 'manual';

UPDATE "media_items"
    SET "coord_source" = 'exif'
    WHERE "taken_lat" IS NOT NULL
      AND ("geo_source" IS DISTINCT FROM 'manual');

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE "LocationSuggestionStatus" AS ENUM ('pending', 'accepted', 'rejected', 'auto_applied', 'reverted');

-- -----------------------------------------------------------------------------
-- Table: location_suggestions
-- -----------------------------------------------------------------------------

CREATE TABLE "location_suggestions" (
    "id"                  UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "media_item_id"       UUID                       NOT NULL,
    "circle_id"           UUID                       NOT NULL,
    "lat"                 DOUBLE PRECISION           NOT NULL,
    "lng"                 DOUBLE PRECISION           NOT NULL,
    "confidence"          DOUBLE PRECISION           NOT NULL,
    "method"              TEXT                       NOT NULL,
    "anchor_before_id"    UUID,
    "anchor_after_id"     UUID,
    "gap_before_seconds"  INTEGER,
    "gap_after_seconds"   INTEGER,
    "anchor_distance_km"  DOUBLE PRECISION,
    "implied_speed_kmh"   DOUBLE PRECISION,
    "status"              "LocationSuggestionStatus" NOT NULL DEFAULT 'pending',
    "resolved_by_id"      UUID,
    "resolved_at"         TIMESTAMPTZ,
    "created_at"          TIMESTAMPTZ                NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ                NOT NULL DEFAULT now(),

    CONSTRAINT "location_suggestions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_suggestions_media_item_id_key" UNIQUE ("media_item_id"),
    CONSTRAINT "location_suggestions_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE,
    CONSTRAINT "location_suggestions_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "location_suggestions_resolved_by_id_fkey"
        FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "location_suggestions_circle_id_status_idx" ON "location_suggestions" ("circle_id", "status");

-- -----------------------------------------------------------------------------
-- Device-timeline scan index (raw SQL only; not representable in Prisma)
-- -----------------------------------------------------------------------------

-- Serves the interpolation algorithm's per-device chronological neighbor scan:
-- for a media item with no coordinates, find the nearest preceding/following
-- items from the same circle + camera that are not soft-deleted. A partial
-- index (WHERE deleted_at IS NULL) keeps the index small and excludes rows
-- that can never be useful anchors.
CREATE INDEX idx_media_circle_device_captured
  ON media_items (circle_id, camera_make, camera_model, captured_at)
  WHERE deleted_at IS NULL;

-- Burst Detection migration: add BurstGroupStatus enum, burst_groups table,
-- burst-related columns on media_items, burst_detection_enabled flag on circles,
-- and resolvedBursts back-relation on users.
--
-- burst_groups groups temporally-adjacent near-duplicate photos (bursts) within
-- a circle. status tracks review progress (pending → resolved or dismissed).
-- suggestedBestItemId is a nullable FK to the media item scored highest by the
-- burst-quality heuristic. resolvedById / resolvedAt record who actioned the group.
-- mediaCount is a denormalized count for list views (updated by the worker).
-- capturedAt is the group start time used for chronological sorting.
--
-- Four new nullable columns land on media_items:
--   perceptual_hash  BIGINT  — 64-bit dHash for near-duplicate detection;
--                              NOTE: BigInt maps to JS BigInt which is JSON-unsafe —
--                              API responses MUST stringify this field.
--   sharpness_score  DOUBLE PRECISION — variance-of-Laplacian for best-shot ranking.
--   burst_uuid       TEXT    — Apple EXIF MakerNote BurstUUID (groups same shutter burst).
--   burst_score      DOUBLE PRECISION — composite quality score assigned by the worker.
--   burst_group_id   UUID FK → burst_groups (SET NULL on group delete).
--
-- circles gains a burst_detection_enabled flag (default false) mirroring the
-- existing face_recognition_enabled / auto_tagging_enabled opt-in pattern.

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE "BurstGroupStatus" AS ENUM ('pending', 'resolved', 'dismissed');

-- -----------------------------------------------------------------------------
-- Table: burst_groups
-- -----------------------------------------------------------------------------

CREATE TABLE "burst_groups" (
    "id"                    UUID             NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"             UUID             NOT NULL,
    "status"                "BurstGroupStatus" NOT NULL DEFAULT 'pending',
    "suggested_best_item_id" UUID,
    "media_count"           INTEGER          NOT NULL DEFAULT 0,
    "captured_at"           TIMESTAMPTZ,
    "resolved_by_id"        UUID,
    "resolved_at"           TIMESTAMPTZ,
    "created_at"            TIMESTAMPTZ      NOT NULL DEFAULT now(),
    "updated_at"            TIMESTAMPTZ      NOT NULL DEFAULT now(),

    CONSTRAINT "burst_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "burst_groups_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "burst_groups_suggested_best_item_id_fkey"
        FOREIGN KEY ("suggested_best_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL,
    CONSTRAINT "burst_groups_resolved_by_id_fkey"
        FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "burst_groups_circle_id_status_idx" ON "burst_groups" ("circle_id", "status");
CREATE INDEX "burst_groups_captured_at_idx"       ON "burst_groups" ("captured_at");

-- -----------------------------------------------------------------------------
-- Columns: media_items (burst detection fields)
-- -----------------------------------------------------------------------------

ALTER TABLE "media_items"
    ADD COLUMN "perceptual_hash"  BIGINT,
    ADD COLUMN "sharpness_score"  DOUBLE PRECISION,
    ADD COLUMN "burst_uuid"       TEXT,
    ADD COLUMN "burst_score"      DOUBLE PRECISION,
    ADD COLUMN "burst_group_id"   UUID;

-- FK from media_items.burst_group_id → burst_groups.id
ALTER TABLE "media_items"
    ADD CONSTRAINT "media_items_burst_group_id_fkey"
        FOREIGN KEY ("burst_group_id") REFERENCES "burst_groups"("id") ON DELETE SET NULL;

CREATE INDEX "media_items_burst_uuid_idx"       ON "media_items" ("burst_uuid");
CREATE INDEX "media_items_burst_group_id_idx"   ON "media_items" ("burst_group_id");

-- -----------------------------------------------------------------------------
-- Column: circles (burst detection opt-in flag)
-- -----------------------------------------------------------------------------

ALTER TABLE "circles"
    ADD COLUMN "burst_detection_enabled" BOOLEAN NOT NULL DEFAULT false;

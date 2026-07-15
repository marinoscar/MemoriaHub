-- AI Picture Enhancer migration: add the MediaEnhancementStatus /
-- MediaEnhancementDecision enums and the media_enhancements table.
--
-- One row per AI-enhancement run requested against a source media item. The
-- enhanced bytes are staged (staging_storage_key / staging_provider /
-- staging_bucket) rather than written directly onto the source item, so the
-- user can preview original-vs-enhanced before deciding:
--   keep_both -> creates a NEW media item (tracked via result_media_item_id),
--                original untouched
--   replace   -> overwrites the source item's bytes (destructive edit path)
--
-- enhanced_size is BIGINT to mirror storage_objects.size (GB-scale byte
-- counts); it is serialized as a string in API responses per the project's
-- "never return a raw BigInt" rule.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "MediaEnhancementStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'applied', 'discarded', 'expired');

CREATE TYPE "MediaEnhancementDecision" AS ENUM ('keep_both', 'replace');

-- -----------------------------------------------------------------------------
-- Table: media_enhancements
-- -----------------------------------------------------------------------------

CREATE TABLE "media_enhancements" (
    "id"                   UUID                       NOT NULL DEFAULT gen_random_uuid(),
    "media_item_id"        UUID                       NOT NULL,
    "circle_id"            UUID                       NOT NULL,
    "status"               "MediaEnhancementStatus"   NOT NULL DEFAULT 'pending',
    "decision"             "MediaEnhancementDecision",
    "params"               JSONB,
    "provider"             TEXT                       NOT NULL,
    "model"                TEXT                       NOT NULL,
    "prompt"               TEXT,
    "staging_storage_key"  TEXT,
    "staging_provider"     TEXT,
    "staging_bucket"       TEXT,
    "original_width"       INTEGER,
    "original_height"      INTEGER,
    "enhanced_width"       INTEGER,
    "enhanced_height"      INTEGER,
    "enhanced_size"        BIGINT,
    "result_media_item_id" UUID,
    "last_error"           TEXT,
    "created_by_id"        UUID,
    "created_at"           TIMESTAMPTZ                NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ                NOT NULL DEFAULT now(),

    CONSTRAINT "media_enhancements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_enhancements_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "media_enhancements_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "media_enhancements_result_media_item_id_fkey"
        FOREIGN KEY ("result_media_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "media_enhancements_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX "media_enhancements_media_item_id_status_idx" ON "media_enhancements"("media_item_id", "status");

CREATE INDEX "media_enhancements_circle_id_status_idx" ON "media_enhancements"("circle_id", "status");

CREATE INDEX "media_enhancements_status_updated_at_idx" ON "media_enhancements"("status", "updated_at");

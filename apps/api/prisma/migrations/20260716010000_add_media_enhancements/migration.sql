-- AI Picture Enhancer migration: add MediaEnhancementStatus and
-- MediaEnhancementDecision enums plus the media_enhancements table.
--
-- media_enhancements holds one row per AI-enhancement run requested against a
-- source MediaItem (media_item_id). The enhanced bytes are staged
-- (staging_storage_key / staging_provider / staging_bucket) rather than
-- written directly onto the source item, so a user can preview the result
-- before deciding: 'keep_both' (creates a new MediaItem, tracked via
-- result_media_item_id) or 'replace' (overwrites the source item's bytes).
--
-- status tracks the lifecycle: pending -> processing -> ready -> (applied |
-- discarded | expired), with 'failed' available from pending/processing.
-- decision is null until the user (or an expiry sweep) resolves a 'ready' row.
--
-- enhanced_size mirrors storage_objects.size (BIGINT) since enhancement output
-- can be GB-scale like any other stored media object.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "MediaEnhancementStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'applied', 'discarded', 'expired');

CREATE TYPE "MediaEnhancementDecision" AS ENUM ('keep_both', 'replace');

-- -----------------------------------------------------------------------------
-- Table: media_enhancements
-- -----------------------------------------------------------------------------

CREATE TABLE "media_enhancements" (
    "id"                    UUID                        NOT NULL DEFAULT gen_random_uuid(),
    "media_item_id"         UUID                        NOT NULL,
    "circle_id"             UUID                        NOT NULL,
    "status"                "MediaEnhancementStatus"    NOT NULL DEFAULT 'pending',
    "decision"              "MediaEnhancementDecision",
    "params"                JSONB,
    "provider"              TEXT                        NOT NULL,
    "model"                 TEXT                        NOT NULL,
    "prompt"                TEXT,
    "staging_storage_key"   TEXT,
    "staging_provider"      TEXT,
    "staging_bucket"        TEXT,
    "original_width"        INTEGER,
    "original_height"       INTEGER,
    "enhanced_width"        INTEGER,
    "enhanced_height"       INTEGER,
    "enhanced_size"         BIGINT,
    "result_media_item_id"  UUID,
    "last_error"            TEXT,
    "created_by_id"         UUID,
    "created_at"            TIMESTAMPTZ                 NOT NULL DEFAULT now(),
    "updated_at"            TIMESTAMPTZ                 NOT NULL DEFAULT now(),

    CONSTRAINT "media_enhancements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_enhancements_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE,
    CONSTRAINT "media_enhancements_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "media_enhancements_result_media_item_id_fkey"
        FOREIGN KEY ("result_media_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL,
    CONSTRAINT "media_enhancements_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "media_enhancements_media_item_id_status_idx" ON "media_enhancements" ("media_item_id", "status");
CREATE INDEX "media_enhancements_circle_id_status_idx"     ON "media_enhancements" ("circle_id", "status");
CREATE INDEX "media_enhancements_status_updated_at_idx"    ON "media_enhancements" ("status", "updated_at");

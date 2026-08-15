-- AI Picture Enhancer — Bulk Enhance batching (epic #420, issue #421, Phase 1).
--
-- Data model only — no service/controller logic lands in this migration.
--
-- media_enhancement_batches holds one row per bulk "AI Enhance" request
-- against multiple MediaItems in a circle. requestedCount is how many items
-- the caller asked to enhance; queuedCount is how many media_enhancements
-- rows were actually created (requestedCount minus anything skipped up
-- front, recorded in `skipped`). `source` distinguishes how the batch was
-- formed (e.g. "selection" for a gallery multi-select) for future entry
-- points.
--
-- media_enhancements gains a nullable batch_id grouping column, set only for
-- enhancements created as part of a batch request. ON DELETE SET NULL is
-- deliberate: deleting a batch record must never delete the enhancements it
-- produced, which may already be 'applied' — mirrors the existing
-- media_enhancements_result_media_item_id_fkey SetNull precedent.

-- -----------------------------------------------------------------------------
-- Table: media_enhancement_batches
-- -----------------------------------------------------------------------------

CREATE TABLE "media_enhancement_batches" (
    "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"       UUID        NOT NULL,
    "requested_count" INTEGER     NOT NULL,
    "queued_count"    INTEGER     NOT NULL DEFAULT 0,
    "skipped"         JSONB,
    "params"          JSONB,
    "source"          TEXT        NOT NULL DEFAULT 'selection',
    "cancelled_at"    TIMESTAMPTZ,
    "last_error"      TEXT,
    "created_by_id"   UUID,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "media_enhancement_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_enhancement_batches_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "media_enhancement_batches_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "media_enhancement_batches_circle_id_created_at_idx" ON "media_enhancement_batches" ("circle_id", "created_at");

-- -----------------------------------------------------------------------------
-- Table: media_enhancements — add batch_id grouping column
-- -----------------------------------------------------------------------------

ALTER TABLE "media_enhancements" ADD COLUMN "batch_id" UUID;

CREATE INDEX "media_enhancements_batch_id_idx" ON "media_enhancements" ("batch_id");

ALTER TABLE "media_enhancements" ADD CONSTRAINT "media_enhancements_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "media_enhancement_batches"("id") ON DELETE SET NULL;

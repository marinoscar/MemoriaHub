-- Visual De-duplication migration: add SimilarityGroupStatus enum, similarity_groups
-- table, visual-dedup columns on media_items (similarity_group_id, similarity_score,
-- dhash_bits), visual_dedup_enabled flag on circles, and a back-relation on users.
--
-- similarity_groups groups library-wide near-duplicate photos (by dHash Hamming
-- distance only, no temporal/device window) within a circle. status tracks review
-- progress (pending → resolved or dismissed). suggestedBestItemId is a nullable FK
-- to the media item judged highest-quality within the group. resolvedById / resolvedAt
-- record who actioned the group. mediaCount is a denormalized count for list views.
--
-- Three new nullable columns land on media_items:
--   similarity_group_id   UUID FK → similarity_groups (SET NULL on group delete).
--   similarity_score      DOUBLE PRECISION — composite quality/similarity score.
--   dhash_bits            bit(64) — 64-bit dHash stored as a native bit string so
--                          pgvector bit_hamming_ops can be used for HNSW approximate
--                          nearest-neighbour search. Written/read via $queryRaw only;
--                          declared as Unsupported("bit(64)") in schema.prisma.
--
-- circles gains a visual_dedup_enabled flag (default false) mirroring the existing
-- face_recognition_enabled / auto_tagging_enabled / burst_detection_enabled pattern.
--
-- NOTE on HNSW index for dhash_bits:
--   bit_hamming_ops requires pgvector >= 0.7. The index creation is wrapped in a DO
--   block that catches undefined_object / feature_not_supported so that a missing
--   operator class does NOT abort the migration. App code falls back to an in-process
--   JS Hamming matcher when the index is absent.

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE "SimilarityGroupStatus" AS ENUM ('pending', 'resolved', 'dismissed');

-- -----------------------------------------------------------------------------
-- Table: similarity_groups
-- -----------------------------------------------------------------------------

CREATE TABLE "similarity_groups" (
    "id"                     UUID                    NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"              UUID                    NOT NULL,
    "status"                 "SimilarityGroupStatus" NOT NULL DEFAULT 'pending',
    "suggested_best_item_id" UUID,
    "media_count"            INTEGER                 NOT NULL DEFAULT 0,
    "resolved_by_id"         UUID,
    "resolved_at"            TIMESTAMPTZ,
    "created_at"             TIMESTAMPTZ             NOT NULL DEFAULT now(),
    "updated_at"             TIMESTAMPTZ             NOT NULL DEFAULT now(),

    CONSTRAINT "similarity_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "similarity_groups_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "similarity_groups_suggested_best_item_id_fkey"
        FOREIGN KEY ("suggested_best_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL,
    CONSTRAINT "similarity_groups_resolved_by_id_fkey"
        FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "similarity_groups_circle_id_status_idx" ON "similarity_groups" ("circle_id", "status");
CREATE INDEX "similarity_groups_created_at_idx"        ON "similarity_groups" ("created_at");

-- -----------------------------------------------------------------------------
-- Columns: media_items (visual dedup fields)
-- -----------------------------------------------------------------------------

ALTER TABLE "media_items"
    ADD COLUMN "similarity_group_id" UUID,
    ADD COLUMN "similarity_score"    DOUBLE PRECISION;

-- FK from media_items.similarity_group_id → similarity_groups.id
ALTER TABLE "media_items"
    ADD CONSTRAINT "media_items_similarity_group_id_fkey"
        FOREIGN KEY ("similarity_group_id") REFERENCES "similarity_groups"("id") ON DELETE SET NULL;

CREATE INDEX "media_items_similarity_group_id_idx" ON "media_items" ("similarity_group_id");

-- dhash_bits: native bit(64) column for pgvector bit_hamming_ops HNSW search.
-- Must be added via raw SQL because Prisma does not support the bit(n) type natively.
-- App code reads/writes this column exclusively via $queryRaw.
ALTER TABLE "media_items"
    ADD COLUMN "dhash_bits" bit(64);

-- HNSW approximate nearest-neighbour index using Hamming distance on bit(64).
-- Requires pgvector >= 0.7 with bit_hamming_ops operator class.
-- Wrapped in a DO block so an older pgvector silently skips index creation;
-- the application falls back to an in-process JS Hamming matcher in that case.
DO $$ BEGIN
    CREATE INDEX "media_items_dhash_bits_hnsw_idx"
        ON "media_items" USING hnsw ("dhash_bits" bit_hamming_ops);
EXCEPTION
    WHEN undefined_object OR feature_not_supported THEN
        RAISE NOTICE 'bit_hamming_ops operator class unavailable (pgvector < 0.7); '
                     'skipping HNSW index on media_items.dhash_bits. '
                     'App will use JS fallback Hamming matcher.';
END $$;

-- -----------------------------------------------------------------------------
-- Column: circles (visual dedup opt-in flag)
-- -----------------------------------------------------------------------------

ALTER TABLE "circles"
    ADD COLUMN "visual_dedup_enabled" BOOLEAN NOT NULL DEFAULT false;

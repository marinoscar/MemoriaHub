-- Near-Duplicate Detection migration: add DuplicateGroupStatus enum, duplicate_groups
-- table, duplicate-detection columns on media_items, and the media_visual_embedding
-- raw-SQL vector table used for visual similarity search.
--
-- duplicate_groups groups near-duplicate photos within a circle, mirroring the
-- burst_groups review-queue pattern. status tracks review progress (pending →
-- resolved or dismissed). suggestedBestItemId is a nullable FK to the media item
-- scored highest by the duplicate-quality heuristic. resolvedById / resolvedAt
-- record who actioned the group. mediaCount is a denormalized count for list views.
--
-- media_items gains one new nullable column:
--   duplicate_group_id  UUID FK → duplicate_groups (SET NULL on group delete).
--
-- media_visual_embedding stores a 512-d visual embedding per media item for
-- perceptual/visual near-duplicate search via pgvector cosine similarity. Kept as
-- a separate table (like media_item_embedding) because Prisma cannot read/write
-- Unsupported vector columns directly via the ORM; raw SQL is used for all vector
-- reads/writes. circle_id is a plain denormalized column (no FK) for efficient
-- circle-scoped filtering.

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE "DuplicateGroupStatus" AS ENUM ('pending', 'resolved', 'dismissed');

-- -----------------------------------------------------------------------------
-- Table: duplicate_groups
-- -----------------------------------------------------------------------------

CREATE TABLE "duplicate_groups" (
    "id"                     UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"              UUID                   NOT NULL,
    "status"                 "DuplicateGroupStatus" NOT NULL DEFAULT 'pending',
    "suggested_best_item_id" UUID,
    "media_count"            INTEGER                NOT NULL DEFAULT 0,
    "resolved_by_id"         UUID,
    "resolved_at"            TIMESTAMPTZ,
    "created_at"             TIMESTAMPTZ            NOT NULL DEFAULT now(),
    "updated_at"             TIMESTAMPTZ            NOT NULL DEFAULT now(),

    CONSTRAINT "duplicate_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "duplicate_groups_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "duplicate_groups_suggested_best_item_id_fkey"
        FOREIGN KEY ("suggested_best_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL,
    CONSTRAINT "duplicate_groups_resolved_by_id_fkey"
        FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "duplicate_groups_circle_id_status_idx" ON "duplicate_groups" ("circle_id", "status");

-- -----------------------------------------------------------------------------
-- Column: media_items (duplicate detection field)
-- -----------------------------------------------------------------------------

ALTER TABLE "media_items"
    ADD COLUMN "duplicate_group_id" UUID;

-- FK from media_items.duplicate_group_id → duplicate_groups.id
ALTER TABLE "media_items"
    ADD CONSTRAINT "media_items_duplicate_group_id_fkey"
        FOREIGN KEY ("duplicate_group_id") REFERENCES "duplicate_groups"("id") ON DELETE SET NULL;

CREATE INDEX "media_items_duplicate_group_id_idx" ON "media_items" ("duplicate_group_id");

-- Hash-only fallback scan index (circle-scoped perceptual hash lookups when no
-- visual embedding is available for an item).
CREATE INDEX "media_items_circle_id_perceptual_hash_idx" ON "media_items" ("circle_id", "perceptual_hash");

-- -----------------------------------------------------------------------------
-- Table: media_visual_embedding (raw SQL, not modeled in Prisma)
-- -----------------------------------------------------------------------------

-- pgvector extension is already enabled by migration 20260620030000_add_media_embeddings;
-- IF NOT EXISTS makes this idempotent/safe to repeat here.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "media_visual_embedding" (
  "media_item_id" uuid PRIMARY KEY REFERENCES "media_items"("id") ON DELETE CASCADE,
  "circle_id" uuid NOT NULL,
  "embedding" vector(512) NOT NULL,
  "model" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "media_visual_embedding_circle_idx" ON "media_visual_embedding" ("circle_id");

-- Force a serial (non-parallel) HNSW build. pgvector's parallel index build
-- allocates dynamic shared memory in /dev/shm; on the Docker default 64MB shm
-- this fails with "could not resize shared memory segment ... No space left on
-- device" (SQLSTATE 53100). A serial build uses private maintenance_work_mem
-- instead and is immune to a small /dev/shm. Session-scoped; resets on connect.
SET max_parallel_maintenance_workers = 0;

CREATE INDEX "media_visual_embedding_hnsw_idx"
  ON "media_visual_embedding" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

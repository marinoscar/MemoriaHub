-- Enable pgvector extension (idempotent; requires PostgreSQL 11+ with pgvector installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- Stores a 1536-d text embedding (OpenAI text-embedding-3-small) per media item.
-- Kept as a separate table because Prisma cannot read/write Unsupported vector columns
-- directly via the ORM; raw SQL is used for all vector reads/writes.
-- circle_id is a plain denormalized column (no FK) for efficient circle-scoped filtering.
CREATE TABLE "media_item_embedding" (
  "media_item_id" uuid PRIMARY KEY REFERENCES "media_items"("id") ON DELETE CASCADE,
  "circle_id"     uuid NOT NULL,
  "embedding"     vector(1536) NOT NULL,
  "model"         text NOT NULL,
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

-- Index for circle-scoped queries (e.g. list all embeddings in a circle)
CREATE INDEX "media_item_embedding_circle_idx" ON "media_item_embedding" ("circle_id");

-- HNSW index for fast approximate cosine-similarity search via pgvector
CREATE INDEX "media_item_embedding_hnsw_idx"
  ON "media_item_embedding" USING hnsw ("embedding" vector_cosine_ops);

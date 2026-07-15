-- pgvector KNN Face Matching, Phase 1 (issue #112): add a pgvector `vector(128)`
-- mirror column to the faces table so face-to-face similarity search can use an
-- HNSW index instead of the current in-process cosine loop over `embedding` (a
-- variable-dimension Float[] column; 128-d for the compreface mobilenet provider,
-- 1024-d for the human WASM provider — the vector column below only ever holds
-- the 128-d rows).
--
-- IMPORTANT — embedding_vec is a DERIVED / GENERATED-BY-TRIGGER column:
--   * It is automatically kept in sync with `embedding` by the
--     `faces_sync_embedding_vec` trigger (installed below) on every INSERT and on
--     any UPDATE that changes `embedding`.
--   * No application writer — the photo detection path, the video detection path,
--     the distributed worker-node result-ingestion path, or the manual
--     people-association path (`POST /api/media/:id/people`, which stores an
--     empty embedding array) — ever needs to write `embedding_vec` directly. They
--     only ever write `embedding`; the trigger does the rest.
--   * Application code, including Prisma, must NEVER write to this column
--     directly. See the `embeddingVec` field comment in schema.prisma — its
--     `Unsupported` type intentionally makes it unreadable/unwritable through the
--     Prisma client, so this is enforced by the type system as well as by
--     convention.
--   * The column is NULL whenever `embedding` is not a 128-d array: this covers
--     the `human` provider's 1024-d embeddings, and empty-array rows such as
--     manual face associations (`providerKey='manual'`, empty embedding).
--
-- Statement order is deliberate: the HNSW indexes are built AFTER the one-shot
-- backfill (steps 1-5 before 6-7) so index construction sees the fully-backfilled
-- column in one pass, rather than being degraded by many small incremental
-- inserts while the backfill is still running.

-- -----------------------------------------------------------------------------
-- 1. Ensure the pgvector extension is available (idempotent — already created by
--    earlier migrations such as 20260620030000_add_media_embeddings, but this
--    migration must not assume ordering-sensitive prerequisites).
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- 2. Add the nullable vector column. Nullable + no default makes this a
--    metadata-only catalog change (instant DDL, no table rewrite, no long lock),
--    which matters because `faces` can be a large table.
-- -----------------------------------------------------------------------------
ALTER TABLE "faces" ADD COLUMN "embedding_vec" vector(128);

-- -----------------------------------------------------------------------------
-- 3. Helper function: convert a float8[] embedding into a pgvector value.
--    Uses the text-literal-cast form ('[1,2,3]'::vector) rather than a direct
--    float8[]::vector cast, because a direct array cast is not guaranteed to
--    exist across pgvector versions. Returns NULL for any array that is not
--    exactly 128-d (covers the 1024-d human-provider rows and empty arrays —
--    array_length() returns NULL for an empty array, which fails the `= 128`
--    check and therefore also yields NULL here, not an error).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION face_embedding_to_vector(embedding float8[])
RETURNS vector
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF array_length(embedding, 1) = 128 THEN
    RETURN ('[' || array_to_string(embedding, ',') || ']')::vector;
  END IF;
  RETURN NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Trigger: keep embedding_vec in sync with embedding automatically.
--    Implemented as TWO triggers sharing one function rather than a single
--    combined "BEFORE INSERT OR UPDATE ... WHEN (...)" trigger, because a
--    trigger's WHEN clause can only reference NEW/OLD row columns — the special
--    variable TG_OP is NOT visible there (it is only visible inside the trigger
--    function body), so "WHEN (TG_OP = 'INSERT' OR ...)" fails to parse
--    ("column tg_op does not exist"). Splitting into an unconditional INSERT
--    trigger and a guarded UPDATE trigger reproduces the exact intended
--    semantics without that pitfall:
--      * INSERT: always fires (every new row gets embedding_vec computed).
--      * UPDATE: only fires when `embedding` itself actually changed (IS
--        DISTINCT FROM correctly handles NULL on either side). This means the
--        very frequent person_id-only updates (face-to-person assignment) and
--        hidden_at-only updates (archive/unarchive) do NOT pay the cost of
--        recomputing and re-casting the vector on every such write.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION faces_sync_embedding_vec()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.embedding_vec := face_embedding_to_vector(NEW.embedding);
  RETURN NEW;
END;
$$;

CREATE TRIGGER faces_sync_embedding_vec_insert_trigger
  BEFORE INSERT ON "faces"
  FOR EACH ROW
  EXECUTE FUNCTION faces_sync_embedding_vec();

CREATE TRIGGER faces_sync_embedding_vec_update_trigger
  BEFORE UPDATE ON "faces"
  FOR EACH ROW
  WHEN (NEW.embedding IS DISTINCT FROM OLD.embedding)
  EXECUTE FUNCTION faces_sync_embedding_vec();

-- -----------------------------------------------------------------------------
-- 5. One-shot backfill for all existing rows. Only touches rows whose embedding
--    is exactly 128-d; 1024-d (human provider) rows and empty-array rows
--    (array_length = NULL) are correctly skipped and left NULL.
-- -----------------------------------------------------------------------------
UPDATE "faces"
SET "embedding_vec" = face_embedding_to_vector("embedding")
WHERE array_length("embedding", 1) = 128;

-- -----------------------------------------------------------------------------
-- 6. Main HNSW index for general KNN face-similarity search (cosine distance),
--    mirroring the m/ef_construction values used by the other HNSW indexes in
--    this codebase (media_visual_embedding, media_item_embedding).
--
--    Force a serial (non-parallel) HNSW build first. pgvector's parallel index
--    build allocates dynamic shared memory in /dev/shm; on the Docker default
--    64MB shm this fails with "could not resize shared memory segment ... No
--    space left on device" (SQLSTATE 53100) — which is exactly what took this
--    migration (and the api) down on 2026-07-15. A serial build uses private
--    maintenance_work_mem instead and is immune to a small /dev/shm. The setting
--    is session-scoped, so it also covers the step-7 partial index below.
-- -----------------------------------------------------------------------------
SET max_parallel_maintenance_workers = 0;

CREATE INDEX "faces_embedding_vec_hnsw_idx"
  ON "faces" USING hnsw ("embedding_vec" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- -----------------------------------------------------------------------------
-- 7. Partial HNSW index scoped to the selective archive-matching query shape:
--    unassigned (person_id IS NULL) AND archived/hidden (hidden_at IS NOT NULL)
--    faces — the reference-set candidate pool used by the face-auto-archive
--    feature (see faces_sync_embedding_vec above and hiddenReason /
--    'auto_archive_match' in the faces table). Keeping this partial and separate
--    from the main index (6) lets Postgres pick a much smaller, faster index for
--    that specific access pattern instead of scanning/filtering the full-table
--    HNSW index.
-- -----------------------------------------------------------------------------
CREATE INDEX "faces_embedding_vec_archive_hnsw_idx"
  ON "faces" USING hnsw ("embedding_vec" vector_cosine_ops)
  WHERE "person_id" IS NULL AND "hidden_at" IS NOT NULL;

-- Standardize on CompreFace (issue #113): drop the Rekognition-only
-- external_face_id column/index and purge inert legacy Human-provider face
-- rows.
--
-- This migration folds together two related cleanups from the same
-- provider-removal effort rather than shipping them as two migrations:
--
--   1. external_face_id existed ONLY to support AWS Rekognition's delegated
--      (no-embedding) face matching (FaceMatchingService.matchFaceByExternalId).
--      With Rekognition removed as a face provider, the column and its
--      single-column index (faces_external_face_id_idx, Prisma's
--      auto-generated name for `@@index([externalFaceId])`, created by the
--      original 20260617000000_add_face_recognition migration) are dead
--      weight. Production has ZERO Rekognition-produced Face rows, so this
--      is a plain schema drop — no data migration needed.
--
--   2. Separately, production carries ~125 legacy Face rows with
--      provider_key = 'human' — 1024-dimensional embeddings from the removed
--      Human WASM provider. These are permanently incompatible with the
--      compreface-only 128-d `vector(128)` world (see embedding_vec /
--      faces_sync_embedding_vec in 20260715000000_add_face_embedding_vector,
--      which already only ever populates embedding_vec for exactly-128-d
--      arrays — human-provider rows have always been NULL there). Rather
--      than leave inert, unmatchable rows behind, this migration hard-deletes
--      them outright. This is scoped narrowly to provider_key = 'human' Face
--      rows only — no media_items or other Face rows are touched. An admin
--      can regenerate face detection for affected media at any time via
--      POST /api/admin/face/backfill.
--
-- Execution order note: the DELETE (step 1) and the DROP INDEX/COLUMN
-- (steps 2-3) touch entirely unrelated things — provider_key row content
-- vs. the external_face_id column/index — so their relative order doesn't
-- matter functionally. They're just placed together here because they're
-- one logical "remove non-CompreFace face-provider residue" cleanup.
--
-- embedding_vec, its sync trigger, and its three HNSW indexes
-- (faces_embedding_vec_hnsw_idx, faces_embedding_vec_archive_hnsw_idx,
-- faces_embedding_vec_assigned_hnsw_idx) are CompreFace's existing working
-- infrastructure and are explicitly OUT OF SCOPE for this migration.

-- -----------------------------------------------------------------------------
-- 1. Purge legacy Human-provider face rows (1024-d embeddings, permanently
--    incompatible with the compreface-only 128-d world).
-- -----------------------------------------------------------------------------
DELETE FROM "faces" WHERE "provider_key" = 'human';

-- -----------------------------------------------------------------------------
-- 2. Drop the Rekognition-only external_face_id index.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS "faces_external_face_id_idx";

-- -----------------------------------------------------------------------------
-- 3. Drop the Rekognition-only external_face_id column.
-- -----------------------------------------------------------------------------
ALTER TABLE "faces" DROP COLUMN IF EXISTS "external_face_id";

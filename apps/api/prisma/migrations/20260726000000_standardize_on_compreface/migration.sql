-- Standardize on CompreFace as the only face-recognition provider (issue #113).
--
-- PROBLEM:
--   The face module currently supports three providers: `human` (keyless WASM,
--   in-process), `compreface` (keyless `compreface-core` sidecar), and
--   `rekognition` (delegated AWS, requires credentials). `human` and
--   `rekognition` are being removed from the codebase in a companion
--   backend-dev change, leaving `compreface` as the sole supported provider.
--   Left behind, this migration's target rows would reference providers the
--   application no longer knows how to construct, breaking face detection
--   ("Unknown face provider") and littering the `faces` table with orphaned
--   provider data.
--
-- FIX (in order — order matters, see each step):
--   1. Reset `media_face_status` for every item that owns a `human` or
--      `rekognition` face back to `not_processed`, BEFORE the faces are
--      deleted (step 2), while `faces.provider_key` still identifies the
--      affected items. This makes the existing app-wide
--      `POST /api/admin/face/backfill` endpoint pick these items back up and
--      re-run detection through `compreface` without any new admin tooling.
--   2. Delete the legacy `faces` rows themselves (~125 `human` rows, 0
--      `rekognition` rows in production as of this writing).
--   3. Delete stored `face_provider_credentials` rows for the removed
--      providers (only `rekognition` ever stores real credentials here —
--      `human` is keyless — but both are cleared for completeness).
--   4. Repoint `system_settings` (key='global') so the active face-detection
--      provider/model at JSONB path `{face,features,detection,*}` no longer
--      names a removed provider — otherwise the very next face-detection job
--      throws "Unknown face provider" before an admin ever visits the UI.
--   5. Drop the Rekognition-only `external_face_id` column and its index (0
--      rows depend on it).
--
-- NOT RECOVERABLE BY ROLLBACK:
--   Step 2's DELETE is NOT reversible by the commented-out rollback DDL
--   below — deleted face rows (bounding boxes, embeddings, video timestamps)
--   are gone. This is intentional: the recovery path is re-running face
--   detection via `POST /api/admin/face/backfill` (which step 1 primes),
--   not restoring old rows from a provider that no longer exists in the
--   application. The rollback section only covers step 5 (the dropped
--   column), which is schema-only and safe to reverse.
--
-- UNTOUCHED:
--   - `faces` rows with `provider_key = 'manual'` (manual person associations,
--     see the Face Recognition — Manual People Association API) are not
--     matched by any WHERE clause here and are left completely alone.
--   - `people.cover_face_id` has `ON DELETE SET NULL` (see schema.prisma), so
--     a Person whose cover photo was one of the deleted faces simply loses
--     its cover face — no Person row is deleted or cascaded.
--   - `faces.embedding_vec` (pgvector, 128-d) is unaffected: the deleted rows
--     were either `human` (1024-d, already NULL in `embedding_vec`) or
--     `rekognition` (delegated, empty `embedding`, already NULL too). The
--     `faces_sync_embedding_vec` trigger and the three HNSW indexes are not
--     touched by this migration.

-- 1. Reset per-item face status so the existing global face backfill
--    endpoint (POST /api/admin/face/backfill) re-enqueues these items.
--    Must run BEFORE step 2 deletes the faces that identify them.
UPDATE "media_face_status"
SET
  "status" = 'not_processed',
  "provider_key" = NULL,
  "model_version" = NULL,
  "face_count" = 0,
  "processed_at" = NULL,
  "last_error" = NULL
WHERE "media_item_id" IN (
  SELECT DISTINCT "media_item_id"
  FROM "faces"
  WHERE "provider_key" IN ('human', 'rekognition')
);

-- 2. Delete the legacy face rows themselves. `provider_key = 'manual'` rows
--    are untouched. `people.cover_face_id` is ON DELETE SET NULL, so this
--    never cascades into deleting a Person — it only clears a stale cover
--    face pointer.
DELETE FROM "faces" WHERE "provider_key" IN ('human', 'rekognition');

-- 3. Delete stored credentials for the removed providers.
DELETE FROM "face_provider_credentials" WHERE "provider" IN ('human', 'rekognition');

-- 4a. Repoint the active detection provider to 'compreface' wherever it
--     currently names a removed provider. Guarded with `#>>` (returns NULL,
--     not an error, when the path doesn't exist) so a fresh install with no
--     `face` key in its settings JSONB is unaffected.
UPDATE "system_settings"
SET "value" = jsonb_set("value", '{face,features,detection,provider}', '"compreface"'::jsonb, true)
WHERE "key" = 'global'
  AND "value" #>> '{face,features,detection,provider}' IN ('human', 'rekognition');

-- 4b. Null out the stored model whenever it isn't a CompreFace model id — a
--     Human/Rekognition model string is meaningless to CompreFace, and an
--     admin must explicitly re-select a model via PUT /api/face/features/detection.
--     This also covers rows just repointed by 4a (their old model string
--     survived that jsonb_set untouched).
UPDATE "system_settings"
SET "value" = jsonb_set("value", '{face,features,detection,model}', 'null'::jsonb, true)
WHERE "key" = 'global'
  AND "value" #>> '{face,features,detection,provider}' = 'compreface'
  AND COALESCE("value" #>> '{face,features,detection,model}', '') NOT LIKE 'compreface-%';

-- 5. Drop the Rekognition-only delegated-recognition column and its index.
DROP INDEX IF EXISTS "faces_external_face_id_idx";
ALTER TABLE "faces" DROP COLUMN "external_face_id";

-- =============================================================================
-- ROLLBACK (step 5 only — see "NOT RECOVERABLE BY ROLLBACK" above for why
-- steps 1-4 have no rollback path)
-- =============================================================================
-- ALTER TABLE "faces" ADD COLUMN "external_face_id" TEXT;
-- CREATE INDEX "faces_external_face_id_idx" ON "faces" ("external_face_id");

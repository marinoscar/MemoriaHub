-- Standardize on CompreFace (issue #113): drop the Rekognition-only
-- region column from face_provider_credentials.
--
-- This is a follow-up to the prior 20260725010000_drop_face_external_id_and_human_provider
-- migration from the same provider-removal effort. `region` existed only to
-- store AWS Rekognition's configured AWS region (mirroring the now-dropped
-- Face.externalFaceId, which existed only to support Rekognition's
-- delegated, no-embedding face matching). With Rekognition removed as a
-- face provider and all application TypeScript code that read/wrote this
-- field already removed, the column is dead weight. Same rationale as the
-- prior external_face_id drop: a plain schema drop, no data migration
-- needed.

-- -----------------------------------------------------------------------------
-- 1. Drop the Rekognition-only region column.
-- -----------------------------------------------------------------------------
ALTER TABLE "face_provider_credentials" DROP COLUMN IF EXISTS "region";

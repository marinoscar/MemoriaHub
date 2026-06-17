-- Face Recognition migration: add face_provider_credentials, people, faces,
-- face_jobs, and media_face_status tables, plus three supporting enums.
--
-- face_provider_credentials mirrors ai_provider_credentials: AES-256-GCM
-- encrypted API keys; last4 is the only visible hint; provider is plain TEXT so
-- new providers (compreface, rekognition, …) need no schema change.
--
-- people is a per-circle concept linking a named person to their detected faces.
-- The self-relation merged_into_id keeps an audit breadcrumb when two clusters
-- are merged; the source person is soft-deleted, target gets the faces.
-- cover_face_id (nullable FK to faces) is the chosen representative crop for UI.
--
-- faces stores one row per detected face bounding box. embedding is Float[] for
-- the pgvector-optional fallback; a follow-up optional migration can convert to
-- a native vector(512) column + hnsw index when pgvector is available.
-- circle_id is denormalized (also carried on media_item via its circle_id) to
-- avoid a join on every RBAC check and cosine-match query.
--
-- face_jobs is the background-worker queue table (no BullMQ). Workers claim
-- rows with UPDATE … RETURNING; status tracks progress; attempts + last_error
-- support retry logic.
--
-- media_face_status is a per-media-item tracking row (upserted by the worker).
-- It answers "has this item been processed? by which provider/model? when?"
-- without scanning the faces table.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE "FaceJobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');
CREATE TYPE "FaceJobReason" AS ENUM ('upload', 'rerun', 'backfill');
CREATE TYPE "MediaFaceStatusType" AS ENUM ('not_processed', 'pending', 'processing', 'processed', 'failed', 'no_faces');

-- -----------------------------------------------------------------------------
-- Table: face_provider_credentials
-- -----------------------------------------------------------------------------

CREATE TABLE "face_provider_credentials" (
    "id"                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    "provider"            TEXT        NOT NULL,
    "encrypted_key"       TEXT        NOT NULL,
    "base_url"            TEXT,
    "region"              TEXT,
    "last4"               TEXT        NOT NULL,
    "enabled"             BOOLEAN     NOT NULL DEFAULT true,
    "updated_by_user_id"  UUID,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "face_provider_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "face_provider_credentials_provider_key" UNIQUE ("provider"),
    CONSTRAINT "face_provider_credentials_updated_by_user_id_fkey"
        FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

-- -----------------------------------------------------------------------------
-- Table: people
-- -----------------------------------------------------------------------------

CREATE TABLE "people" (
    "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
    "circle_id"      UUID        NOT NULL,
    "name"           TEXT,
    "added_by_id"    UUID        NOT NULL,
    "cover_face_id"  UUID,
    "merged_into_id" UUID,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at"     TIMESTAMPTZ,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "people_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "people_added_by_id_fkey"
        FOREIGN KEY ("added_by_id") REFERENCES "users"("id"),
    CONSTRAINT "people_merged_into_id_fkey"
        FOREIGN KEY ("merged_into_id") REFERENCES "people"("id") ON DELETE SET NULL
    -- cover_face_id FK is added after faces table is created (see below)
);

CREATE INDEX "people_circle_id_idx"     ON "people" ("circle_id");
CREATE INDEX "people_merged_into_id_idx" ON "people" ("merged_into_id");

-- -----------------------------------------------------------------------------
-- Table: faces
-- -----------------------------------------------------------------------------

CREATE TABLE "faces" (
    "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
    "media_item_id"    UUID        NOT NULL,
    "circle_id"        UUID        NOT NULL,
    "person_id"        UUID,
    "bounding_box"     JSONB       NOT NULL,
    "confidence"       DOUBLE PRECISION,
    "landmarks"        JSONB,
    "embedding"        DOUBLE PRECISION[],
    "external_face_id" TEXT,
    "provider_key"     TEXT        NOT NULL,
    "model_version"    TEXT        NOT NULL,
    "manually_assigned" BOOLEAN    NOT NULL DEFAULT false,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "faces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "faces_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE,
    CONSTRAINT "faces_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE,
    CONSTRAINT "faces_person_id_fkey"
        FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE SET NULL
);

CREATE INDEX "faces_circle_id_idx"       ON "faces" ("circle_id");
CREATE INDEX "faces_media_item_id_idx"   ON "faces" ("media_item_id");
CREATE INDEX "faces_person_id_idx"       ON "faces" ("person_id");
CREATE INDEX "faces_external_face_id_idx" ON "faces" ("external_face_id");

-- Add cover_face_id FK now that faces table exists
ALTER TABLE "people"
    ADD CONSTRAINT "people_cover_face_id_fkey"
        FOREIGN KEY ("cover_face_id") REFERENCES "faces"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- Table: face_jobs
-- -----------------------------------------------------------------------------

CREATE TABLE "face_jobs" (
    "id"            UUID            NOT NULL DEFAULT gen_random_uuid(),
    "media_item_id" UUID            NOT NULL,
    "circle_id"     UUID            NOT NULL,
    "status"        "FaceJobStatus" NOT NULL DEFAULT 'pending',
    "reason"        "FaceJobReason" NOT NULL,
    "provider_key"  TEXT,
    "model_version" TEXT,
    "attempts"      INTEGER         NOT NULL DEFAULT 0,
    "last_error"    TEXT,
    "created_at"    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    "started_at"    TIMESTAMPTZ,
    "finished_at"   TIMESTAMPTZ,

    CONSTRAINT "face_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "face_jobs_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE,
    CONSTRAINT "face_jobs_circle_id_fkey"
        FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE
);

CREATE INDEX "face_jobs_status_created_at_idx" ON "face_jobs" ("status", "created_at");
CREATE INDEX "face_jobs_media_item_id_idx"     ON "face_jobs" ("media_item_id");

-- -----------------------------------------------------------------------------
-- Table: media_face_status
-- -----------------------------------------------------------------------------

CREATE TABLE "media_face_status" (
    "id"             UUID                  NOT NULL DEFAULT gen_random_uuid(),
    "media_item_id"  UUID                  NOT NULL,
    "status"         "MediaFaceStatusType" NOT NULL DEFAULT 'not_processed',
    "provider_key"   TEXT,
    "model_version"  TEXT,
    "face_count"     INTEGER               NOT NULL DEFAULT 0,
    "processed_at"   TIMESTAMPTZ,
    "last_error"     TEXT,
    "updated_at"     TIMESTAMPTZ           NOT NULL DEFAULT now(),

    CONSTRAINT "media_face_status_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_face_status_media_item_id_key" UNIQUE ("media_item_id"),
    CONSTRAINT "media_face_status_media_item_id_fkey"
        FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE
);

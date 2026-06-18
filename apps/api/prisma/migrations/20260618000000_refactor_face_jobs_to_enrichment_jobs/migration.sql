-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "JobReason" AS ENUM ('upload', 'rerun', 'backfill');

-- CreateTable enrichment_jobs
CREATE TABLE "enrichment_jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "media_item_id" UUID NOT NULL,
    "circle_id" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "reason" "JobReason" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "provider_key" TEXT,
    "model_version" TEXT,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "enrichment_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrichment_jobs_status_priority_created_at_idx" ON "enrichment_jobs"("status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "enrichment_jobs_media_item_id_idx" ON "enrichment_jobs"("media_item_id");

-- CreateIndex
CREATE INDEX "enrichment_jobs_type_status_idx" ON "enrichment_jobs"("type", "status");

-- AddForeignKey
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigrate: copy existing face_jobs rows into enrichment_jobs
INSERT INTO "enrichment_jobs" (
    "id", "type", "media_item_id", "circle_id",
    "status", "reason", "priority",
    "provider_key", "model_version",
    "attempts", "last_error",
    "created_at", "started_at", "finished_at"
)
SELECT
    "id",
    'face_detection',
    "media_item_id",
    "circle_id",
    "status"::text::"JobStatus",
    "reason"::text::"JobReason",
    0,
    "provider_key",
    "model_version",
    "attempts",
    "last_error",
    "created_at",
    "started_at",
    "finished_at"
FROM "face_jobs";

-- DropTable
DROP TABLE "face_jobs";

-- DropEnum
DROP TYPE "FaceJobStatus";

-- DropEnum
DROP TYPE "FaceJobReason";

-- Migration: social_media_detection
-- 1. Add is_system column to tags + composite index (circleId, isSystem)
-- 2. Add 'system' value to MediaTagSource enum
-- 3. Create MediaSocialStatusType enum
-- 4. Create media_social_status table with FK constraints and indexes

-- AlterTable: tags — add is_system column (default false, not null)
ALTER TABLE "tags" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: tags composite index on (circle_id, is_system)
CREATE INDEX "tags_circle_id_is_system_idx" ON "tags"("circle_id", "is_system");

-- AlterEnum: add 'system' to MediaTagSource
-- PostgreSQL ALTER TYPE ... ADD VALUE cannot run inside a transaction block;
-- Prisma migrations run each statement individually so this is safe.
ALTER TYPE "MediaTagSource" ADD VALUE 'system';

-- CreateEnum: MediaSocialStatusType
CREATE TYPE "MediaSocialStatusType" AS ENUM ('not_processed', 'pending', 'processing', 'processed', 'failed');

-- CreateTable: media_social_status
-- Mirrors media_metadata_status / media_geocode_status patterns.
CREATE TABLE "media_social_status" (
    "id"           UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "circle_id"    UUID NOT NULL,
    "status"       "MediaSocialStatusType" NOT NULL DEFAULT 'not_processed',
    "detected"     BOOLEAN NOT NULL DEFAULT false,
    "platform"     TEXT,
    "score"        DOUBLE PRECISION,
    "processed_at" TIMESTAMPTZ,
    "last_error"   TEXT,
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_social_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: media_social_status unique on media_item_id
CREATE UNIQUE INDEX "media_social_status_media_item_id_key" ON "media_social_status"("media_item_id");

-- CreateIndex: media_social_status circle_id
CREATE INDEX "media_social_status_circle_id_idx" ON "media_social_status"("circle_id");

-- CreateIndex: media_social_status status
CREATE INDEX "media_social_status_status_idx" ON "media_social_status"("status");

-- AddForeignKey: media_social_status -> media_items (media_item_id)
ALTER TABLE "media_social_status" ADD CONSTRAINT "media_social_status_media_item_id_fkey"
    FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: media_social_status -> circles (circle_id)
ALTER TABLE "media_social_status" ADD CONSTRAINT "media_social_status_circle_id_fkey"
    FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

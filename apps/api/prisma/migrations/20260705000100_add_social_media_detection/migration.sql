-- CreateEnum
CREATE TYPE "MediaSocialStatusType" AS ENUM ('not_processed', 'pending', 'processing', 'processed', 'failed');

-- AlterTable
ALTER TABLE "media_items" ADD COLUMN     "social_media_source" TEXT;

-- CreateTable
CREATE TABLE "media_social_status" (
    "id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "status" "MediaSocialStatusType" NOT NULL DEFAULT 'not_processed',
    "is_social_media" BOOLEAN NOT NULL DEFAULT false,
    "platform" TEXT,
    "detection_method" TEXT,
    "confidence" DOUBLE PRECISION,
    "matched_rule" TEXT,
    "processed_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_social_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_social_status_media_item_id_key" ON "media_social_status"("media_item_id");

-- CreateIndex
CREATE INDEX "media_social_status_status_idx" ON "media_social_status"("status");

-- AddForeignKey
ALTER TABLE "media_social_status" ADD CONSTRAINT "media_social_status_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

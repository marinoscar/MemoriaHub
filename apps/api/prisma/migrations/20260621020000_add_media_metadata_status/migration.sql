-- CreateEnum
CREATE TYPE "MediaMetadataStatusType" AS ENUM ('not_processed', 'pending', 'processing', 'processed', 'failed');

-- CreateTable
CREATE TABLE "media_metadata_status" (
    "id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "circle_id" UUID NOT NULL,
    "status" "MediaMetadataStatusType" NOT NULL DEFAULT 'not_processed',
    "processed_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_metadata_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_metadata_status_media_item_id_key" ON "media_metadata_status"("media_item_id");

-- CreateIndex
CREATE INDEX "media_metadata_status_circle_id_idx" ON "media_metadata_status"("circle_id");

-- CreateIndex
CREATE INDEX "media_metadata_status_status_idx" ON "media_metadata_status"("status");

-- AddForeignKey
ALTER TABLE "media_metadata_status" ADD CONSTRAINT "media_metadata_status_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_metadata_status" ADD CONSTRAINT "media_metadata_status_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

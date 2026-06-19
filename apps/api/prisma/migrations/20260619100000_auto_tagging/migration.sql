-- CreateEnum
CREATE TYPE "MediaTagStatusType" AS ENUM ('not_processed', 'pending', 'processing', 'processed', 'failed');

-- AlterTable
ALTER TABLE "circles" ADD COLUMN "auto_tagging_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tag_labels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tag_labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_tag_status" (
    "id" UUID NOT NULL,
    "media_item_id" UUID NOT NULL,
    "circle_id" UUID NOT NULL,
    "status" "MediaTagStatusType" NOT NULL DEFAULT 'not_processed',
    "provider_key" TEXT,
    "model_version" TEXT,
    "tag_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_tag_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tag_labels_name_key" ON "tag_labels"("name");

-- CreateIndex
CREATE UNIQUE INDEX "media_tag_status_media_item_id_key" ON "media_tag_status"("media_item_id");

-- CreateIndex
CREATE INDEX "media_tag_status_circle_id_idx" ON "media_tag_status"("circle_id");

-- CreateIndex
CREATE INDEX "media_tag_status_status_idx" ON "media_tag_status"("status");

-- AddForeignKey
ALTER TABLE "media_tag_status" ADD CONSTRAINT "media_tag_status_media_item_id_fkey" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_tag_status" ADD CONSTRAINT "media_tag_status_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

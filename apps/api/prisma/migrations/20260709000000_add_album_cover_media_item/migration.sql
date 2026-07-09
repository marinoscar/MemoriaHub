-- AlterTable
ALTER TABLE "albums" ADD COLUMN "cover_media_item_id" UUID;

-- AddForeignKey
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_media_item_id_fkey"
  FOREIGN KEY ("cover_media_item_id")
  REFERENCES "media_items"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "albums_cover_media_item_id_idx" ON "albums"("cover_media_item_id");

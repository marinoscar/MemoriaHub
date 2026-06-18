-- AlterTable
ALTER TABLE "people" ADD COLUMN "profile_media_item_id" UUID,
                     ADD COLUMN "profile_crop" JSONB;

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_profile_media_item_id_fkey"
  FOREIGN KEY ("profile_media_item_id")
  REFERENCES "media_items"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "people_profile_media_item_id_idx" ON "people"("profile_media_item_id");

-- AlterTable
ALTER TABLE "media_items" ADD COLUMN "origin_burst_group_id" UUID,
                          ADD COLUMN "origin_duplicate_group_id" UUID;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_origin_burst_group_id_fkey"
  FOREIGN KEY ("origin_burst_group_id")
  REFERENCES "burst_groups"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_origin_duplicate_group_id_fkey"
  FOREIGN KEY ("origin_duplicate_group_id")
  REFERENCES "duplicate_groups"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "media_items_origin_burst_group_id_idx" ON "media_items"("origin_burst_group_id");

-- CreateIndex
CREATE INDEX "media_items_origin_duplicate_group_id_idx" ON "media_items"("origin_duplicate_group_id");

-- AlterTable
ALTER TABLE "media_items" ADD COLUMN "archived_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "media_items_archived_at_idx" ON "media_items"("archived_at");

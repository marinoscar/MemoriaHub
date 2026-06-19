-- AlterTable
ALTER TABLE "people" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "people_circle_id_favorite_idx" ON "people"("circle_id", "favorite");

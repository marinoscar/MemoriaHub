-- AlterTable
ALTER TABLE "burst_groups" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "kept_count" INTEGER,
ADD COLUMN     "removed_count" INTEGER,
ADD COLUMN     "resolution_action" TEXT;

-- AlterTable
ALTER TABLE "duplicate_groups" ADD COLUMN     "kept_count" INTEGER,
ADD COLUMN     "removed_count" INTEGER,
ADD COLUMN     "resolution_action" TEXT;

-- CreateIndex
CREATE INDEX "burst_groups_circle_id_status_resolution_action_idx" ON "burst_groups"("circle_id", "status", "resolution_action");

-- CreateIndex
CREATE INDEX "duplicate_groups_circle_id_status_resolution_action_idx" ON "duplicate_groups"("circle_id", "status", "resolution_action");

-- DropIndex
DROP INDEX "media_items_classification_idx";

-- AlterTable
ALTER TABLE "media_items" DROP COLUMN "classification";

-- DropEnum
DROP TYPE "MediaClassification";

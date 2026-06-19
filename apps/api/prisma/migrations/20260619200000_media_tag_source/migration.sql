-- CreateEnum
CREATE TYPE "MediaTagSource" AS ENUM ('manual', 'ai');

-- AlterTable
ALTER TABLE "media_tags" ADD COLUMN     "source" "MediaTagSource" NOT NULL DEFAULT 'manual';

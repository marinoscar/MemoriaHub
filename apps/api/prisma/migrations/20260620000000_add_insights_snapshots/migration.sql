-- CreateEnum
CREATE TYPE "InsightsSnapshotStatus" AS ENUM ('computing', 'ready', 'failed');

-- CreateTable
CREATE TABLE "insights_snapshots" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "status"      "InsightsSnapshotStatus" NOT NULL DEFAULT 'computing',
    "metrics"     JSONB,
    "computed_at" TIMESTAMPTZ,
    "duration_ms" INTEGER,
    "error"       TEXT,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insights_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insights_snapshots_created_at_idx" ON "insights_snapshots"("created_at");

-- AlterTable
ALTER TABLE "enrichment_jobs" ADD COLUMN "scheduled_for" TIMESTAMPTZ;
ALTER TABLE "enrichment_jobs" ADD COLUMN "rate_limited_at" TIMESTAMPTZ;
ALTER TABLE "enrichment_jobs" ADD COLUMN "rate_limit_hits" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "enrichment_jobs_status_scheduled_for_priority_created_at_idx" ON "enrichment_jobs"("status", "scheduled_for", "priority", "created_at");

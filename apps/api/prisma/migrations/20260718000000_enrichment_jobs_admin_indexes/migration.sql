-- Two indexes on enrichment_jobs serving the admin dashboard's polling
-- queries, which currently seq-scan the table and contributed to API
-- brownouts during bulk imports (when the table is at its largest):
--
--   1. claimed_by_node_id — the admin WorkersPage polls
--      groupBy(['claimedByNodeId','status']) every 5s
--      (nodes.service.ts getJobCountsForNodes). Without an index on the
--      grouping/filter column every poll is a full seq scan.
--
--   2. created_at DESC — the admin JobsPage default listing orders by
--      createdAt desc with NO status filter
--      (enrichment-admin.service.ts listJobs). None of the existing indexes
--      lead with created_at, so the default page is a seq scan + sort.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the table is bounded by the nightly
-- job_history_purge (terminal rows older than jobs.history.retentionDays are
-- deleted), so it stays small enough that the brief write lock at deploy time
-- is fine — and Prisma migrations run inside a transaction, where
-- CONCURRENTLY is not allowed anyway.
--
-- DOWN DIRECTION:
--   DROP INDEX "enrichment_jobs_claimed_by_node_id_idx";
--   DROP INDEX "enrichment_jobs_created_at_idx";

-- CreateIndex
CREATE INDEX "enrichment_jobs_claimed_by_node_id_idx" ON "enrichment_jobs"("claimed_by_node_id");

-- CreateIndex
CREATE INDEX "enrichment_jobs_created_at_idx" ON "enrichment_jobs"("created_at" DESC);

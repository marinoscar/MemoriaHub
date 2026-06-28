-- Lifetime job stats rollup.
--
-- Preserves per-type aggregate counts and total duration of terminal
-- enrichment_jobs rows BEFORE they are deleted by the nightly job_history_purge,
-- so all-time analytics and the insights dashboard's lifetime totals survive
-- history purging. The purge handler folds each batch it deletes into this table
-- in the same transaction, so no row is counted twice or lost.
--
-- Only exactly-mergeable aggregates are kept (counts + total duration → average).
-- Percentiles are NOT stored here; they remain computed live over the recent
-- window. sum_duration_ms is DOUBLE PRECISION (exact for integers up to 2^53 ms)
-- to avoid the JSON-unsafe BigInt pitfall on API responses.

-- CreateTable
CREATE TABLE "job_stats_rollup" (
    "type" TEXT NOT NULL,
    "succeeded_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "sum_duration_ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration_samples" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "job_stats_rollup_pkey" PRIMARY KEY ("type")
);

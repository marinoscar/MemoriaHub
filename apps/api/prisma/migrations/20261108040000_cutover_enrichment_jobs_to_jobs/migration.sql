-- RETRO-C1 (issue #575): cutover of the background queue from MemoriaHub's own
-- `enrichment_jobs` to the platform `jobs` table (@marinoscar/platform-api/jobs).
--
-- What this migration does, in one transaction:
--
--   1. Copies EVERY `enrichment_jobs` row into `jobs`, keeping its uuid (admin
--      links and logs stay valid) and its `type` string (permanent).
--      - subject: a media item -> ('media_item', id); no media item but a circle
--        -> ('circle', id); neither -> a global (system) job with no subject.
--        A job with BOTH keeps the circle as `payload.circleId` (the adapter
--        reads it back into the `circle_id` the handlers still expect).
--      - status: pending, succeeded, failed 1:1. `running` -> `pending` with
--        `started_at`, the claim and the lease cleared, so the new worker runs it
--        again (attempts keeps what the old claim charged).
--      - `org_id`: the default organization for a job with a subject, NULL for a
--        global job (housekeeping).
--      - `dedup_key`: set (as `buildDedupKey` builds it) on the OLDEST active row
--        of each (type, subject) so an in-flight bulk import still dedups after
--        the cutover; every other row keeps NULL, which is exempt from the
--        partial unique index `jobs_active_dedup_uniq_idx`.
--   2. Folds `mh_legacy_job_stats_rollup` (the lifetime aggregate of already
--      purged jobs) into the platform `job_stats_rollup` and drops it.
--   3. Retires `enrichment_jobs`: releases every node claim, drops its three
--      foreign keys (a frozen archive must not block the drop of
--      `mh_legacy_worker_nodes` or cascade from `media_items`) and its two
--      partial (raw-SQL) indexes, then renames the table and its remaining
--      indexes to `enrichment_jobs_legacy`. It is dropped by a follow-up
--      migration one release later.
--
-- The count check at the end aborts (and rolls the whole migration back) if a
-- row went missing. Never edit this file once committed: platform.lock records
-- its hash, and comments count.

BEGIN;

SELECT set_config('app.rls_bypass', 'on', true);

-- 1a. Release the node claims on the archive, so the legacy node plane can never
--     settle a job that now runs from `jobs`.
UPDATE "enrichment_jobs"
   SET "claimed_by_node_id" = NULL, "lease_expires_at" = NULL
 WHERE "status" IN ('pending', 'running');

-- 1b. Copy.
INSERT INTO "jobs" (
  "id", "type", "subject_type", "subject_id", "dedup_key", "status", "reason", "priority",
  "provider_key", "model_version", "payload", "attempts", "last_error", "created_at",
  "started_at", "finished_at", "scheduled_for", "rate_limited_at", "rate_limit_hits",
  "claimed_by_node_id", "lease_expires_at", "executor", "claim_token", "trace_context", "org_id"
)
WITH mapped AS (
  SELECT
    e."id",
    e."type",
    CASE
      WHEN e."media_item_id" IS NOT NULL THEN 'media_item'
      WHEN e."circle_id" IS NOT NULL THEN 'circle'
    END AS "subject_type",
    COALESCE(e."media_item_id"::text, e."circle_id"::text) AS "subject_id",
    (CASE WHEN e."status"::text = 'running' THEN 'pending' ELSE e."status"::text END) AS "status",
    e."reason"::text AS "reason",
    e."priority",
    e."provider_key",
    e."model_version",
    CASE
      WHEN e."media_item_id" IS NOT NULL AND e."circle_id" IS NOT NULL
        THEN COALESCE(e."payload", '{}'::jsonb) || jsonb_build_object('circleId', e."circle_id")
      ELSE e."payload"
    END AS "payload",
    e."attempts",
    e."last_error",
    e."created_at",
    CASE WHEN e."status"::text = 'running' THEN NULL ELSE e."started_at" END AS "started_at",
    e."finished_at",
    e."scheduled_for",
    e."rate_limited_at",
    e."rate_limit_hits",
    CASE WHEN e."status"::text = 'running' THEN NULL ELSE e."executor" END AS "executor"
  FROM "enrichment_jobs" e
),
ranked AS (
  SELECT m.*,
    CASE
      WHEN m."status" = 'pending' THEN
        row_number() OVER (
          PARTITION BY m."type", COALESCE(m."subject_type", ''), COALESCE(m."subject_id", '')
          ORDER BY m."created_at", m."id"
        )
    END AS "active_rank"
  FROM mapped m
)
SELECT
  r."id",
  r."type",
  r."subject_type",
  r."subject_id",
  CASE
    WHEN r."active_rank" = 1 AND NOT EXISTS (
      SELECT 1 FROM "jobs" k
       WHERE k."status" IN ('pending', 'running')
         AND k."dedup_key" = r."type" || ':' || COALESCE(r."subject_type", '') || ':' || COALESCE(r."subject_id", '')
    ) THEN r."type" || ':' || COALESCE(r."subject_type", '') || ':' || COALESCE(r."subject_id", '')
  END,
  r."status"::"JobStatus",
  r."reason",
  r."priority",
  r."provider_key",
  r."model_version",
  r."payload",
  r."attempts",
  r."last_error",
  r."created_at",
  r."started_at",
  r."finished_at",
  r."scheduled_for",
  r."rate_limited_at",
  r."rate_limit_hits",
  NULL,
  NULL,
  r."executor",
  NULL,
  NULL,
  CASE
    WHEN r."subject_type" IS NOT NULL THEN (SELECT "id" FROM "organizations" WHERE "is_default" LIMIT 1)
  END
FROM ranked r
WHERE NOT EXISTS (
  SELECT 1 FROM "jobs" j WHERE j."id" = r."id"
);

-- 2. Lifetime rollup: counts and total duration are exactly mergeable.
INSERT INTO "job_stats_rollup" (
  "type", "succeeded_count", "failed_count", "sum_duration_ms", "duration_samples", "updated_at"
)
SELECT "type", "succeeded_count", "failed_count", "sum_duration_ms", "duration_samples", "updated_at"
  FROM "mh_legacy_job_stats_rollup"
ON CONFLICT ("type") DO UPDATE SET
  "succeeded_count"  = "job_stats_rollup"."succeeded_count"  + EXCLUDED."succeeded_count",
  "failed_count"     = "job_stats_rollup"."failed_count"     + EXCLUDED."failed_count",
  "sum_duration_ms"  = "job_stats_rollup"."sum_duration_ms"  + EXCLUDED."sum_duration_ms",
  "duration_samples" = "job_stats_rollup"."duration_samples" + EXCLUDED."duration_samples",
  "updated_at"       = GREATEST("job_stats_rollup"."updated_at", EXCLUDED."updated_at");

DROP TABLE "mh_legacy_job_stats_rollup";

-- 3. Retire the old table.
ALTER TABLE "enrichment_jobs" DROP CONSTRAINT "enrichment_jobs_media_item_id_fkey";
ALTER TABLE "enrichment_jobs" DROP CONSTRAINT "enrichment_jobs_circle_id_fkey";
ALTER TABLE "enrichment_jobs" DROP CONSTRAINT "enrichment_jobs_claimed_by_node_id_fkey";

DROP INDEX "enrichment_jobs_attempts_gt1_idx";
DROP INDEX "enrichment_jobs_succeeded_duration_idx";

ALTER TABLE "enrichment_jobs" RENAME TO "enrichment_jobs_legacy";

ALTER INDEX "enrichment_jobs_pkey" RENAME TO "enrichment_jobs_legacy_pkey";
ALTER INDEX "enrichment_jobs_claimed_by_node_id_idx" RENAME TO "enrichment_jobs_legacy_claimed_by_node_id_idx";
ALTER INDEX "enrichment_jobs_created_at_idx" RENAME TO "enrichment_jobs_legacy_created_at_idx";
ALTER INDEX "enrichment_jobs_media_item_id_idx" RENAME TO "enrichment_jobs_legacy_media_item_id_idx";
ALTER INDEX "enrichment_jobs_status_lease_expires_at_idx" RENAME TO "enrichment_jobs_legacy_status_lease_expires_at_idx";
ALTER INDEX "enrichment_jobs_status_priority_created_at_idx" RENAME TO "enrichment_jobs_legacy_status_priority_created_at_idx";
ALTER INDEX "enrichment_jobs_status_scheduled_for_priority_created_at_idx" RENAME TO "enrichment_jobs_legacy_status_scheduled_for_priority_create_idx";
ALTER INDEX "enrichment_jobs_status_type_id_idx" RENAME TO "enrichment_jobs_legacy_status_type_id_idx";
ALTER INDEX "enrichment_jobs_type_status_idx" RENAME TO "enrichment_jobs_legacy_type_status_idx";

-- 4. Nothing may go missing.
DO $$
DECLARE
  legacy_count bigint;
  copied_count bigint;
BEGIN
  SELECT count(*) INTO legacy_count FROM "enrichment_jobs_legacy";
  SELECT count(*) INTO copied_count
    FROM "jobs" j
   WHERE EXISTS (SELECT 1 FROM "enrichment_jobs_legacy" e WHERE e."id" = j."id");
  IF copied_count <> legacy_count THEN
    RAISE EXCEPTION 'enrichment_jobs cutover: % legacy rows, % copied', legacy_count, copied_count;
  END IF;
END $$;

COMMIT;

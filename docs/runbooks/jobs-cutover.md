# Runbook: Cut the Background Queue Over to the Platform Jobs Slice

RETRO-C1 (issue [#575](https://github.com/marinoscar/MemoriaHub/issues/575), epic #559, program #555). The background queue moved from MemoriaHub's own `enrichment_jobs` (`apps/api/src/enrichment/`) to the platform's `jobs` table (`@marinoscar/platform-api/jobs`). The 38 job handlers did not change; an adapter wraps them. This page is the operator procedure for the migration that moves the rows, the rollback, every behaviour and wire change the cutover carries, and the rehearsal record.

> **Status.** The migration was rehearsed on a **SYNTHETIC** database (section 8). The mandatory rehearsal on a **restored production backup has not been done**: do section 7 before the release that carries this change, and paste the counts and timings into the PR.

## 1. What changes

| Before | After |
|---|---|
| Table `enrichment_jobs` (model `EnrichmentJob`) | Table `jobs` (platform). `enrichment_jobs` is renamed `enrichment_jobs_legacy`: a frozen archive, dropped by a follow-up `migration-lock` PR one release later |
| `job_stats_rollup` (renamed `mh_legacy_job_stats_rollup` by RETRO-A5) | The platform `job_stats_rollup`: the old rows were merged in (counts and total duration added where both had a type) and `mh_legacy_job_stats_rollup` is dropped |
| `EnrichmentJobWorker`, `EnrichmentClaimService`, `EnrichmentTerminalService`, `ProviderThrottleService`, `EnrichmentStuckResetTask`, `TempFileJanitorTask`, `JobHistoryPurge*`, `EnrichmentAdmin*` | The platform's `JobWorker`, `JobClaimService`, `JobTerminalService`, `ProviderThrottleService`, `JobStuckResetTask`, `TempFileJanitorTask`, `JobHistoryPurgeTask` / `job.history.purge`, `JobAdminController` |
| 38 `EnrichmentHandler` classes | The same classes, registered through `LegacyEnrichmentHandlerAdapter` as platform `JobHandler`s with the same `type` |
| `ENRICHMENT_*` variables | `JOBS_*` (the old names are read for one release, section 4) |
| `/admin/settings/jobs` pages of the app | `JobsPage` / `JobInsightsPage` of `@marinoscar/platform-web/jobs/ui` |

Job `type` strings are permanent and unchanged. `job_history_purge`, whose handler is gone, is still a dispatching type: a row of it settles as a no-op (the platform's `job.history.purge` runs the purge).

### Column mapping

| `enrichment_jobs` | `jobs` | Rule |
|---|---|---|
| `id`, `type`, `priority`, `provider_key`, `model_version`, `attempts`, `last_error`, `created_at`, `finished_at`, `scheduled_for`, `rate_limited_at`, `rate_limit_hits` | same | copied (the uuid is kept, so admin links and logs stay valid) |
| `media_item_id` set | `subject_type = 'media_item'`, `subject_id` | the media item id as text |
| `circle_id` set, `media_item_id` null | `subject_type = 'circle'`, `subject_id` | the circle id as text |
| `circle_id` with `media_item_id` set | `payload.circleId` | merged into the payload; the adapter takes it back out before a handler sees the job |
| both null | both null, `org_id` null | a global (system) job |
| any row with a subject | `org_id` | the default organization |
| `status` `pending` / `succeeded` / `failed` | same | 1:1 |
| `status` `running` | `pending` | `started_at`, the node claim, the lease and `executor` cleared; `attempts` kept |
| `reason` (enum) | `reason` (text) | `upload`, `rerun`, `backfill` |
| `claimed_by_node_id`, `lease_expires_at` | NULL | legacy nodes cannot hold a platform job (section 6) |
| `executor` | same | for a settled row; cleared for a converted running row |
| none | `dedup_key` | `type:subjectType:subjectId`, set on the **oldest active row of each (type, subject)** only; every other row keeps NULL, which the unique index ignores. (The issue proposed NULL on every row; keeping the key lets an in-flight bulk import still deduplicate after the cutover, and the rule cannot collide.) |
| none | `claim_token`, `trace_context` | NULL |

Lost on purpose: the `ON DELETE CASCADE` foreign keys to `media_items` and `circles`. The adapter makes a job whose media item or circle no longer exists settle as a **no-op success** (one primary-key lookup before the handler), so a vanished subject can neither crash-loop nor fill the failure list.

## 2. Procedure (operator)

Do this in a maintenance window, with the **worker fleet stopped** (old CLI nodes cannot talk to the platform node API: until RETRO-C2 and C10 the server runs everything).

1. **Back up.** A fresh database backup (`/admin/settings/backup`, or `pg_dump` with `--enable-row-security` and `PGOPTIONS=-c app.rls_bypass=on`). Download it; the rehearsal in section 7 uses it.
2. **Stop the fleet.** `docker compose -f docker-compose.worker.yml down` on every worker host (or stop the `systemd` user unit). A node still polling gets an empty claim list and 409 on a result; it does no harm, but it does no work either.
3. **Enable maintenance mode** (`/admin/settings/maintenance`). It stops uploads, so new enqueues stop. You do not have to wait for the pending count to fall: pending rows are migrated.
4. **Deploy** the release. `npm run prisma:migrate` runs `20261108040000_cutover_enrichment_jobs_to_jobs` in one transaction (`BEGIN` / `COMMIT`); a count check at its end aborts and rolls back the whole migration if a row went missing. Restart the API (restart policy `unless-stopped`).
5. **Verify** (section 3).
6. **Disable maintenance mode.**
7. Optionally `rm -f /tmp/memoriaHub-*` on the API host once: temp files are named `memoriahub-job-*` now (the prefix the platform janitor sweeps), and orphans with the old prefix are not swept.

## 3. Verification

```sql
-- every row arrived, with its uuid:
SELECT (SELECT count(*) FROM enrichment_jobs_legacy) AS legacy, (SELECT count(*) FROM jobs) AS jobs;       -- jobs >= legacy
SELECT count(*) FROM enrichment_jobs_legacy e WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = e.id);   -- 0
-- same distribution, running now counted as pending:
SELECT type, status, count(*) FROM jobs GROUP BY 1, 2 ORDER BY 1, 2;
SELECT type, status, count(*) FROM enrichment_jobs_legacy GROUP BY 1, 2 ORDER BY 1, 2;
-- the lifetime rollup survived:
SELECT type, succeeded_count, failed_count, duration_samples FROM job_stats_rollup ORDER BY 1;
SELECT to_regclass('mh_legacy_job_stats_rollup');                                                          -- NULL
```

In the app: `/admin/settings/jobs` lists the history; `/admin/settings/jobs/insights` lifetime totals include the old rollup; `/admin/settings/doctor` shows `jobs.worker` and `jobs.backlog`; upload one photo and watch `face_detection`, `auto_tagging`, `burst_detection`, `duplicate_detection` and `location_inference` (feature flags on) reach `succeeded`; a video runs `social_media_detection` then `video_face_detection`. `npm run db:check:database`, `npm run db:baseline` (`0 blocking, 391 declared`) and `npm run db:drift` pass as described in [database-baseline.md](database-baseline.md) section 13.

## 4. Environment

The platform reads `JOBS_*`. Each old name is read for **one release**, with one deprecation warning per variable at boot; a `JOBS_*` value always wins. Nothing is mutated in `process.env`; `config/configuration.ts` feeds the translated environment to `jobsConfiguration()`.

| Old | New |
|---|---|
| `ENRICHMENT_WORKER_MODE` (`ENRICHMENT_WORKER_ENABLED=false`, `FACE_WORKER_ENABLED=false` mean `off`) | `JOBS_WORKER_MODE` |
| `ENRICHMENT_WORKER_CONCURRENCY` (`FACE_WORKER_CONCURRENCY`) | `JOBS_WORKER_CONCURRENCY` |
| `ENRICHMENT_JOB_POLL_MS` (`FACE_JOB_POLL_MS`) | `JOBS_POLL_MS` |
| `ENRICHMENT_JOB_TIMEOUT_MS` | `JOBS_JOB_TIMEOUT_MS` (the default of a type without a profile) |
| `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` | `profile.maxRuntimeMs` of `video_face_detection`, `social_media_detection`, `video_auto_tagging` (default 20 minutes; the old variable still sets it for one release; `0` = no ceiling) |
| `ENRICHMENT_MAX_ATTEMPTS`, `ENRICHMENT_RETRY_BASE_MS`, `ENRICHMENT_RETRY_MAX_MS` | `JOBS_MAX_ATTEMPTS`, `JOBS_RETRY_BASE_MS`, `JOBS_RETRY_MAX_MS` |
| `ENRICHMENT_RATELIMIT_BASE_MS`, `_MAX_MS`, `_MAX_HITS` | `JOBS_RATELIMIT_BASE_MS`, `_MAX_MS`, `_MAX_HITS` |
| `ENRICHMENT_REAPER_ENABLED` | `JOBS_REAPER_ENABLED` |
| `ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES` | `JOBS_SYSTEM_MODE_EXTRA_TYPES` (`thumbnail_repair` and `workflow_execute_batch` are always added: they are node-eligible handlers the `system` mode has always claimed on the server) |
| `ENRICHMENT_LEASE_MS`, `ENRICHMENT_STUCK_MINUTES` | **No longer read** (warning): the lease, its renewal and the reaper's patience derive from each type's `maxRuntimeMs` |
| settings `jobs.history.*`, `jobs.stuckThresholdMinutes` | unchanged keys and stored shape (now the platform's `jobs` namespace); `retention` is a new namespace (`notifications`, `notificationDeliveries`, `auditEvents`, `aiRuns`; no handler of those is mounted yet, so the nightly retention enqueues nothing) |

**Defaults that stay the old queue's** when nothing is set: one worker slot (`JOBS_WORKER_CONCURRENCY`; the platform's is 2 and the freshly generated `.env.example` ships 2) and the two pinned system-mode types. `FACE_JOB_POLL_MS` left the example file, so a new install does not warn.

## 5. Behaviour and wire changes

| Area | Change |
|---|---|
| `GET /api/admin/jobs` | Items carry `subjectType` / `subjectId` / `orgId` / `typeLabel` / `reasonLabel` / `dedupKey` instead of `mediaItemId` / `circleId`; no `payload` is published. Filters `subjectType`, `subjectId`, `orgId` are new. `status`, `type`, `page`, `pageSize`, `scheduled`, `processedWithin` are unchanged. |
| `POST /api/admin/jobs/:id/retry`, `retry-failed`, `reset-stuck`, `insights/reset-history` | **200** (they were 201). Retrying a job whose dedup key another active job holds answers 409. |
| `DELETE /api/admin/jobs/:id` | **204** with no body (it answered 200 `{ deleted: true }`); 409 with `details.reason` when the owner vetoes (a pending broadcast start or chunk job of a scheduled or sending broadcast). |
| `GET /api/admin/jobs/insights` | `generatedAt` (was `computedAt`); status counts under `live.byStatus` only; `eta` is an array per type with work outstanding (`remaining`, `avgMs`, `basis`, `estimatedMs`); `lifetime` is an array per type. `memoriahub jobs insights` and the TUI map it back (CLI 1.4.1, `normalizeJobInsights`). |
| Rate limits | The platform classifier also treats HTTP **503** as a rate limit (the old one: 429 and 529). Everything else the old classifier recognised is converted by the adapter. |
| `jobs.stuckThresholdMinutes` | Default 30 (was 3) and the bound is 1 to 10080; `jobs.history.retentionDays` accepts up to 3650. Stored values are untouched. |
| Dedup | A circle-scoped job (no media item) dedups per `(type, circle)`; before, `(type, mediaItemId IS NULL)` collapsed every circle's job of a type unless the caller passed `skipDedup`. Callers that pass `skipDedup` still do. |
| Doctor | `jobs.workerEnabled` and `jobs.queueHealth` are replaced by the platform's `jobs.worker` and `jobs.backlog` (30 app checks remain). |
| Admin cards | `Job Queue` and `Job Queue Insights` are titled `Jobs` and `Job Insights`; the routes are unchanged. "Repair missing thumbnails" stays on the Jobs page (a toolbar slot). |
| OpenAPI | The routes keep the tag `Admin: Job Queue`. |
| Events | `enrichment.job.settled` is re-emitted from the platform `job.settled`, same payload. |
| Temp files | `memoriahub-job-*` (was `memoriaHub-*`). |

## 6. The legacy node plane while the queue is the platform's

A worker node registered under the old API lives in `mh_legacy_worker_nodes`; `jobs.claimed_by_node_id` references the platform's `worker_nodes`, so a legacy node cannot hold a platform job. Until RETRO-C2 replaces the node control plane (and C10 the CLI engine):

- `POST /api/nodes/:id/claim` answers `{ jobs: [] }`;
- a node's result or failure report answers 409;
- registration, heartbeats, listing, credentials (`nod_`) and the Local Media Backup feed work as before;
- `JOBS_WORKER_MODE` should be `all` (the default): `system` would leave the node-eligible media compute unclaimed.

## 7. Rehearsal on a production backup (required before the release)

```bash
# 1. Restore the backup into a scratch database (a Postgres 16/17 with pgvector), see database-restore.md.
# 2. Record the counts that matter:
psql "$SCRATCH" -c "select status, count(*) from enrichment_jobs group by 1 order by 1" \
                -c "select count(*) from mh_legacy_job_stats_rollup"
# 3. Apply exactly like production (the API must not run against it):
cd apps/api && POSTGRES_DB=<scratch> npm run prisma:migrate        # time it
# 4. Verification queries of section 3; db:check:database, db:baseline, db:drift.
# 5. Smoke: start the API against the copy as the current superuser, open /admin/settings/jobs,
#    upload one photo, run a job.
```

Paste into the PR: the row counts before and after, the duration of step 3, and the verification output.

## 8. Rehearsal record (SYNTHETIC)

PostgreSQL 16 with pgvector, 4 vCPU shared host. The database was built through the stack's own migrations (121 earlier directories), then filled with `/var/tmp` fixtures: 78,523 `enrichment_jobs` rows (40 types x 4 statuses x 3 subject shapes, 25 `storage_migration` and 18 `memory_generation` rows queued with `skipDedup`, a 20,000-job `face_detection` import with 5,000 duplicate pending rows, 3,000 `auto_tagging` rows, 50,000 settled history rows, 120 running rows, 3 rollup rows plus one colliding platform rollup row).

| Check | Result |
|---|---|
| `prisma:migrate` (the one new migration) | applied; `psql -f migration.sql` alone: 3.8 s |
| Rows | 78,523 in `jobs` = 78,523 in `enrichment_jobs_legacy`; none missing |
| Status | pending 28,163 + running 120 became pending 28,283; succeeded 48,870 and failed 1,370 unchanged |
| Dedup keys | 23,080 set (the oldest active row of each subject); 5,203 active duplicates and the `skipDedup` batches keep NULL |
| Orgs | rows with a subject carry the default organization; global rows NULL |
| Rollup | `face_detection` 100,000 + 20,000 style merge verified in `jobs-cutover.db.spec.ts`; the colliding `auto_tagging` row summed (98,000 + 5 = 98,005) |
| Fresh database | 122 directories applied from nothing; all three tables empty |
| `db:check`, `db:check:database`, `db:compose:check` | ok (122 ledger rows match the files) |
| `db:baseline` | `0 blocking, 391 declared` (61 legacy + 330 domain) |
| `db:drift` | no statement about a `jobs`, `job_stats_rollup`, `enrichment_jobs_legacy` or `mh_legacy_job_stats_rollup` object; the rest is the Prisma default-drop and foreign-key re-add output listed in section 7 of the baseline runbook |

`apps/api/test/jobs/jobs-cutover.db.spec.ts` runs the migration SQL on fixtures of every shape in a scratch schema and asserts the mapping above (`npm test` skips it when no database is reachable).

## 9. Rollback

Before the follow-up drop, and **in this order**:

1. Stop the API. Revert the application release.
2. Restore the old names:

```sql
BEGIN;
ALTER TABLE enrichment_jobs_legacy RENAME TO enrichment_jobs;
ALTER INDEX enrichment_jobs_legacy_pkey RENAME TO enrichment_jobs_pkey;
ALTER INDEX enrichment_jobs_legacy_claimed_by_node_id_idx RENAME TO enrichment_jobs_claimed_by_node_id_idx;
ALTER INDEX enrichment_jobs_legacy_created_at_idx RENAME TO enrichment_jobs_created_at_idx;
ALTER INDEX enrichment_jobs_legacy_media_item_id_idx RENAME TO enrichment_jobs_media_item_id_idx;
ALTER INDEX enrichment_jobs_legacy_status_lease_expires_at_idx RENAME TO enrichment_jobs_status_lease_expires_at_idx;
ALTER INDEX enrichment_jobs_legacy_status_priority_created_at_idx RENAME TO enrichment_jobs_status_priority_created_at_idx;
ALTER INDEX enrichment_jobs_legacy_status_scheduled_for_priority_create_idx RENAME TO enrichment_jobs_status_scheduled_for_priority_created_at_idx;
ALTER INDEX enrichment_jobs_legacy_status_type_id_idx RENAME TO enrichment_jobs_status_type_id_idx;
ALTER INDEX enrichment_jobs_legacy_type_status_idx RENAME TO enrichment_jobs_type_status_idx;
CREATE INDEX enrichment_jobs_attempts_gt1_idx ON enrichment_jobs (attempts) WHERE attempts > 1;
CREATE INDEX enrichment_jobs_succeeded_duration_idx ON enrichment_jobs (finished_at, started_at, type)
  WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL;
ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_media_item_id_fkey FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_circle_id_fkey FOREIGN KEY (circle_id) REFERENCES circles(id) ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;
ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_claimed_by_node_id_fkey FOREIGN KEY (claimed_by_node_id) REFERENCES mh_legacy_worker_nodes(id) ON UPDATE CASCADE ON DELETE SET NULL NOT VALID;
COMMIT;
```

   (`NOT VALID` keeps existing rows whose subject was deleted since the cutover from blocking the constraint.) The `mh_legacy_job_stats_rollup` table is not restored; the merged counts stay in `job_stats_rollup`, which the reverted release does not read, so recreate it from the backup if the old insights' lifetime totals matter: `CREATE TABLE mh_legacy_job_stats_rollup (LIKE job_stats_rollup INCLUDING ALL)` and copy the rows you need.
3. **Jobs enqueued after the cutover are lost** (they are in `jobs`, which the old release does not read): re-run the admin backfills for the capabilities in use.
4. Remove the migration row from `_prisma_migrations` only if you also drop the effects above; otherwise leave the ledger as it is and restore the pre-cutover backup instead.

After the follow-up drop there is no table to rename back: restore the pre-cutover backup and revert both PRs.

## 10. Follow-ups

- **Drop `enrichment_jobs_legacy`** (a separate `migration-lock` PR, one release later): `DROP TABLE enrichment_jobs_legacy;`, remove the `EnrichmentJob` model and the `MhLegacyJobStatus` / `MhLegacyJobReason` enums from `platform-jobs.legacy.prisma`, regenerate the deviations (`scripts/baseline-deviations.mjs`) and drop the `NodesService` reads of the archive.
- RETRO-C2 (nodes), C3 to C8 (native handlers), C9 (crons enqueue-only; the `cron-enqueue-only` conformance suite), C10 (CLI engine), C11 (delete the adapter, the facade and the environment translation).

## 11. Troubleshooting

| You see | Do |
|---|---|
| Boot warnings `ENRICHMENT_X is deprecated; read as JOBS_X` | Rename the variable in the environment file (section 4) |
| `No default organization found` while enqueueing | The platform migrations 0003 to 0040 did not run; `npm run prisma:migrate` |
| Pending rows of a type nothing claims | The type has no handler in this process: `JOBS_WORKER_MODE=system` leaves node-eligible types to the fleet, and no fleet exists until C2. Use `all` |
| A video job fails at 10 minutes | The three video types carry a 20 minute profile; another type that needs longer needs a profile of its own (native `JobHandler.profile`) |
| `Skipping jobs-cutover.db.spec` | No reachable database, or `jobs` is missing: migrate a scratch database first |
| `memoriaHub-*` files accumulate in `/tmp` | Pre-cutover orphans; remove them once. New files are `memoriahub-job-*` and are swept |

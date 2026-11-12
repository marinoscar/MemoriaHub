# Legacy removal checklist (jobs and nodes shims)

What of the one-release compatibility layer of RETRO-C is still in `apps/api` and `apps/cli`, what was deleted, and the exact release or condition for each remaining piece. It is the checklist RETRO-C11 (#620) is to close; the rows of [local-exceptions.md](local-exceptions.md) point here. A job `type` string is permanent: nothing below renames or removes one.

Evidence below was read from the code on 2026-11-12 (`grep` over `apps` and `packages`, the specs named). "Release N" is the production release that carries the cutover migrations of [release-window.md](../runbooks/release-window.md); "release N+1" is the first release after release N has run in production.

## Deleted now (RETRO-J)

| Removed | Why it is provably dead |
|---|---|
| `LegacyEnrichmentHandlerAdapter`, `toPlatformHandler`, `LEGACY_THROTTLE_KEYS`, `VIDEO_JOB_TYPES` (`platform/jobs/legacy-handlers.adapter.ts`) | The adapter's only entry was `EnrichmentHandlerRegistry.register`. No class in `apps/api/src` implements `EnrichmentHandler` or calls that method: all 42 handler classes are native `JobHandler`s that register with `JobHandlerRegistry` themselves (RETRO-C3 to C8). Both lists it kept were already empty |
| `EnrichmentHandlerRegistry`, the `EnrichmentHandler` interface (`enrichment/`) | Same: no registrant, and nothing read `types()` or `serverOnlyTypes()` outside specs |
| `test/jobs/legacy-adapter.spec.ts`, `enrichment-handler.registry.spec.ts`, the two "goes through the legacy adapter" cases of the registration specs | They tested only the deleted code. The mapping tests moved to `test/jobs/enrichment-job-mapping.spec.ts` |

`toEnrichmentJob` is still used (by the facade and the settled-event bridge) and moved to `platform/jobs/enrichment-job.mapping.ts`. `job-type-snapshot.spec.ts` keeps every pinned list unchanged and now registers all 42 classes directly on `JobHandlerRegistry`, so "every pinned type dispatches through the platform registry" is asserted without the adapter.

## Kept, with the condition that removes each

| Piece | Where | Still used by | Remove when |
|---|---|---|---|
| `ENRICHMENT_*` to `JOBS_*` translation (`legacyJobsEnv`, `configuredWorkerMode`, `videoJobTimeoutMs`, `SYSTEM_MODE_PINNED_TYPES`, `LEGACY_DEFAULT_WORKER_CONCURRENCY`) | `apps/api/src/platform/jobs/legacy-env.ts` | `config/configuration.ts` and `platform/jobs/queue-limits.ts` (`legacyJobsEnv`), `app-registrations/host.ts` and `enhancement/enhancement.module.ts` (`configuredWorkerMode`), the face and social-media modules (`videoJobTimeoutMs`, the 20-minute video profile); `workflow-execute-batch.handler.ts` only cites the pinned system-mode type in a comment | **Release N+1**, after every deployment's environment has been checked for `ENRICHMENT_*` and `FACE_WORKER_*` (the translation logs one deprecation warning per variable set, so the release N logs say which). First move what it also exports to its owners (`configuredWorkerMode` to the host registration, and the 20-minute profile to the video handlers, `workflow_execute_batch` to `jobs.config.ts`, the concurrency default of 1 to the `JOBS_WORKER_CONCURRENCY` default in `.env.example`), then delete the file and its spec. Remove the `ENRICHMENT_*` lines left in `infra/compose/app.env.example` in the same change |
| `MEMORIAHUB_*` worker aliases | `apps/cli/src/worker-env.ts` | the worker image and `docker-compose.worker*.yml` of releases before the platform engine | Release N+1, same check on the compose files in use. A patch bump of `apps/cli` (CLI versioning rule) and `npm install --package-lock-only` |
| `RetiredJobTypeHandler` (`job_history_purge`) and `RetiredStorageMigrationHandler` (`storage_migration`) | `platform/jobs/retired-job-types.ts` | a `pending` or `running` row of either type left at the cutover | Release N+1 **and** `SELECT type, status, count(*) FROM jobs WHERE type IN ('job_history_purge','storage_migration') AND status IN ('pending','running') GROUP BY 1,2` returns no row in production. The snapshot spec pins both strings as dispatching, so deleting them also needs that rule relaxed for retired types by the owner (the labels stay in `RETIRED_JOB_TYPE_LABELS` either way); keeping them costs two small classes |
| `location_suggestion_run_evaluate` and `location_suggestion_run_execute_batch` shim handlers | `apps/api/src/location-inference/runs/` | a row of either type still queued at the cutover | The operator runs `SELECT status, count(*) FROM jobs WHERE type LIKE 'location_suggestion_run_%' GROUP BY 1;` in production (it has not been run from the code) and gets no `pending` or `running` row. Then delete both handlers and their module registrations; the labels stay. Not deletable from a development checkout |
| `EnrichmentJobService` facade, `LegacyJobSettledBridge`, `toEnrichmentJob` | `platform/jobs/enrichment-job.facade.ts`, `enrichment-job.mapping.ts`, `enrichment/enrichment-job.service.ts` | `workflows/actions/workflow-actions.handler.ts` (enqueue), `workflows/runs/workflow-trigger.listener.ts` (the legacy `enrichment.job.settled` event), the `mediaEnrichmentProvider` test helper | A code change, not a release condition, but it changes live behaviour so it is not done here: (1) the workflow actions handler calls `JobsService.enqueue` directly, keeping the `geocode` coordinate payload and `recordProvider`; (2) the workflow trigger listener subscribes to the platform `job.settled` event and reads the job's subject instead of `mediaItemId`; (3) delete the facade, the bridge, the mapping and `enrichment/events/`. Needs the workflow integration specs to pass on both |
| Legacy `RateLimitError` and `classifyRateLimit` | `apps/api/src/enrichment/rate-limit.error.ts` | `platform/jobs/media-item-job.ts`, `test/jobs/location.conformance.spec.ts`, `apps/cli/test/executors/geocode.spec.ts` | When those three use the platform `RateLimitError` / the compute package's classifier; goes with the facade change above |

## The success criteria of epic #559 that are met

Checked against the code of 2026-11-12:

- `apps/api/src/enrichment/` holds no queue internals: it is the enqueue facade module, the settled-event types, the upload fan-out helpers and the legacy rate-limit error. No claim, worker, terminal state, throttle, backoff, stuck-reset, purge, admin or insights code remains.
- `job-type-snapshot.spec.ts` pins the 42 type strings plus the retired ones, and each dispatches through `JobHandlerRegistry` (it registers the classes on it).
- The `cron-enqueue-only` and `on-event-no-io` suites run in `test/conformance.spec.ts` and the `ai-jobs-server-only` suite in `test/ai-conformance.spec.ts`.
- The admin Jobs, Job Insights and Worker Nodes pages are the platform's (`apps/web/src/config/adminSections.tsx`, `platform/jobsAdapters.ts`, `platform/nodesExtensions.tsx`); `apps/api/src/nodes/` no longer exists.

## Not met yet

- A node built on the platform engine claiming and completing every node-eligible type in a **staging** bulk import of at least 2 000 photos with no OOM loop: not evidenced anywhere in the repository (the release-window runbook lists it as an open item).
- The C11 docs rewrite and `docs/runbooks/worker-fleet.md`, and "local-exceptions has no open jobs/nodes rows": the rows above are the open ones.

# MemoriaHub Job Types and the Background Queue

| Field | Value |
|-------|-------|
| **Version** | 3.0 |
| **Last Updated** | November 2026 |
| **Status** | Implemented (RETRO-C1 #575 to RETRO-C9 #612, RETRO-C11 #620) |

The background queue is the EnterpriseAppBase (EAB) platform's `jobs` slice (`@marinoscar/platform-api/jobs`: `JobsModule.forRoot`, the `jobs` table, `JobHandler`, `JobsService`, the worker, the lease reaper, the admin pages). **This page keeps only what is MemoriaHub-specific: the job type inventory, the priorities, the upload trigger and the image rule.** For the data model, claim, retry and backoff, rate-limit deferral, execution profiles, worker modes and the admin API, read the EAB documents `docs/specs/job-queue.md` and `packages/platform-api/src/jobs/README.md` (EnterpriseAppBase repository); the recipe for a new type is `packages/platform-api/src/jobs/handlers/README.md`. The old design (the `enrichment_jobs` table, `EnrichmentHandler`, `EnrichmentJobWorker`, `ENRICHMENT_*`) is history: [jobs-cutover.md](../runbooks/jobs-cutover.md) maps it onto the platform. Node-side execution: [distributed-nodes.md](distributed-nodes.md). Operations: [worker-fleet.md](../runbooks/worker-fleet.md), [worker-container-config.md](../worker-container-config.md).

## Rules that are MemoriaHub's own

1. **Job type strings are permanent** once rows exist; `apps/api/test/jobs/job-type-snapshot.spec.ts` pins every registered type and the node-eligible and `canDelete` sets. Rename a handler's class, never its string.
2. **Crons only enqueue** (RETRO-C9, `AGENTS`-style rule mirrored in `CLAUDE.md`): a `@Cron` decides whether work is due and enqueues it (`enqueueHousekeepingJob` for a global sweep), an `@OnEvent` body never downloads, uploads or spawns, and a detached `void this.doX()` is a violation. Executable form: the `cron-enqueue-only` and `on-event-no-io` suites in `apps/api/test/conformance.spec.ts`.
3. **AI jobs are server-only, permanently** (no node pair): `auto_tagging`, `video_auto_tagging`, `picture_enhancement` and the enhancement purge.
4. **Every handler declares a `label` and a `profile`** (`maxRuntimeMs`, `maxAttempts`); lease and reaper patience derive from `maxRuntimeMs`. There is no `leaseMs` or `heartbeatMs`.
5. **Node eligibility is derived** from the pair `nodeResultSchema` and `persistNodeResult`; there is no flag. A deployment declines offload with a system setting, never by editing a handler.
6. **A job carries its organization and subject**: `subjectType` is `media_item` for a per-item job, `circle` for a per-circle job, `null` for a system job; `orgId` is stored on the job (`null` for a system job). Enqueue through `JobsService` (the `EnrichmentJobService.enqueue` facade in `apps/api/src/platform/jobs/enrichment-job.facade.ts` keeps the old signature for callers not yet converted and is removed with the other compatibility shims).

## MemoriaHub job types

Profile is `maxRuntimeMs` / `maxAttempts`; the video types read 20 minutes (`videoJobTimeoutMs`) so a multi-gigabyte download plus ffmpeg plus per-frame calls is not killed as hung. "Node" means node-eligible (runs on a worker node when one is offered the type); "Server" means API host only. Source: the handler under `apps/api/src/<folder>`.

### Per-item media enrichment (subject `media_item`)

| Type | Folder | Profile | Where | Enqueued by |
|---|---|---|---|---|
| `face_detection` | `face` | 5 min / 3 | Node | upload (10), rerun (0), admin backfill (100) |
| `video_face_detection` | `face` | 20 min / 3 | Node | upload (20), social-media CLEAN fan-out, rerun, backfill |
| `duplicate_detection` | `dedup` | 5 min / 3 | Node | upload (10), rerun, batch |
| `metadata_extraction` | `metadata` | 5 min / 3 | Node | rerun (0), admin backfill; never at upload |
| `social_media_detection` | `social-media` | 20 min / 3 | Node | video upload (10), rerun, backfill |
| `thumbnail_regen` | `media` | 10 min / 3 | Node | bulk and per-item thumbnail rerun (0) |
| `geocode` | `geo` | 1 min / 3 | Node, only through the per-job secret; otherwise Server | rerun (0), admin geocode backfill, location inference and location-suggestion accept (after the coordinates are written) |
| `workflow_execute_batch` | `workflows/runs` | 10 min / 3 | Node, and Server in `system` mode | a workflow run (100, `skipDedup`) |
| `auto_tagging` | `tagging` | 3 min / 3 | Server | upload (20), rerun, backfill |
| `video_auto_tagging` | `tagging` | 20 min / 3 | Server | video upload (20), rerun, backfill |
| `picture_enhancement` | `enhancement` | 10 min / 3 | Server | single request (0), batch (50, `skipDedup`) |
| `burst_detection` | `burst` | 5 min / 3 | Server | upload (5), backfill |
| `location_inference` | `location-inference` | 15 min / 3 | Server | upload (10), per-circle sweep |
| `workflow_evaluate_item` | `workflows/runs` | 1 min / 3 | Server | enrichment settled (50, `skipDedup`) |

### Per-circle and per-run (subject `circle`)

| Type | Folder | Profile | Where | Enqueued by |
|---|---|---|---|---|
| `duplicate_detection_batch` | `dedup` | 30 min / 3 | Server | admin duplicate backfill (100 items per job) |
| `face_auto_archive_sweep` | `face` | 10 min / 3 | Server | admin backfill, per circle |
| `workflow_evaluate` | `workflows/runs` | 15 min / 3 | Server | a workflow run (20) |
| `review_run_evaluate`, `review_run_execute_batch` | `review-runs` | 15 / 10 min / 3 | Server | bulk review actions (20 / 100) |
| `trash_empty_evaluate`, `trash_empty_execute_batch` | `media/trash-empty` | 15 min / 3 | Server | empty trash run (20 / 100) |
| `memory_generation`, `memory_digest` | `memories` | 20 / 15 min, 3 / 2 | Server | hourly crons, admin backfill |
| `location_suggestion_run_evaluate`, `_execute_batch` | `location-inference/runs` | 15 / 10 min / 3 | Server | deprecated shims delegating to the review-run pair; nothing enqueues them |

### System and housekeeping (subject `null`, priority 100 unless noted)

| Type | Folder | Profile | Notes |
|---|---|---|---|
| `thumbnail_repair` | `media` | 15 min / 2 | hourly; server-only global sweep |
| `trash_purge` | `media` | 30 min / 2 | hourly |
| `storage_insights` | `insights` | 15 min / 3 | cron by interval, admin refresh at 0 |
| `location_group_rebuild` | `location-groups` | 30 min / 2 | every group mutation; always a full rebuild |
| `duplicate_confidence_backfill` | `dedup` | 30 min / 2 | admin one-pass backfill |
| `picture_enhancement_purge` | `enhancement` | 10 min / 2 | hourly |
| `review_run_history_purge`, `workflow_history_purge` | `review-runs`, `workflows/runs` | 30 min / 3 | nightly; also fail stale non-terminal runs |
| `workflows.schedule_tick`, `workflows.micro_run_finalize` | `workflows/runs` | 5 min / 3 | priority 20 so scheduled workflows are not starved |
| `notifications.review_queue_reconcile` | `notification-producers` | 15 min / 3 | hourly reconcile |
| `shares.expiring_sweep` | `notification-producers` | 5 min / 3 | daily |
| `node_backup.stale_sweep` | `node-backup` | 5 min / 3 | releases stale Local Media Backup runs |
| `media.storage.recover_stuck`, `media.storage.reprocess` | `media-processing/recovery` | 10 / 30 min / 3 | stuck-object recovery cron and admin reprocess |

### Retired types (still dispatch, as no-ops)

`job_history_purge` (the platform's `job.history.purge` replaced it), `storage_migration` (the platform storage migration replaced it), and the notification broadcast and purge types `broadcast_start`, `broadcast_chunk`, `notification_purge` (RETRO-D3). A pending row of one of these settles without work so it never sits unclaimable.

Jobs the platform slices own (`storage.object.process`, `storage.migrate_*`, `db.backup.*`, `db.restore.*`, `nodes.fleet.*`, `job.history.purge`, `sharing.grants.prune`, notifications, alerts) appear in the same queue and are documented in the platform docs.

## Priorities

`priority ASC, created_at ASC`: lower runs first.

| Priority | Used for |
|---|---|
| 0 | a user's rerun of one item; manual admin refresh |
| 5 | `burst_detection` at upload (so burst wins over duplicate detection in the common order) |
| 10 | upload enrichment: `face_detection`, `duplicate_detection`, `location_inference`, `social_media_detection` |
| 20 | `auto_tagging` and the two video types at upload; workflow evaluate and schedule |
| 50 | bulk enhancement items, workflow item evaluation |
| 100 | backfills, housekeeping, run batches, purges |

## Upload enrichment trigger

`MediaService.createMedia` awaits `MediaEnrichmentService.enqueueUploadEnrichment` (`apps/api/src/media/enrichment/media-enrichment.service.ts`) before the 201 response, on the non-deduplicated path only, so the job rows exist before any client (CLI, web, Android) hears back. A single `MediaEnrichmentEnqueueListener` on `OBJECT_PROCESSED_EVENT` is an idempotent backstop (the platform's dedup key makes a second enqueue a no-op while one is pending or running). Photos get `auto_tagging`, `face_detection`, `burst_detection`, `duplicate_detection` and `location_inference`; videos get `social_media_detection` (when enabled) which on a CLEAN result fans out `video_face_detection` and `video_auto_tagging`. Every type is gated by its global feature flag (`features.*`, default off) plus an environment kill-switch (`FACE_AUTO_DETECT`, `AUTO_TAG_ENABLED`, `BURST_DETECTION_ENABLED`, `DUPLICATE_DETECTION_ENABLED`, `LOCATION_INFERENCE_ENABLED`, `SOCIAL_MEDIA_DETECTION_ENABLED`); video tagging additionally needs `autoTagging.video.enabled` and, like all AI work, runs on the API. Flags are read through the cached `SystemSettingsService.getSettings()` once per upload. EXIF and typed-column sync is separate (`MediaMetadataSyncService`); `metadata_extraction` is only for rerun and backfill. Clients never enqueue enrichment themselves. Specs: [auto-tagging.md](auto-tagging.md), [video-auto-tagging.md](video-auto-tagging.md), [face-recognition.md](face-recognition.md), [duplicate-detection.md](duplicate-detection.md), [burst-detection.md](burst-detection.md), [social-media-detection.md](social-media-detection.md), [location-inference.md](location-inference.md).

## Image rule

Obtain pixels through `prepareImageForProcessing` (`apps/api/src/storage/processing/image-orientation.util.ts`), never by decoding raw bytes, so EXIF orientation is applied first. If sharp fails the helper returns the raw buffer with width and height 0 and the handler must tolerate that. HEIC decodes natively because the API and worker images build sharp against a source-built, HEIF-enabled libvips 8.18.3 (`scripts/docker/build-libvips.sh`); `transcodeToDecodableJpeg` (ffmpeg) is the rarely hit fallback. Never pass raw storage bytes to an image model.

## Adding a job type

Follow the EAB recipe (`packages/platform-api/src/jobs/handlers/README.md`; the `add-job-type` skill): implement `JobHandler` with a `type`, `label` and `profile`, self-register on `OnModuleInit`, enqueue through `JobsService`, decide node eligibility (a pair of `nodeResultSchema` and `persistNodeResult`, a `nodeSecretBroker` if a per-job secret is needed; AI types never), add the string to the snapshot spec and a conformance spec under `apps/api/test/jobs/`. A job touching an organization table runs under `JobScope.run(job, fn)`.

## Configuration

Queue variables are the platform's `JOBS_*` ([worker-container-config.md](../worker-container-config.md#2-api-side-settings), generated `infra/compose/.env.example`); retention is the platform's `jobs.history.*` settings; the stuck count on the dashboard uses `jobs.stuckThresholdMinutes`. Tuning for large imports: [bulk-upload-vps-tuning.md](bulk-upload-vps-tuning.md), [bulk-import-resilience.md](bulk-import-resilience.md).

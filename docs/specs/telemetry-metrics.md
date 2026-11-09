# MemoriaHub telemetry metrics

RETRO-T3 ([#628](https://github.com/marinoscar/MemoriaHub/issues/628), epic #561). The Telemetry Dashboard (`/admin/telemetry/dashboard`, permission `telemetry:read`) answers "is the photo pipeline healthy right now?" with six MemoriaHub metric groups, one custom card and a verdict policy, on top of the platform's own groups (`host`, `database`, `queue`, `nodes`, `uptime`, `pipeline`).

How to add a metric or a group: the platform runbook, EnterpriseAppBase `docs/runbooks/telemetry.md` §8.4 ("Adding an app metric group") and §8.5 ("Overriding the verdict").

## 1. Where things are

| What | File |
|---|---|
| The metric catalog (21 `app.*` metrics, label vocabularies, table names) | `apps/api/src/platform-extensions/telemetry/memoriahub-metrics.manifest.ts` |
| Registration (after the platform's) | `apps/api/src/platform/host-core.config.ts` (`registerPlatformHostAppMetrics(..., MEMORIAHUB_APP_METRICS)`) |
| Gauge providers and shared reads | `platform-extensions/telemetry/gauges/*`, `memoriahub-gauges.service.ts`, `memoriahub-telemetry-signals.service.ts`, `memoriahub-telemetry.module.ts` |
| Groups and units | `platform-extensions/telemetry/memoriahub.metric-groups.ts`, listed in `app-registrations/telemetry.ts` (`APP_METRIC_GROUPS`) |
| Dashboard card | `platform-extensions/telemetry/import-progress.dashboard-panel.ts`; web `apps/web/src/platform-extensions/telemetry/ImportProgressPanelView.tsx` |
| Verdict | `platform-extensions/telemetry/memoriahub-verdict.policy.ts`, thresholds `memoriahub-verdict-rules.ts` (`MEMORIAHUB_VERDICT_RULES`), bound in `platform/telemetry/telemetry.config.ts` |
| Tests | `apps/api/test/telemetry/memoriahub-metrics.spec.ts`, `memoriahub-verdict-gauges.spec.ts`, `telemetry-conformance.spec.ts`; web `src/__tests__/platform-extensions/ImportProgressPanelView.test.tsx` |

## 2. Metric catalog

Names are permanent: each is a GreptimeDB table name. Every attribute is an `enum`; none carries an organization, user, circle, media, node or job id, a host name, a path, a URL or an error text. A value outside an enum is recorded as `other` (`AppMetricsService.add` bounds it).

| Key | Name | Kind | Unit | Attributes | Recorded where |
|---|---|---|---|---|---|
| `mediaUploads` | `app.media.uploads` | counter | `{item}` | `media_type` (photo, video), `source` (web, cli, android, import, sync), `outcome` (created, deduplicated, rejected) | `MediaService.createMedia`: both dedup returns, the created path, and any 4xx (rejected) |
| `mediaUploadSize` | `app.media.upload.size` | counter | `By` | `media_type`, `source` | Created path only |
| `mediaProcessingDuration` | `app.media.processing.duration` | histogram, buckets 1 to 1800 s | `s` | `media_type`, `outcome` (ready, failed) | `MediaObjectProcessingService.onJobSettled` (the platform `storage.object.process` job settling; job creation to settlement). The media type is the one the `content-hash` processor remembered in process memory (`media-processing/processing-metrics.ts`), since the listener does no I/O; unknown reads as `other` |
| `mediaProcessingBacklog` | `app.media.processing.backlog` | gauge | `{object}` | `status` (pending, uploading, processing) | Gauge: `storage_objects` grouped by status, through `PrismaSystemService.asSystem('admin-aggregate')` (it counts across organizations) |
| `mediaFacesDetected` | `app.media.faces.detected` | counter | `{face}` | `media_type`, `executor` (server, node) | `FaceDetectionCore.persistAndMatchFaces` (photo and video, in-process and node results) |
| `peopleAssignments` | `app.people.assignments` | counter | `{face}` | `mode` (auto, manual, auto_archive) | Person match and auto-archive in `persistAndMatchFaces`; `PeopleService` create/assign/add-to-media |
| `mediaTagsApplied` | `app.media.tags.applied` | counter | `{tag}` | `media_type`, `source` (ai, system, manual) | `persistAutoTagging` (the AI set left on the item), social-media system tags, `attachTags`, `bulkTags` (split by media type in proportion to the selection) |
| `mediaDuplicatesGrouped` | `app.media.duplicates.grouped` | counter | `{item}` | `outcome` (new_group, joined_group, evicted_by_burst) | `DuplicateDetectionService` (after the commit) and `evictFromDuplicateGroups` |
| `mediaBurstsGrouped` | `app.media.bursts.grouped` | counter | `{item}` | `outcome` (new_group, joined_group) | `BurstDetectionService` |
| `mediaSocialClassified` | `app.media.social.classified` | counter | `{item}` | `platform` (tiktok, instagram, facebook, other, clean), `method` (metadata, filename, ocr, skip) | Social-media handler; a pre-flight cap reads as `skip`, a clean pass without a method as `metadata` |
| `mediaGeocoded` | `app.media.geocoded` | counter | `{item}` | `provider` (offline, nominatim, google), `outcome` (resolved, no_result, deferred, failed) | `GeocodeHandler`; an error reports the provider as `other` (it is resolved inside the geo service) |
| `enrichmentPending` | `app.enrichment.pending` | gauge | `{item}` | `stage` (faces, tags, metadata, geocode, social) | Gauge: the five status tables at pending/processing |
| `runsFinished` | `app.runs.finished` | counter | `{run}` | `engine` (workflow, review, trash_empty), `outcome` (completed, completed_with_errors, failed, cancelled, expired) | Evaluate handlers (0 matches, retries exhausted), the race-safe finalize of each execute-batch handler, the cancel paths, the expiry and stale-run sweeps |
| `runItems` | `app.runs.items` | counter | `{item}` | `engine`, `outcome` (applied, skipped, failed) | Execute-batch handlers; a partially applied workflow item counts as failed |
| `memoriesGenerated` | `app.memories.generated` | counter | `{memory}` | `type` (the seven memory types), `title_source` (template, ai), `outcome` (created, refreshed) | `MemoryCurationService.upsertMemory` |
| `memoriesDigestSent` | `app.memories.digest.sent` | counter | `{email}` | `outcome` (sent, skipped, failed) | `memory_digest` (skipped = opt-out, nothing to send, no address) |
| `storageBytes` | `app.storage.bytes` | gauge | `By` | `provider` (s3, r2, local), `kind` (photo, video, thumbnail, other) | Gauge: the latest `insights_snapshots` row (`storageBreakdown`), never a live SUM |
| `storageTrashBytes` | `app.storage.trash.bytes` | gauge | `By` | none | Same snapshot (`trashBytes`) |
| `aiImagesGenerated` | `app.ai.images.generated` | counter | `{image}` | `feature` (enhance), `quality` (low, medium, high), `outcome` (ready, failed) | `picture_enhancement` (failed once the queue gives up) |
| `aiAudioSeconds` | `app.ai.audio.transcribed` | counter | `s` | `feature` (transcription) | Video auto-tagging, when a transcript is persisted (its lead seconds; an upper bound for a short clip) |
| `nodesCapability` | `app.nodes.capability` | gauge | `{node}` | `capability` (ffmpeg, ffprobe, tesseract, clip, compreface), `state` (ok, missing) | Gauge: online `worker_nodes.capabilities` |

The platform's own metrics (`app.jobs.*`, `app.nodes.*` vitals, `app.ai.*`, `app.auth.*`, `app.notifications.deliveries`) are not repeated; MemoriaHub's groups only read them.

`source` differs from the issue's draft (`api`): it is the `MediaSource` enum the API stores (`web`, `cli`, `android`, `import`, `sync`).

### Table names

Dots become `_`; a counter gets `_total`; a unit `s` / `By` adds `_seconds` / `_bytes`; a histogram is `<name>_<unit>_bucket|_sum|_count`; a curly-brace unit adds nothing. So `app_media_upload_size_bytes_total`, `app_media_processing_duration_seconds_bucket`, `app_ai_audio_transcribed_seconds_total`. The two byte gauges (`app.storage.bytes`, `app.storage.trash.bytes`) are read as `app_storage_bytes` / `app_storage_trash_bytes`, following the Prometheus translator's rule of not repeating a unit word the name already carries. This was not verified live on GreptimeDB: if the store spells them `..._bytes_bytes`, change the two entries of `MH_TABLES` in the manifest.

### Gauges

Five gauges, registered once at module init on the platform's metrics host (`AppMetricsService.gaugeContext()`; nothing is registered while `OTEL_ENABLED` is not `true`). A callback reads nothing while the runtime export gate is closed. Every read is memoized for 60 s and logs a warning when it takes more than 50 ms. Indexes: `storage_objects(status)`, `media_tag_status(status)`, `media_metadata_status(status)`, `media_geocode_status(status)`, `media_social_status(status)`, `worker_nodes(status)`, `insights_snapshots(created_at)`. **`media_face_status` has no `status` index** (one row per media item): its count is a sequential scan, once a minute at most; an index request belongs to the face domain (a migration, not in this change).

## 3. Groups

| id | Title | Order | Families (tiles first) | Ratios and tables |
|---|---|---|---|---|
| `media` | Media pipeline | 80 | uploads/min by source, upload volume/min, processing p95, backlog by status | dedup rate; uploads by media type x outcome |
| `enrichment` | Enrichment | 81 | pending by stage, faces/min, tags/min, geocodes/min by outcome, social by platform, duplicates and bursts grouped | node share of work; job failures by type (top 10, failure %) |
| `memories` | Memories & people | 82 | memories by type, digests by outcome, people assignments by mode | AI titles |
| `storage` | Storage | 83 | bytes by kind, bytes by provider, trash | bytes by kind |
| `ai_spend` | AI spend by feature | 84 | tokens by feature, USD estimate by feature, images, audio seconds | none |
| `fleet_mh` | Worker fleet (MemoriaHub) | 86 | nodes with each capability, node share, runs finished by engine, run items, credential issuance / cache hits / misses / invalidations | node share, credential cache hit ratio; capability x state |

Units: `usd` (currency) and `items_per_min`. Family keys carry an `mh` prefix (keys are unique across all groups). A family whose table or label is missing is skipped ("no data yet"): `ai_spend` stays empty until RETRO-E2 adds `feature` to `app.ai.tokens`, and the credential-cache families until the platform ships EAB#1083's `app.nodes.credentials.*` metrics (referenced, never declared here; still absent in platform 0.1.0-next.28). The USD estimate is a flat price per million tokens (`ESTIMATED_USD_PER_MILLION_TOKENS`), like the platform's reference group.

A table part can filter only with `=` / `<>`, so the per-job-type failure table lists every job type, not only MemoriaHub's; the verdict rule below is restricted to MemoriaHub's types.

## 4. The "Bulk import progress" card

Panel id `memoriahub_import_progress` (the platform's id pattern refuses the issue's `memoriahub.import_progress`), order 90. The API half reads through the guarded query facade (six statements): uploads created in the last 24 hours, the latest `app_enrichment_pending` per stage, succeeded jobs per type in the last hour (the stage's throughput) and `app_jobs_oldest_pending_age_seconds` for `face_detection`, `auto_tagging`, `metadata_extraction`, `thumbnail_regen`. Per stage: done = uploads - pending (never below 0), ETA = pending / processed per minute. The web view draws one done-vs-pending bar per stage, the throughput and the ETA, in one column at every width.

## 5. Verdict

`MEMORIAHUB_VERDICT_THRESHOLDS` (the platform thresholds) stay equal to the platform defaults. `MemoriaHubVerdictPolicy` computes the platform verdict first and then adds reasons; it never lowers a level and leaves `no_data` alone.

| Rule | Degraded | Critical | Minimum sample |
|---|---|---|---|
| Enrichment failure ratio per MemoriaHub job type (`failed / (succeeded + failed)`) | > 10 % | > 25 % | 50 settled |
| Oldest pending upload-time job (`face_detection`, `auto_tagging`, `metadata_extraction`, `thumbnail_regen`, `social_media_detection`) | > 30 min | > 2 h | one pending |
| `processing` backlog sustained (every sample over at least 15 min) | > 50 | > 500 | two samples |
| Idle fleet: > 500 node-eligible jobs pending, nodes registered, none online | degraded | none | none |

Thresholds live in `MEMORIAHUB_VERDICT_RULES` so the alert rules (RETRO-H5) can reuse them.

**How the rules read their data (a seam gap).** The platform's `VerdictPolicy.compute` is synchronous and its `VerdictInput` carries neither the dashboard's range nor any app metric. So the rules judge signals `MemoriaHubTelemetrySignals` reads from PostgreSQL in the background: jobs created in the last 60 minutes that settled (bounded by `jobs(created_at DESC)`), the oldest due pending job per upload-time type, the backlog samples taken by the gauge reads, and the node counts. The window is a fixed 60 minutes whatever range the dashboard shows. The first summary after a restart carries no MemoriaHub reason. The 2026-11-07 decision's "sustained `auth_failure` credential invalidations is a warning" is not implemented: the platform does not ship those metrics yet and there is no PostgreSQL signal. Both are recorded in `docs/platform-adoption/local-exceptions.md`.

## 6. Security and cost

Metrics carry no personal data and no tenant id (`org.id` stays a span attribute). The groups, the card and the verdict are behind `telemetry:read`; the card reads only through the guarded facade. Worst case per metric stays under 7 x 5 x 4 series and the whole catalog under 2 000 (asserted by `memoriahub-metrics.spec.ts`). Rollback: revert the change; the names stay reserved and the tables age out with retention.

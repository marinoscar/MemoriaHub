# Bulk Import Resilience

This spec covers how MemoriaHub handles large photo imports — thousands of files from OneDrive or Google Photos onto a constrained VPS running OpenAI auto-tagging, Google reverse-geocoding, face recognition, and S3/R2 storage — without losing work to OOM kills, process restarts, provider rate limits, or CLI crashes.

Cross-references: [Enrichment Queue](enrichment-queue.md) | [Geocoding](geocoding.md) | [Bulk Uploads on a Cheap VPS — Memory Tuning](bulk-upload-vps-tuning.md) (memory sizing / OOM runbook)

---

## Goal and Threat Model

A "bulk import" session can run for hours or days. The system must survive these failure modes without losing progress or silently skipping work:

| Failure mode | Without resilience | With resilience |
|---|---|---|
| API process OOM-killed or restarted mid-job | Enrichment jobs stuck in `running` forever | Auto-reset by stuck-job cron within `jobs.stuckThresholdMinutes` (system setting, default 3 min) |
| API process OOM-killed or restarted mid-upload processing (content-hash/exif/dimensions/video-probe/geocode/thumbnail/visual-hash) | `StorageObject` stuck at `status='processing'` forever — no thumbnail, dimensions, or EXIF ever generated for that photo/video, and no existing recovery path touches it | Auto-recovered by `StorageProcessingRecoveryTask` within `STORAGE_PROCESSING_STUCK_MINUTES` (default 10 min), capped at `STORAGE_PROCESSING_MAX_RETRIES` attempts |
| Provider rate limit (429 / 529 / `OVER_QUERY_LIMIT`) | Job retried as normal error, or silently marked processed with no data | Job deferred on separate `rateLimitHits` counter; provider gate backs off sibling jobs |
| Geocode provider quota | `null` return → job marked `processed` with no geo data; no retry | Provider throws `RateLimitError` → job deferred; status stays `pending` until retry succeeds |
| CLI crash mid-multipart upload | Upload restarted from byte 0; file row stuck in `uploading` | Parts persisted per-PUT to SQLite; crash recovery resumes from last confirmed part |
| PAT expiry mid-run | Cryptic 401 cascade after hours of queued work | Pre-flight check at start of every sync or retry; exit(1) with actionable message |

---

## Server Queue Resilience

### Dual-path retry model

The enrichment worker (`EnrichmentJobWorker`) branches on error type:

**Normal failure path** — uses the `attempts` counter:

- Any error not classified as a rate limit increments `attempts`.
- When `attempts < ENRICHMENT_MAX_ATTEMPTS`: job reset to `pending` with `scheduledFor = now + backoff`.
- When `attempts >= ENRICHMENT_MAX_ATTEMPTS`: job marked `failed`.
- Backoff: equal-jitter exponential starting at `ENRICHMENT_RETRY_BASE_MS`, capped at `ENRICHMENT_RETRY_MAX_MS`.

**Rate-limit deferral path** — uses the `rateLimitHits` counter:

- Handler throws `RateLimitError` explicitly, or `classifyRateLimit` detects HTTP 429, HTTP 529 (Anthropic "Overloaded"), or a known AWS throttling exception name.
- `attempts` is NOT incremented. The two counters are completely independent — ordinary transient errors do not consume rate-limit quota, and vice versa.
- When `rateLimitHits < ENRICHMENT_RATELIMIT_MAX_HITS`: job reset to `pending` with `scheduledFor = now + backoff`.
- When exhausted: job marked `failed`.
- Backoff: equal-jitter exponential starting at `ENRICHMENT_RATELIMIT_BASE_MS`, capped at `ENRICHMENT_RATELIMIT_MAX_MS`. If the provider returned a `Retry-After` header, that value takes precedence over the computed ramp.
- In addition, the shared `ProviderThrottleService` gate is tripped so sibling jobs back off immediately.

The `rateLimitedAt` timestamp and `scheduledFor` columns are visible in the admin job dashboard. Jobs currently in backoff appear when filtering with `scheduled=true`.

### Atomic job claim (pre-existing)

Jobs are claimed atomically inside a Prisma `$transaction` (`findFirst` + `update`). The claim query skips jobs where `scheduledFor > now`, ordering by `priority ASC, createdAt ASC`. No two workers can claim the same job.

### Stuck-job auto-reset cron (new — `EnrichmentStuckResetTask`)

When the API process is OOM-killed or restarted, any job that was `running` at that moment has no worker to complete it. It stays `running` indefinitely unless something resets it.

`EnrichmentStuckResetTask` runs every 10 minutes via `@Cron(EVERY_10_MINUTES)`. It resets jobs that have been in `running` state (including zombie rows where `startedAt` was never stamped, aged by `createdAt` instead) for longer than the threshold back to `pending`, so the worker can re-claim them on the next tick.

The task is gated on `ENRICHMENT_WORKER_ENABLED !== 'false'` so non-worker instances (web-only replicas, read replicas) do not interfere. It delegates to `EnrichmentAdminService.resetStuck()` with no argument — the same implementation used by `POST /api/admin/jobs/reset-stuck` when its `olderThanMinutes` body field is omitted — so the cron, the stats `stuckRunning` count, and the manual reset endpoint always agree on one threshold.

The threshold is the `jobs.stuckThresholdMinutes` **system setting** (integer, 1–120, default **3** minutes), runtime-editable in Admin Settings without a restart. It falls back to the legacy `ENRICHMENT_STUCK_MINUTES` env var (clamped to 120) only to compute the setting's default the first time it is resolved; once an explicit value exists in the database, the env var has no further effect. Whatever value is in force must exceed the longest expected single-job runtime — set too low, a legitimately-still-running job is reset to `pending` and can be re-claimed and run a second time concurrently with the original.

### Enrichment environment variable reference

| Variable | Default | Description |
|---|---|---|
| `ENRICHMENT_WORKER_ENABLED` | `true` | Set `false` to disable the worker and the stuck-reset cron |
| `ENRICHMENT_JOB_POLL_MS` | `5000` | Worker poll interval in ms |
| `ENRICHMENT_WORKER_CONCURRENCY` | `1` | Worker-pool size — number of long-lived claim→process→repeat loops, fixed at startup (no batch barrier). Memory scales with it. |
| `ENRICHMENT_MAX_ATTEMPTS` | `3` | Max normal-failure retries before permanent failure |
| `ENRICHMENT_RETRY_BASE_MS` | `2000` | Base backoff for normal-failure retries |
| `ENRICHMENT_RETRY_MAX_MS` | `60000` | Max backoff cap for normal-failure retries |
| `ENRICHMENT_RATELIMIT_BASE_MS` | `30000` | Base backoff for rate-limit deferrals |
| `ENRICHMENT_RATELIMIT_MAX_MS` | `900000` | Max backoff cap for rate-limit deferrals (15 min) |
| `ENRICHMENT_RATELIMIT_MAX_HITS` | `10` | Max rate-limit deferrals before permanent failure |
| `ENRICHMENT_STUCK_MINUTES` | _(unset)_ | **Legacy fallback only.** The stuck-job threshold is now the runtime `jobs.stuckThresholdMinutes` system setting (1–120, default 3 min), editable in Admin Settings; this env var seeds that setting's default (clamped to 120) only until an explicit value is saved. Must exceed the longest expected single-job runtime. |

### Stuck StorageObject auto-reset cron (new — `StorageProcessingRecoveryTask`)

The upload-time processing pipeline (content-hash, exif, dimensions, video-probe, geocode, thumbnail, visual-hash — `ObjectProcessingService.handleObjectUploaded`) is a **separate system from `enrichment_jobs`**: it runs synchronously in-process off a fire-and-forget `OBJECT_UPLOADED_EVENT`, not a durable, retryable job row. If the API process is killed anywhere inside that pipeline — the exact failure mode a bulk import's sustained memory pressure produces — the owning `StorageObject` is left at `status='processing'` forever. `EnrichmentStuckResetTask` cannot see it (wrong table); the daily `StorageCleanupTask` only targets `pending`/`uploading`; and the one existing manual tool, `MediaReprocessService.reprocessImageObject` (`POST /api/admin/media/reprocess`), explicitly requires `status IN ('ready','failed')` and an image mimeType, so it silently skips both stuck rows and any video.

`StorageProcessingRecoveryTask` runs every 10 minutes via `@Cron(EVERY_10_MINUTES)`, mirroring `EnrichmentStuckResetTask`'s shape. It delegates to `StorageProcessingRecoveryService.recoverStuckObjects()`, which:

1. Finds `StorageObject` rows at `status='processing'` with `updatedAt` older than `STORAGE_PROCESSING_STUCK_MINUTES`.
2. For each, checks `metadata._processingRetryCount` against `STORAGE_PROCESSING_MAX_RETRIES`. If the cap is already reached, marks `status='failed'` (with `metadata._processingRetryExhausted=true`) and stops — no further retries.
3. Otherwise increments and **persists** the retry counter first, then re-invokes the full pipeline (`ObjectProcessingService.handleObjectUploaded`) directly. Persisting the counter *before* the pipeline call — not after — is the key correctness property: if this recovery attempt itself gets killed, the counter has already advanced, so the object still counts toward the cap on the next tick instead of retrying forever with no progress. As a side effect, the counter write also bumps `updatedAt` (Prisma `@updatedAt`), which naturally keeps the object off the next scan until another full threshold window passes even if the attempt hangs rather than crashing.

Re-running the *full* pipeline (not just dimensions+thumbnail, unlike `MediaReprocessService`) is what lets this recover stuck videos as well as photos, and is safe to repeat: content-hash is deterministic, the thumbnail upload is an upsert keyed on the object's deterministic `thumbnails/<objectId>.jpg` storage key, and the downstream `OBJECT_PROCESSED_EVENT` listeners (`MediaMetadataSyncService`, `MediaEnrichmentEnqueueListener`) are already idempotent.

`POST /api/admin/media/reprocess-stuck` (body `{ olderThanMinutes? }`) triggers the same recovery immediately, without waiting for the next tick — useful right after deploying this fix, or for any future incident where you don't want to wait out the threshold. `POST /api/media/:id/thumbnail/rerun` is the single-item, user-facing counterpart (bypasses the threshold/cap entirely, since an explicit retry should always get a fresh attempt) — see the "Media — Thumbnail Rerun" section of `CLAUDE.md`.

| Variable | Default | Description |
|---|---|---|
| `STORAGE_PROCESSING_STUCK_MINUTES` | `10` | Threshold (minutes) for stuck-`StorageObject` auto-recovery |
| `STORAGE_PROCESSING_MAX_RETRIES` | `3` | Max automatic recovery attempts per object before it is marked `failed` |
| `STORAGE_PROCESSING_STUCK_RESET_ENABLED` | `true` | Set `false` to disable the recovery cron |

### Per-provider throttle gate (new — `ProviderThrottleService`)

At concurrency greater than 1, independent per-job backoff is insufficient. A 429 received by one worker tick does not stop sibling jobs in the same poll batch from immediately hammering the same API. `ProviderThrottleService` maintains an in-process `CooldownGate` per provider key so a rate-limit event from any job immediately backs off all sibling jobs of the same feature type.

**Job type to throttle key mapping** (`ProviderThrottleService.resolveKey`):

| Job type | Throttle key | Rationale |
|---|---|---|
| `auto_tagging` | `tagging` | One AI tagging provider configured at a time |
| `geocode` | `geocode` | One reverse-geocode provider active at a time |
| `face_detection` | `face` | One face detection provider active at a time |
| `storage_migration` | `null` | AWS SDK handles retries internally |
| `storage_insights` | `null` | Local computation, no external quota |
| `trash_purge` | `null` | Local computation, no external quota |
| `metadata_extraction` | `null` | Local EXIF extraction, no external quota |
| `burst_detection` | `null` | Local perceptual hashing, no external quota |

The coarse mapping avoids per-job database reads to look up the active provider. It is correct because only one provider per feature type is configured at any given time, so all same-type jobs share the same network backend. When the offline geocode provider is active no 429s are generated, so the gate is never tripped and `acquire` is a no-op.

**Gate operations:**

- `acquire(key)`: Called before every remote API call. Awaits the remaining cooldown window for that provider. Returns immediately with no allocation when the gate is idle — zero cost on the happy path.
- `trip(key, retryAfterMs?)`: Called immediately when a rate-limit error is caught. Opens or extends the cooldown window. When the provider's `Retry-After` response header is present that value is used; otherwise an exponential ramp is applied on consecutive trips (base 2 s, max 60 s). The window is never shortened by a new trip call.
- `recordSuccess(key)`: Called after a successful job. Decrements `consecutiveTrips` toward 0, decaying the exponential ramp so a quiet period eventually returns the gate to baseline.

This means that when the `tagging` gate is cooling down, all concurrent `auto_tagging` workers sleep until the window expires, then resume together rather than thundering in sequentially.

---

## Provider Rate-Limit Classification Matrix

The `classifyRateLimit` function in `rate-limit.error.ts` is the fallback classifier. Handlers that can parse structured throttle errors throw `RateLimitError` directly. Both paths lead to the rate-limit deferral branch in the worker.

| Provider | How throttle is detected | Classified as rate-limit? | Resulting behavior |
|---|---|---|---|
| OpenAI | HTTP 429 | Yes | `classifyRateLimit` or explicit `RateLimitError`; job deferred, `tagging` gate tripped |
| Anthropic | HTTP 429 or HTTP 529 ("Overloaded") | Yes — 529 is treated as a rate limit | Same as OpenAI |
| Google Geocoding | HTTP 429, HTTP 5xx, API-level status `OVER_QUERY_LIMIT` or `RESOURCE_EXHAUSTED` | Yes | Provider now throws `RateLimitError` (previously returned `null`); job deferred, `geocode` gate tripped; `media_geocode_status` stays `pending` not `processed` |
| Nominatim | HTTP 429, HTTP 5xx | Yes | Provider now throws `RateLimitError` (previously returned `null`); same deferral behavior |
| S3 / Cloudflare R2 | AWS SDK v3 detects `503 SlowDown` / HTTP 429; error names `SlowDown`, `TooManyRequestsException`, `ProvisionedThroughputExceededException`, `RequestLimitExceeded`, `ThrottlingException` | Yes | AWS SDK adaptive retry handles internally (`S3_RETRY_MODE=adaptive`); if exhausted, `classifyRateLimit` catches the error name |
| AWS Rekognition | `ThrottlingException`, `ProvisionedThroughputExceededException`, `RequestLimitExceeded`, `TooManyRequestsException` | Yes | Classified by `classifyRateLimit` via error name; job deferred, `face` gate tripped |
| CompreFace (local sidecar) | HTTP 429 or 5xx from sidecar | Classified if present | Rarely trips in practice; no external quota |
| `human` (in-process WASM) | Not applicable — no network call | No | Never throttled; `face` gate never trips for this provider |

### Key behavior changes for geocoding

Before this sprint, both Google Geocoding and Nominatim returned `null` on quota or server errors. The geocode enrichment handler treated `null` as "no result found" and marked the job `processed` with empty geo columns. This silently discarded the quota signal. Items were left without geo data with no way for the queue to retry them.

Now both providers throw `RateLimitError` on quota responses. The enrichment worker routes this through the rate-limit deferral path: `media_geocode_status` stays in its current state (`pending` or `processing`), and `scheduledFor` is set to the backoff window. The item will be retried automatically.

### Key behavior change for auto-tagging embeddings

`AutoTaggingService.embedAndStore` previously swallowed all errors so that embedding failures (typically OpenAI quota) did not fail the tagging job. Now it rethrows `RateLimitError`: a rate-limit on the OpenAI embedding call defers the entire tagging job rather than producing a tagged item with no embedding for semantic search.

---

## CLI Resilience

The MemoriaHub CLI (`apps/cli`) maintains a local SQLite database that makes every sync operation idempotent and crash-safe.

### SQLite ledger schema

The ledger is managed by a version-gated migration runner (`db/migrations.ts`) using `PRAGMA user_version`. Current schema version: 5.

**`files` table** — one row per discovered file:

| Column | Type | Description |
|---|---|---|
| `file_path` | TEXT | Absolute path on disk |
| `sha256` | TEXT | Content hash; used for server-side dedup |
| `status` | TEXT | `queued` \| `uploading` \| `uploaded` \| `skipped` \| `failed` |
| `attempt_count` | INTEGER | Incremented on each failure |
| `last_error` | TEXT | Error message from the last failed attempt |
| `upload_id` | TEXT | Server-issued multipart session identifier — `NULL` when idle (added Migration 5) |
| `upload_part_size` | INTEGER | Byte length of each part for correct file slicing on resume — `NULL` when idle (added Migration 5) |
| `media_item_id` | TEXT | Server-side media item UUID once created |

**`file_upload_parts` table** (added Migration 5) — one row per confirmed S3/R2 multipart part:

| Column | Type | Description |
|---|---|---|
| `file_id` | INTEGER | FK → `files(id)`, cascades on delete |
| `part_number` | INTEGER | 1-based part number |
| `etag` | TEXT | ETag returned by S3/R2 for the PUT |

Primary key is `(file_id, part_number)` — re-saving the same part is safe via `ON CONFLICT REPLACE`. Rows are written immediately after each PUT, before any other work, so a crash after a PUT leaves exactly the confirmed parts persisted.

### Crash recovery and durable multipart resume

**On startup**, `FileRepo.resetStaleUploading()` resets any files stuck in `uploading` back to `queued`. This method deliberately does NOT clear `upload_id`, `upload_part_size`, or `file_upload_parts` rows — the durable upload state is preserved so the next sync can resume from the last confirmed part.

**On the next sync attempt for the file**, `uploadFile` in `upload.ts` follows this flow:

1. `persistence.getResumeState()` returns `{ objectId, uploadId, partSize, completedParts[] }` if `upload_id` is non-null on the file row.
2. `isServerSessionValid()` calls `GET /api/storage/objects/:id/upload/status` to verify the server session is still open. If the server returns 404, or the status is `completed` / `failed` / `aborted`, or the returned `uploadId` does not match the persisted one, the session is expired. `persistence.onComplete()` clears the local state and a fresh upload is initiated from step 3.
3. If the session is valid, the `completedParts` list is seeded from the persisted parts and those part numbers are skipped. The upload continues from the first un-confirmed part.
4. Each presigned PUT is followed immediately by `persistence.onPartComplete(partNumber, eTag)`, which writes to `file_upload_parts` before returning to the upload loop.
5. After `POST .../upload/complete` finalizes the session, `persistence.onComplete()` deletes all `file_upload_parts` rows for the file and sets `upload_id` and `upload_part_size` to `NULL`.

**Server-side orphaned multipart cleanup** (pre-existing): The server's `StorageCleanupTask` aborts any multipart upload sessions that have been open for more than 24 hours, freeing partial uploads that were never completed.

### Content-hash dedup (pre-existing)

The SHA-256 of each file is computed locally and sent to the server. The server deduplicates on `(circle_id, content_hash)`. Uploading the same file twice is safe and returns the existing `media_item_id`. The CLI marks the file `uploaded` on any 2xx including the deduplicated case.

### Capture-date range filter (new — `--from`/`--to`)

`memoriahub sync` accepts optional `--from <date>` and `--to <date>` flags that restrict the run's work-set to files whose capture date falls within an **inclusive, local-timezone** range (`--from` = start of that day, `--to` = end of that day, machine local time). Either bound may be supplied alone. Capture date is resolved via the same source ladder as `resolveCapturedAt` in `apps/cli/src/metadata.ts` (EXIF `DateTimeOriginal` → `CreateDate` → `ModifyDate`, falling back to filesystem timestamps) — see the CLI README's [Capture-date inference](../../apps/cli/README.md#capture-date-inference) section for the full algorithm. A file whose date cannot be determined at all is excluded from a filtered run.

**Why this is safe:** the filter only gates work-set *inclusion* — it does not introduce a new terminal ledger status. A file outside the requested range is written as `status = 'skipped'` with `skip_reason = 'out_of_range'`, alongside the existing dedup skip path. Because out-of-range files are never marked `uploaded`, they are not consumed by a filtered run: a later unfiltered `memoriahub sync` re-evaluates them from scratch and uploads them normally. Files already uploaded during an earlier filtered run remain protected on the next run by the two mechanisms already documented above — the unchanged-skip fast path (size match short-circuits before any network call) and server-side `(circle_id, content_hash)` dedup (see [Content-hash dedup (pre-existing)](#content-hash-dedup-pre-existing)). Net effect: applying or removing the date filter across runs can only change which files are *considered* for upload in a given run — it never causes a duplicate upload and never permanently excludes a file.

### PAT pre-flight (new — `runPatPreflight`)

Runs before every `sync` or `retry` command:

1. `GET /api/auth/me` — if the server returns HTTP 401, the CLI exits immediately with code 1 and prints: "Your access token is invalid or expired. Run `memoriahub login` to re-authenticate, then re-run this command." This catches a revoked or expired PAT before hours of wasted work.
2. If `patExpiresAt` is within 7 days, a warning is printed so the user can refresh proactively before starting a large run.
3. Network errors, 5xx responses, and other non-401 failures print a warning and allow the sync to proceed — a momentary server hiccup should not abort a queued import.

### CLI commands for large runs

| Command | Description |
|---|---|
| `memoriahub sync` | Start or resume an import; runs PAT pre-flight first |
| `memoriahub retry` | Re-attempt all failed files below `attempts_cap`; runs PAT pre-flight first |
| `memoriahub status` | Show file counts by status (queued, uploading, uploaded, skipped, failed) |
| `memoriahub blocked` | List files at or above `attempts_cap` that need manual intervention |

---

## Recovery Runbook

### After an OOM kill or process restart

Enrichment jobs left in `running` state — including zombie rows whose `startedAt` was never stamped — are auto-reset within the configured `jobs.stuckThresholdMinutes` (default 3 min) by `EnrichmentStuckResetTask`. No manual action is required for typical restarts.

For immediate recovery: `POST /api/admin/jobs/reset-stuck` with no body (uses the configured threshold) or an explicit `{ olderThanMinutes: 5 }` override.

After recovery the worker re-claims and reprocesses the jobs. Handlers are not checkpointed mid-run, so any partial work inside a handler (e.g. a half-written embedding) is retried from the beginning.

**Separately**, photos/videos whose upload-time processing (thumbnail, dimensions, EXIF, etc.) was interrupted by the same OOM/restart show up as a permanent "Processing…" spinner in the gallery (frontend now times this out into a broken-image icon after 15 minutes, but the underlying `StorageObject` still needs actual recovery). This is handled by `StorageProcessingRecoveryTask`, not the enrichment cron above — see "Stuck StorageObject auto-reset cron" earlier in this doc. No manual action is required either; for immediate recovery instead of waiting for the next tick: `POST /api/admin/media/reprocess-stuck` with optional body `{ olderThanMinutes: 5 }`. To identify affected items first:

```sql
SELECT so.id, so.name, so.mime_type, so.created_at, so.updated_at,
       mi.id AS media_item_id, mi.circle_id
FROM storage_objects so
LEFT JOIN media_items mi ON mi.storage_object_id = so.id
WHERE so.status = 'processing'
ORDER BY so.created_at;
```

### After sustained provider rate limits

Jobs in the rate-limit deferral path accumulate `rateLimitHits` and are visible in the admin dashboard:

- `GET /api/admin/jobs?scheduled=true` — lists pending jobs currently in backoff
- `GET /api/admin/jobs/stats` — shows `scheduled` count alongside totals by status and type

If the provider recovers before the backoff window expires, accelerate recovery by resetting individual jobs via `POST /api/admin/jobs/:id/retry` (clears `scheduledFor` and resets `rateLimitHits` to 0).

For bulk-retry of all failed jobs: `POST /api/admin/jobs/retry-failed`, optionally scoped by `{ type: "auto_tagging" }`.

To reduce rate-limit pressure during a large backfill: lower `ENRICHMENT_WORKER_CONCURRENCY` to 1 and raise `ENRICHMENT_RATELIMIT_MAX_MS` so the queue patiently waits out longer quota windows.

### After a failed CLI run

1. `memoriahub status` — check how many files are queued, failed, and blocked.
2. `memoriahub retry` — re-attempt all failed files below `attempts_cap`. The pre-flight runs first; a 401 stops here with a clear message.
3. If files are `blocked` (at or above `attempts_cap`): inspect `last_error` in the SQLite database, fix the root cause, then either raise `attempts_cap` via `memoriahub config set attempts_cap N` or reset `attempt_count` on the specific rows.

Interrupted multipart uploads are resumed automatically on the next `sync` or `retry` — no manual cleanup is needed unless the server session has expired (more than 24 hours since the last PUT).

### After PAT expiry

The pre-flight on `sync` or `retry` detects the 401 immediately:

1. `memoriahub login` — authenticates via Device Authorization Flow (RFC 8628); stores a new PAT in the local config.
2. Re-run `memoriahub retry` — the pre-flight passes; the sync resumes from where it left off.

Files already marked `uploaded` are not re-uploaded. Files in `uploading` are reset to `queued` on startup with their multipart state preserved, so they resume automatically.

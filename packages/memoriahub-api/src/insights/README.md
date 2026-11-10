# insights

The storage insights slice of the MemoriaHub domain (RETRO-J10, #624): the global storage-metrics snapshot that the admin Storage Insights page and the `app.storage.bytes` gauges read.

## Purpose and scope

`InsightsService` computes the library-wide aggregates (items and bytes by media type, faces, tagged items, stored bytes by provider and kind, bytes of trashed originals) into one `insights_snapshots` row and prunes the older ones; every byte count leaves as a string, never a `BigInt`. The `storage_insights` job (`StorageInsightsHandler`, server-only, 15 minutes, three attempts, type string permanent) runs the computation; `InsightsRefreshTask` is the hourly enqueue-only cron that asks for a refresh once `storage.insights.refreshIntervalHours` (default 4) has elapsed and none is pending or running. `enqueueRefresh` backs the manual refresh at priority 0. The controller (`GET /api/admin/insights`, `POST /api/admin/insights/refresh`) stays in the web app until the identity-backed guard lands in `core`. The review insights views live with the dedup slice. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/insights` (and `@marinoscar/memoriahub-api/insights/testing` for the conformance kit). It imports the `ports`, `core` and `media` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common` and `@nestjs/schedule` (the cron).

## Configuration

`InsightsModule.forRoot()`; the options object is reserved and empty. Import it once in the host. The refresh interval is the system setting `storage.insights.refreshIntervalHours`, read through the settings port (the host declares the `storage` namespace). No environment variable is read.

## Extension-point catalog

None. The slice registers one job handler through `MEMORIAHUB_JOBS` and exposes `InsightsService` to the host. `describeInsightsSliceConformance` (`./insights/testing`) proves the snapshot is JSON-safe (strings for bytes) and that a refresh queues the global job with no subject.

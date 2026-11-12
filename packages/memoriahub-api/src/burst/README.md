# burst

The burst photo detection slice of the MemoriaHub domain (RETRO-J10, #624).

## Purpose and scope

`BurstDetectionService` groups a photo with its burst neighbours: an Apple BurstUUID is a hard link; otherwise a same-device photo within `burst.timeGapSeconds` and `burst.hashDistance` dHash bits links (the hash of a legacy photo is computed on demand and persisted). Groups are created, joined or merged into the oldest, every member is scored (sharpness, faces, resolution) with a suggested best shot, a cohesion `confidence` is persisted, and the members are evicted from any duplicate group (burst wins). The `burst_detection` job (type string and profile permanent: five minutes, three attempts) is server-only: grouping reads the item's neighbours mid-computation. `BurstUploadEnrichment` registers the photo fan-out with the media slice at priority 5, ahead of duplicate detection (10). `BurstService` is the review queue (list, detail, resolve, dismiss, bulk resolve, the two threshold runs and the admin backfill); its resolve and dismiss primitives are public because `BurstGroupReviewStrategy` wraps them and registers with the review-run engine's `ReviewRunSubjectRegistry`, which is how the review-runs slice stays free of burst code. `BurstController` and `AdminBurstController` are exported classes the host mounts. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/burst` (and `@marinoscar/memoriahub-api/burst/testing`). It imports the `ports`, `core`, `media`, `dedup` and `review-runs` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `nestjs-zod`, `@marinoscar/memoriahub-compute` (`dhash`) and `@marinoscar/memoriahub-contract` (`burst`).

## Configuration

`BurstModule.forRoot()`; the options object is reserved and empty. Import it once in the host and list `BurstController` and `AdminBurstController` in the module where the routes belong. Settings: `features.burstDetection` (kill switch `BURST_DETECTION_ENABLED`) and the `burst` namespace (`timeGapSeconds`, `hashDistance`, `minGroupSize`, `autoResolveThreshold`). The optional `BURST_OBSERVER` binding (`media.item.trashed` webhook after a trash resolve) must come from a global module of the host.

## Extension-point catalog

| Symbol | Kind | What the host does |
|---|---|---|
| `BURST_OBSERVER`, `BurstObserver` | token, interface | optional: what happens after a resolve with `trash` commits (the `media.item.trashed` webhook); never throws |

`describeBurstSliceConformance` (`./burst/testing`) proves the fan-out registration: photos only, priority 5, gated by the feature flag.

**Diagnostics (RETRO-J10, #624).** The slice registers the `memoriahub.jobs.burst-config` check (`BurstConfigDoctorCheck`) through the `MEMORIAHUB_DOCTOR` port from `forRoot()`. Read-only; the id and the statuses are the ones the app declared before the move.

The slice also registers `BurstReviewQueueCounter` with the media slice's `ReviewQueueCounterRegistry` (`pendingBurstGroups`, event `review.bursts`, on with `features.burstDetection`; pending groups that reached `burst.minGroupSize`, default 3).

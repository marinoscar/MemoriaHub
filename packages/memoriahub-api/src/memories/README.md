# memories

Auto-curated memory collections of the MemoriaHub domain, written against the host ports (RETRO-J8, #619): the seven curators, the shared curation engine, AI titles, the per-circle generation job, the e-mail digest, the `memories_ready` notification producer, the read API and the admin backfill.

## Purpose and scope

`MemoryCurationService` is the shared engine (candidate base filter, scoring, burst and duplicate collapse, diversity buckets, and the idempotent `upsertMemory` keyed by `(circleId, type, periodKey, subjectKey)` with its anti-churn Jaccard rule; a user-deleted memory is a tombstone that is never recreated). The curators (`OnThisDayCurator`, `TripCurator`, `PersonHighlightsCurator`, `PersonOverYearsCurator`, `ThemeCurator`, `SeasonalCurator`, `YearInReviewCurator`) each run in their own try/catch under `MemoryGenerationHandler`, so one failing curator never costs a circle the rest. `MemoryTitleService.generate` is total (every failure lands on the template title); it reads the `ai.features.memories` selection with `readAiSelection` and calls the model through `MEMORIAHUB_AI.forSystem` (no acting user; the organization's or the deployment's key), with a per-job budget and a rate-limit circuit breaker.

Jobs (type strings and profiles permanent, both server-only: no `nodeResultSchema` or `persistNodeResult`): `memory_generation` (per circle, `skipDedup`, backfill sharded into 18 bounded jobs by `MemoryBackfillService`) and `memory_digest` (per circle; the watermark is the last succeeded job row's `finishedAt`; a partial send still succeeds). `MemoriesGenerationTask` and `MemoryDigestTask` only decide whether work is due and enqueue it. `MemoriesNotificationService` raises the `memories_ready` counted event through the notify port (24-hour rolling window, every circle member). The digest's image and unsubscribe links are HMAC-signed capability tokens (`digest-token.util`), never a database row.

Controllers (`MemoriesController`, `AdminMemoriesController`, `PublicMemoryDigestController`) are exported classes the host mounts in its own module; `forRoot()` does not register them, so the OpenAPI path order stays the host's. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/memories` (and `@marinoscar/memoriahub-api/memories/testing`). It imports the `ports`, `core`, `media`, `face` and `location` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/schedule`, `@nestjs/swagger`, `@marinoscar/memoriahub-contract`, `nestjs-zod` and `zod`.

## Configuration

`MemoriesModule.forRoot({ digest: { signingKey }, providers: [MEMORIES_ALBUMS, ...], enabled?, imports? })`. Settings: `features.memories` (kill switch `MEMORIES_ENABLED`, folded with the host's `enabled()`), the whole `memories.*` namespace, `ai.features.memories`, and the per-user `memories` preferences (read-time filters only, never a generation input).

## Extension-point catalog

| Name | Kind | What the host gives |
| --- | --- | --- |
| `MEMORIES_OPTIONS` | token | the resolved `MemoriesHostOptions` (bound by `forRoot`) |
| `MEMORIES_ALBUMS` | token | `MemoriesAlbumsPort`: save a memory as an album over the host's album code |
| `MEMORIES_EMAIL_READINESS` | token | optional `MemoriesEmailReadiness`; without it the host is taken as able to mail |
| `MEMORIES_GENERATION_HOOK` | token | optional hook called after a generation run created memories (the web app emits its `memories.memory.created` webhook from it) |

`describeMemoriesSliceConformance` (`./memories/testing`) proves the registration: both job handlers server-only, the type strings pinned.

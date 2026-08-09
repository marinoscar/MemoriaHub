# Memories — Resurface Your Best Moments

| Field | Value |
|-------|-------|
| **Version** | 0.4 (data model + generation plumbing + curation engine, On This Day & Trips) |
| **Last Updated** | August 2026 |
| **Status** | Partial — Data Model (#301), Generation plumbing & Settings (#302), Curation engine / On This Day / template titles (#303), Trips curator (#304); §5–§8 and §10 are placeholders for later issues in epic #300 |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Data Model](#2-data-model)
3. [Generation](#3-generation)
4. [Curation Engine](#4-curation-engine)
5. [AI Titles, Subtitles & Narratives](#5-ai-titles-subtitles--narratives)
6. [API](#6-api)
7. [Notification Center Integration & Email Digest](#7-notification-center-integration--email-digest)
8. [Web UI](#8-web-ui)
9. [Settings](#9-settings)
10. [RBAC](#10-rbac)
11. [Future Work](#11-future-work)

---

## 1. Overview and Goals

Memories (epic [#300](https://github.com/marinoscar/MemoriaHub/issues/300)) makes MemoriaHub actively resurface a circle's best moments — "On this day 6 years ago", "Trip to Guanacaste, March 2023", "Best of Abuela, 2025", "Your 2025 in review" — instead of leaving the library a purely passive archive. This is a core piece of the product's "Family Memories First" vision (see `VISION.MD`).

Following the Immich precedent, memories are **persisted and pre-generated**, not computed on read: at ~70k photos and ~8k videos, trip clustering, quality scoring, and AI title generation are all too expensive to run per-request. A background job curates memory collections ahead of time; the API and UI only ever read already-materialized rows.

Seven memory types ship across the epic (see [§2.1](#21-memorytype-enum)): `on_this_day`, `trip`, `person_highlights`, `person_over_years`, `theme`, `seasonal`, `year_in_review`. Each is produced by its own curator, gated by its own `memories.<type>.enabled` setting, and degrades independently — e.g. no geo data means no trips, but every other type is unaffected.

The epic is delivered incrementally, and this document grows with it. Implemented so far: the database foundation — the `MemoryType` enum and the `Memory` / `MemoryItem` / `MemoryUserState` models ([#301](https://github.com/marinoscar/MemoriaHub/issues/301), §2) — and the configuration surface plus generation plumbing: the `features.memories` flag, the `memories.*` namespace, `ai.features.memories`, and an hourly per-circle `memory_generation` job whose handler is still a deliberate **no-op** ([#302](https://github.com/marinoscar/MemoriaHub/issues/302), §3 and §9). Every later issue builds on the #301 schema without altering it.

Sections 5–8 and 10 are placeholders that name the issue expected to fill them in; do not treat their absence as an oversight. With #303 landed, an enabled deployment generates real `on_this_day` memories; the remaining six types arrive with #304–#305 and plug into the §4 engine unchanged.

## 2. Data Model

New Prisma models, migration `20260809130452_add_memories`. Introduced by issue [#301](https://github.com/marinoscar/MemoriaHub/issues/301).

```prisma
enum MemoryType {
  on_this_day
  trip
  person_highlights
  person_over_years
  theme
  seasonal
  year_in_review
}
```

### 2.1 `MemoryType` enum and the `periodKey` / `subjectKey` contract

Every `Memory` is identified within its circle by the triple `(type, periodKey, subjectKey)` — this is what makes regeneration idempotent (§2.3). What `periodKey` and `subjectKey` hold is entirely determined by `type`:

| `type` | `periodKey` holds | `subjectKey` holds | Example title |
|---|---|---|---|
| `on_this_day` | Anchor date being resurfaced, e.g. `"2026-08-08"` | Source year of the underlying photos, e.g. `"2019"` | "On this day — 7 years ago" |
| `trip` | Trip start date, e.g. `"2023-03-12"` | Dominant locality slug | "Trip to Guanacaste, March 2023" |
| `person_highlights` | Year (`"2025"`) or `"all"` | `personId` | "Best of Abuela, 2025" |
| `person_over_years` | Always `"all"` | `personId` | "Camila through the years" |
| `theme` | Year (`"2025"`) or `"all"` | Tag name, lowercased | "Golden sunsets" |
| `seasonal` | e.g. `"2025-summer"` | Unused — always `""` | "Summer 2025" |
| `year_in_review` | Year, e.g. `"2025"` | Unused — always `""` | "Your 2025 in review" |

`subjectKey` is `String @default("")`, **never nullable**, even for the two types (`seasonal`, `year_in_review`) that don't use it. This is deliberate: Postgres unique indexes treat every `NULL` as distinct from every other `NULL`, so a nullable `subjectKey` would silently defeat the `@@unique([circleId, type, periodKey, subjectKey])` constraint for those two types — the same pitfall already documented on `notifications_review_queue_live_uniq_idx` (see `schema.prisma`'s `Notification` model comment). Using `""` instead of `NULL` keeps the unique index effective for every type uniformly, with no per-type special-casing anywhere that reads or writes it.

### 2.2 `memories`

One row per generated memory collection.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `@default(uuid())` |
| `circle_id` | UUID | FK → `circles`, **Cascade** — deleting a circle removes all its memories |
| `type` | `MemoryType` | Selects the curator that produced this row and how `period_key`/`subject_key` are interpreted (§2.1) |
| `period_key` | Text | See §2.1 |
| `subject_key` | Text, default `''` | See §2.1 — never `NULL` |
| `person_id` | UUID? | FK → `people`, **Cascade**; set only for `person_highlights` / `person_over_years` |
| `title` | Text | |
| `subtitle` | Text? | |
| `narrative` | Text? | Optional AI-written short blurb shown in the story player / email digest |
| `title_source` | Text | `'template'` \| `'ai'` — which path produced `title`/`subtitle`/`narrative` |
| `title_model` | Text? | AI model id when `title_source='ai'` (audit trail); `NULL` for template-sourced titles |
| `cover_media_item_id` | UUID? | FK → `media_items`, **SetNull** |
| `period_start` / `period_end` | Timestamptz | Covered capture-date range; powers per-user sensitive-date filtering (a future issue) |
| `item_count` | Int | Denormalized member count, for card rendering without a join |
| `meta` | Jsonb? | Per-type extras: `{ yearsAgo, locality, country, tag, season, generatorVersion }` |
| `generated_at` | Timestamptz | First creation |
| `refreshed_at` | Timestamptz | Last curator refresh |
| `expires_at` | Timestamptz? | `on_this_day` only: end of the anchor day (UTC); `NULL` for every other type. A memory is **active** when `expiresAt IS NULL OR expiresAt > now()` |
| `deleted_at` | Timestamptz? | **User-delete tombstone** — see §2.5, not a normal soft-delete |
| `created_at` / `updated_at` | Timestamptz | Standard `@default(now())` / `@updatedAt` |

Indexes:

- `@@unique([circleId, type, periodKey, subjectKey])` — **the** idempotent-regeneration dedup key. Deliberately spans both live and tombstoned rows (§2.5).
- `@@index([circleId, deletedAt, expiresAt, generatedAt(sort: Desc)])` — serves the feed/list query: active, non-expired memories newest-first.
- `@@index([circleId, type])`
- `@@index([personId])`
- `@@index([coverMediaItemId])`

### 2.3 `memory_items`

One row per media item included in a `Memory`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `memory_id` | UUID | FK → `memories`, **Cascade** |
| `media_item_id` | UUID | FK → `media_items`, **Cascade** — a hard-deleted photo silently leaves the memory; the next curator refresh corrects `Memory.itemCount` to match |
| `position` | Int | Curator-assigned, chronological ascending — the story player plays time-forward |
| `score` | Float? | Curation score, kept for debugging/refresh diffing, not re-derived on read |

Constraints: `@@unique([memoryId, mediaItemId])`, `@@index([memoryId, position])`, `@@index([mediaItemId])`.

### 2.4 `memory_user_state`

Per-user state against a `Memory`: seen, hidden, favorited.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `memory_id` | UUID | FK → `memories`, **Cascade** |
| `user_id` | UUID | FK → `users`, **Cascade** |
| `seen_at` | Timestamptz? | |
| `hidden_at` | Timestamptz? | **Per-user** hide — distinct from `Memory.deletedAt`, which is circle-wide (§2.5) |
| `favorited_at` | Timestamptz? | |
| `created_at` / `updated_at` | Timestamptz | Standard |

Constraints: `@@unique([memoryId, userId])`, `@@index([userId, favoritedAt])`.

**Rationale — why a separate per-user table instead of per-user `Memory` rows:**

| Option | Verdict | Why |
|---|---|---|
| One `Memory` row shared by the circle, personal state in a companion `MemoryUserState` table (**chosen**) | ✅ | `Memory`/`MemoryItem` are circle-scoped **content** — every member sees the same trip, the same "Best of Abuela" collection, the same item list. Only seen/hidden/favorite is genuinely personal. Generation runs once per circle regardless of member count. |
| One `Memory` (+ `MemoryItem` set) per `(circle, user)` pair | ❌ | N-user duplication of the exact same item list; generation cost multiplied by circle size for content that is identical across members. Rejected. |
| Personal state folded directly onto `Memory` (single-user column set) | ❌ | Circles are multi-member by design; a single `seenAt`/`hiddenAt`/`favoritedAt` set on `Memory` could only ever represent one user's state. Rejected. |

### 2.5 The tombstone contract

`Memory.deletedAt` is **not** a conventional soft-delete flag — it is a **tombstone**, and the distinction is load-bearing:

- A normal soft-delete (e.g. `MediaItem.deletedAt`, `Person.deletedAt`) marks a row inactive but leaves regeneration logic untouched; nothing in this codebase tries to recreate a soft-deleted `MediaItem`.
- A `Memory`, by contrast, is **regenerated on a schedule** — the hourly `MemoriesGenerationTask` cron (§3) re-derives and upserts memories every run. Without a tombstone, a user who deletes a memory they don't want would see it silently reappear on the very next generation pass, because the curator's idempotent upsert (keyed on `(circleId, type, periodKey, subjectKey)`) has no way to know the user rejected it.

The fix is that `@@unique([circleId, type, periodKey, subjectKey])` spans **both live and tombstoned rows** — a deleted memory keeps occupying its dedup slot forever. This is what makes the tombstone effective: the natural key stays claimed even after `deletedAt` is set, so the curator's upsert finds the existing (tombstoned) row and must skip it rather than create a fresh one under the same key.

This has one concrete implication for every future issue that touches memory generation or reads: **every curator upsert and every read path MUST filter `deletedAt IS NOT NULL` explicitly.** Prisma has no row-level default filter (no equivalent of a database `VIEW` or ORM-level global scope in this codebase's Prisma setup), so this is an application-code discipline enforced by convention and code review, not a schema-level guarantee. Concretely:

- A curator's upsert step must `SELECT` (or equivalent) by `(circleId, type, periodKey, subjectKey)` **including tombstoned rows**, and if a matching row exists with `deletedAt IS NOT NULL`, it must skip that natural key entirely for this run — never `UPDATE` a tombstoned row back to life, and never `INSERT` a second row under the same key (which the unique index would reject anyway with a `P2002`).
- Every list/feed/detail read path must add `deletedAt: null` to its `WHERE` clause, the same way `MediaItem` reads already filter `deletedAt: null` / `archivedAt: null` throughout this codebase.

"Delete is forever" is the intended user-facing behavior: once a user removes a memory, the underlying photos remain untouched (delete only removes the curated collection, never the media), but that specific collection never resurfaces again.

### 2.6 Relation and cascade summary

| Relation | On delete of parent | Effect on `Memory`/`MemoryItem`/`MemoryUserState` |
|---|---|---|
| `Memory.circleId → Circle` | Circle deleted | **Cascade** — all the circle's memories (and transitively their items/user-state) are removed |
| `Memory.personId → Person` | Person deleted or merged away | **Cascade** — that person's `person_highlights`/`person_over_years` memories are removed outright; the next generation run regenerates fresh ones under the surviving person on a merge |
| `Memory.coverMediaItemId → MediaItem` | Cover photo hard-deleted | **SetNull** — the memory survives, just loses its cover image; a curator refresh can pick a new one |
| `MemoryItem.memoryId → Memory` | Memory deleted (hard, not tombstoned) | **Cascade** |
| `MemoryItem.mediaItemId → MediaItem` | Member photo hard-deleted | **Cascade** — the photo silently leaves the memory; `Memory.itemCount` is corrected on the next curator refresh |
| `MemoryUserState.memoryId → Memory` | Memory deleted | **Cascade** |
| `MemoryUserState.userId → User` | User deleted | **Cascade** |

Note that `Memory.deletedAt` (the tombstone, §2.5) is an **application-level** soft-delete and does **not** trigger any of the cascades above — a tombstoned `Memory` row, and its `MemoryItem`/`MemoryUserState` children, remain in the database exactly as before; only a hard delete of the `Memory` row itself (which this issue's schema does not expose through any API — none exists yet) would cascade.

### 2.7 Alternatives considered

| Alternative | Verdict | Why rejected |
|---|---|---|
| Computed-on-read memories (no persistence) | ❌ | Cost is infeasible at ~70k photos — trip clustering, scoring, and (optionally) AI title generation would all have to run per page-load. There are also no stable ids for notifications, the email digest, or per-user state (seen/hidden/favorite) to attach to without a persisted row. |
| Reusing `Album`/`AlbumItem` | ❌ | Albums have no type/period identity (no way to express "this is the `on_this_day` memory for 2019"), no per-user state, and no expiry/tombstone semantics. Overloading them would require bolting all of §2.1–§2.5 onto a model designed for a different purpose. |
| Hard delete instead of a tombstone | ❌ | Idempotent regeneration (the curator's upsert keyed on the natural key) would simply recreate the memory on the very next run — deleting a memory would have no lasting effect from the user's perspective. |

---

## 3. Generation

Introduced by issue [#302](https://github.com/marinoscar/MemoriaHub/issues/302). The scheduling, gating, dedup and observability plumbing ships here with a **no-op handler** — zero curators — so the whole queue path is proven end to end before any curation logic lands in [#303](https://github.com/marinoscar/MemoriaHub/issues/303)–[#305](https://github.com/marinoscar/MemoriaHub/issues/305).

Everything lives in `apps/api/src/memories/` (`MemoriesModule`, registered in `AppModule`), a minimal-template module mirroring `InsightsModule`: `imports: [PrismaModule, SettingsModule, EnrichmentModule]`.

### 3.1 `MemoriesGenerationTask` — the hourly interval-gated cron

`memories-generation.task.ts`. `@Cron(CronExpression.EVERY_HOUR)`, wrapped in a try/catch that never throws (the contract every cron task in this repo follows), plus an in-process `sweepInFlight` overlap guard so a sweep that outlives its hourly slot is not run twice concurrently.

Three gates, **in this order**:

| # | Gate | Effect |
|---|---|---|
| 1 | `MEMORIES_ENABLED=false` (env) | Return immediately — before even the cached settings read |
| 2 | `isMemoriesEnabled(settings)` — i.e. `features.memories === true` | Return before paging circles |
| 3 | Per circle: no `pending`/`running` `memory_generation` job for that circle, **and** its last `succeeded` job is older than `memories.generation.intervalHours` | Enqueue, else skip |

Gate ordering is what delivers the epic's **zero-cost-when-off** requirement (see the new-install matrix in [#300](https://github.com/marinoscar/MemoriaHub/issues/300)): with the flag absent — the default — a tick costs exactly one *cached* `SystemSettingsService.getSettings()` call and writes nothing; with the env kill-switch set it costs nothing at all. A circle that has never generated has no `succeeded` row, so it has no `last` and is always eligible. Only `succeeded` jobs gate the interval — a `failed` run does not push the next attempt out by a day.

Circles are keyset-paged 100 at a time (`orderBy: { id: 'asc' }`, `cursor` + `skip: 1`), and each page issues exactly **two** batched job reads — one `findMany` for in-flight jobs and one `groupBy(['circleId'], { _max: { finishedAt } })` for the last success — rather than two reads per circle. A per-circle enqueue failure is logged and counted, never fatal: one bad circle must not stop the rest of the deployment from generating.

The sweep body is exposed as `sweep()` (returning `{ circles, enqueued, skipped, errors }`) rather than inlined into the cron handler, so the admin backfill in [#315](https://github.com/marinoscar/MemoriaHub/issues/315) can drive the identical code path.

### 3.2 Why `skipDedup: true` is mandatory

Jobs are enqueued through `EnrichmentJobService.enqueue({ type: 'memory_generation', mediaItemId: null, circleId, reason: JobReason.backfill, priority: 100, skipDedup: true })`.

`skipDedup: true` is **not optional**. The service's default idempotency check looks for an existing pending/running job with the same `(type, mediaItemId)` — and for a global job `mediaItemId` is `NULL` for *every* circle, so the first circle's job would swallow the enqueue for all the others, system-wide. This task's per-circle pending/running check (gate 3) is the correctly-scoped replacement for that dedup. Same reasoning, same flag, as `face_auto_archive_sweep`.

`priority: 100` is the repo's background tier (`rerun=0`, `upload=10`, `backfill=100`), so memory generation can never starve upload enrichment.

> **Deviation from the issue text.** Issue #302 specifies `reason: 'scheduled'`, but the `JobReason` enum is `upload | rerun | backfill` and adding a value is a schema change owned by [#301](https://github.com/marinoscar/MemoriaHub/issues/301). `JobReason.backfill` is used instead — this repo's established reason for cron-enqueued background work at priority 100 (`trash_purge`, `thumbnail_repair`, `storage_insights` all do the same).

### 3.3 `MemoryGenerationHandler` — server-only, v1 no-op

`memory-generation.handler.ts`. Implements `EnrichmentHandler` with `readonly type = 'memory_generation'` and self-registers via `onModuleInit() { this.registry.register(this) }` — the mandatory registration pattern (see [Enrichment Queue §6](enrichment-queue.md)), never multi-provider DI.

**Server-only**: it deliberately omits both `nodeResultSchema` and `persistNodeResult`. Curation is a whole-circle DB read/write pass with no per-item unit of work to hand a distributed node, and from [#306](https://github.com/marinoscar/MemoriaHub/issues/306) it needs a server-held AI credential. Because the pair is absent, `EnrichmentHandlerRegistry.serverOnlyTypes()` picks the type up automatically and it becomes eligible for the `ENRICHMENT_WORKER_MODE=system` claim set **with no explicit pinning** — the same no-node-pair inference that already covers `face_auto_archive_sweep` and the `location_inference` sweep, and unlike `thumbnail_repair` / `workflow_execute_batch`, which carry the pair and must be pinned by hand. The drift guard in `apps/api/src/enrichment/server-only-types.spec.ts` asserts this. `memory_generation` is correspondingly absent from the CLI's `NODE_JOB_TYPES`.

The handler **re-checks the feature gate itself** rather than trusting the cron's. A job can sit pending across a settings change, be retried by hand from `/admin/settings/jobs`, or be enqueued by the future admin backfill — none of which pass through the cron's gate. When the feature is off it **succeeds as a no-op rather than throwing**: a disabled feature is not a failure, and failing would burn retry attempts and light up the admin job dashboard for no reason. A job with a null `circleId` is likewise a logged no-op, since every memory is circle-scoped.

v1's body is a log line and a return. That log line is the observability hook proving the scheduling path works end to end.

### 3.4 Job-type labels

`JOB_TYPE_LABELS` (`apps/api/src/enrichment/job-type-labels.ts`) gains `memory_generation: 'Memory generation'` so the type renders with a friendly name in `/admin/settings/jobs`. `memory_digest: 'Memory email digest'` is declared alongside it now, ahead of its handler, so [#311](https://github.com/marinoscar/MemoriaHub/issues/311) does not have to touch the file again.

## 4. Curation Engine

Introduced by issue [#303](https://github.com/marinoscar/MemoriaHub/issues/303), which ships the shared engine, the curator registry, deterministic titles for all seven types, and the first real curator (On This Day). The remaining curators — Trips ([#304](https://github.com/marinoscar/MemoriaHub/issues/304)) and People / Theme / Seasonal / Year-in-Review ([#305](https://github.com/marinoscar/MemoriaHub/issues/305)) — plug into this engine and add no new machinery.

The split is deliberate: **a curator owns only what is type-specific** — which slice of the library it is interested in, its `periodKey`/`subjectKey` identity, its template title, and its own retention tail. Everything else (scoring, collapse, diversity, ordering, cover choice, the idempotent write, the tombstone) belongs to `MemoryCurationService` and is therefore identical across all seven types by construction rather than by convention.

| File | Role |
|---|---|
| `apps/api/src/memories/curation/memory-curation.types.ts` | The shared vocabulary (`MemoryCandidate`, `CuratedSelection`, `UpsertMemoryInput`/`Result`) |
| `apps/api/src/memories/curation/memory-curation.service.ts` | The engine: candidate streaming, scoring, collapse, diversity, `upsertMemory()` |
| `apps/api/src/memories/curation/memory-title-templates.ts` | Deterministic titles for all seven types (§4.6) |
| `apps/api/src/memories/curators/memory-curator.interface.ts` | The `MemoryCurator` contract + the `MEMORY_CURATORS` DI token |
| `apps/api/src/memories/curators/on-this-day.curator.ts` | The On This Day curator and the registry factory (§4.7) |
| `apps/api/src/memories/memories-settings.util.ts` | `resolveMemoriesSettings()` — defaults filled once per job (§4.8) |

### 4.1 The base filter is structural, not a convention

```
capturedAt IS NOT NULL AND deletedAt IS NULL AND archivedAt IS NULL AND socialMediaSource IS NULL
```

`memoryCandidateBaseWhere(circleId)` is applied by `loadCandidates()` **itself**, and every curator reaches the database only through `curate()`. A curator therefore cannot forget the filter, cannot partially apply it, and cannot be reviewed into forgetting it later — the only way to bypass it would be to write a second query path, which is a visible change rather than an omission.

`capturedAt IS NOT NULL` deserves its own note because it is the one predicate that looks like defensive noise and is not. `MediaItem.capturedAt` is genuinely nullable — an import with no EXIF `DateTimeOriginal` is common — and **every** memory type is time-anchored (`periodStart`/`periodEnd` are `NOT NULL`, `periodKey` is a date or a year). A NULL capture date does not mean "unknown time", it means "not a candidate".

The other three exclusions each encode a user intent that outranks curation: archived means "hide this from browse surfaces", trashed means "I deleted this", and a non-null `social_media_source` means "this is a re-shared TikTok, not a family memory".

### 4.2 Candidate streaming — constant memory at 70k items

`loadCandidates()` walks the slice with keyset pagination over `(capturedAt ASC, id ASC)`, 500 rows per page, following the `workflow_evaluate` precedent (`apps/api/src/workflows/runs/workflow-evaluate.handler.ts`). That ordering is a **total order** under the base filter — `capturedAt` is non-null there — so the cursor is exact with no `NULLS LAST` handling and no row skipped or repeated at a page boundary.

Two signals cannot come from the `media_items` row itself and are resolved **per page, batched** rather than per item:

| Signal | Query |
|---|---|
| `hasFavoritePersonFace` | one `face.findMany` per page: `mediaItemId IN (page)` joined to a `Person` with `favorite = true AND hiddenAt IS NULL AND deletedAt IS NULL` |
| `hasAiContent` | one `mediaTag.findMany` per page: `mediaItemId IN (page) AND source = 'ai'` (OR'd in memory with a non-empty `MediaItem.description`) |

So a page of 500 candidates costs three queries, not 1 001. Hidden and soft-deleted people are excluded from the favorite-person signal because hiding a person is an explicit "stop surfacing this to me" — honouring it in curation is the same reasoning that keeps them out of the People UI.

`DEFAULT_MAX_CANDIDATES` (20 000) bounds the resident array. It is a **crash guard, not a tuning knob**: a cap that actually bites introduces selection bias (the scan is chronological, so truncation silently curates only the earliest slice), which is why hitting it logs a warning and sets `CuratedSelection.truncated`. A curator that routinely truncates is asking the wrong question and should narrow its slice.

### 4.3 Scoring

Per candidate, higher is better:

| Signal | Contribution |
|---|---|
| `favorite = true` | `+3.0` |
| Sharpness | `+ clamp(sharpnessScore / 1000, 0, 1)`; **NULL ⇒ 0.5 (neutral)** |
| A face assigned to a live, non-hidden, `favorite` Person | `+1.0` |
| A non-empty AI description **or** ≥ 1 `source='ai'` tag | `+0.25` |

The NULL-sharpness rule is the load-bearing one. `sharpnessScore` is only written by the burst-detection pipeline, so videos and every pre-feature import carry NULL. Scoring "unmeasured" as `0` would read as "measured, and blurry", and would systematically push every un-analyzed item out of every memory on a library that predates the feature. Neutral `0.5` says what is actually true: we do not know.

Sharpness is clamped rather than raw so an unusually crisp macro shot cannot out-vote an explicit user favorite — variance-of-Laplacian is unbounded, and an unbounded term makes every other weight decorative.

**Videos carry a second, separate score.** `MemoryItem.score` persists the pure quality score above; ranking uses `selectionScore`, which subtracts `LONG_VIDEO_PENALTY` (0.5) from videos longer than 60 s or of unknown duration. Keeping them apart matters: the penalty is a *presentation preference* ("a two-minute clip is a bad thing to open a story with"), not a claim about the clip's quality, and persisting it would make the stored score lie about why an item was chosen.

### 4.4 Near-duplicate collapse

Candidates are bucketed by a `collapseKey()`: `b:<burstGroupId>` if set, else `d:<duplicateGroupId>` if set, else the item's own id. Each bucket contributes **exactly one** item:

1. the group's `suggestedBestItemId`, **if that item is itself in the candidate set** — it may have been archived, trashed or flagged since the group formed, in which case the group must still contribute rather than vanish;
2. otherwise the highest-`selectionScore` member, ties broken by `(capturedAt, id)`.

**Burst wins over duplicate** when an item somehow carries both group ids. That is not an arbitrary tie-break — it mirrors the app-wide rule already enforced by `DuplicateDetectionService.evictFromDuplicateGroups`: a burst-grouped item is not supposed to be in a duplicate group at all, and if an upload-time race left it in both, the burst grouping is authoritative.

This is also why the engine reuses these groups instead of computing its own visual cohesion: burst and duplicate groups are already CLIP/dHash-derived and already have a human-reviewable best-shot opinion. Direct embedding scoring can be added later with no schema change (`MemoryItem.score` is persisted for exactly that reason) — see §11.

### 4.5 Diversity selection, ordering and cover

Naive top-N-by-score returns thirty frames of whichever moment was photographed hardest. `selectDiverse()` instead:

1. divides the candidate span into `min(maxItemsPerMemory, candidateCount)` equal time buckets and takes each bucket's best-ranked item;
2. fills any remaining slots with the next-best overall.

A zero-length span (every candidate at one instant) skips straight to step 2. The **3-video cap** is enforced throughout both passes, so a rejected video leaves its slot to the fill pass rather than shrinking the memory — but when videos are all that exists, the memory is legitimately shorter than the cap.

Selection is **deterministic**: ties break on `(selectionScore, capturedAt, id)`, so two runs over an unchanged library produce byte-identical memories. That is what makes "re-running changes nothing" a testable claim rather than an approximate one.

Final items are ordered **chronologically ascending** with contiguous `position` values. The cover is the highest-scored **non-video** item; a video is never a cover (cover art renders as a still, and a poster frame is a different — usually worse — image than any photo in the set). An all-video memory simply has `coverMediaItemId = NULL`.

### 4.6 Template titles

`memory-title-templates.ts` is pure, I/O-free, and covers all seven types:

| Type | Title | Subtitle |
|---|---|---|
| `on_this_day` | `On this day — {N} year(s) ago` | `{Month D, YYYY}` |
| `trip` | `Trip to {place}` | `{Month YYYY}`, `{Month}–{Month YYYY}`, or `{Month YYYY}–{Month YYYY}` across a year boundary |
| `person_highlights` | `Best of {name}` (NULL name ⇒ `Best moments together`) | `{YYYY}`, or none for an all-time collection |
| `person_over_years` | `{name} through the years` (NULL name ⇒ `Through the years`) | `{firstYear}–{lastYear}`, collapsed to one year when equal |
| `theme` | `{Tag, title-cased}` | `{N} favorite moment(s)` |
| `seasonal` | `{Season} {YYYY}` | — |
| `year_in_review` | `Your {YYYY} in review` | `{N} highlight(s) from the year` |

These are **not a placeholder for AI titling** — they are the permanent floor. A deployment with no `ai.features.memories` provider configured is a supported configuration (§5, and the new-install matrix in #300), so these titles render forever there and have to read like product copy.

Two details are deliberate. Every formatter is pinned to `Intl.DateTimeFormat('en', { timeZone: 'UTC' })`: `periodStart` is a `timestamptz`, and formatting in the container's local zone would render "December 31, 2024" or "January 1, 2025" for the same instant depending on where the process happens to run — a title that changes on redeploy. And season labels plus the month→season mapping live in one exported table (`SEASON_LABELS` / `seasonForMonth`) so a future southern-hemisphere or locale configuration replaces one table rather than hunting month arithmetic through the seasonal curator.

### 4.7 The On This Day curator

**One memory per past year, not one per day.** Ten years of "on this day" are ten stories, not one 300-photo pile — and per-year identity (`subjectKey = "2019"`) is what makes per-user seen/hidden/favorite state and the tombstone meaningful: you can delete 2014's awkward party without losing 2019's beach trip.

| Field | Value |
|---|---|
| `periodKey` | the anchor day, ISO `YYYY-MM-DD` |
| `subjectKey` | the source year, e.g. `"2019"` |
| `expiresAt` | start of the day **after** the anchor (exclusive bound, matching `expiresAt > now()`) |
| `meta` | `{ yearsAgo, sourceYear, anchorMonth, anchorDay, generatorVersion }` |

**Anchors are today AND tomorrow (UTC).** Generation runs on an interval (default 24 h) while notifications and the digest fire in the morning; if a circle only ever generated for "today", an 08:00 digest would race the job producing the content it announces. Pre-generating tomorrow means the morning's content already exists the evening before, whatever order the two jobs run in.

**One query per anchor covers every lookback year.** Matching "same month and day, any year" is not a range, so it goes through raw SQL over `EXTRACT(MONTH/DAY FROM (captured_at AT TIME ZONE 'UTC'))` — the same expression and the same UTC pin as `MediaService.getDashboard`'s dashboard query (the cast is what makes `EXTRACT` `IMMUTABLE` and therefore indexable at all). Results are grouped by year in memory and each year's ids are handed back to `curate()` as an `id IN (…)` slice. That is **2 queries per circle per scheduled run**, not 2 × `lookbackYears`.

Migration `20260809140000_memories_on_this_day_index` adds a circle-scoped partial functional index for it:

```sql
CREATE INDEX "media_items_circle_captured_md_idx"
  ON "media_items" ("circle_id",
                    EXTRACT(MONTH FROM ("captured_at" AT TIME ZONE 'UTC')),
                    EXTRACT(DAY   FROM ("captured_at" AT TIME ZONE 'UTC')))
  WHERE "deleted_at" IS NULL AND "archived_at" IS NULL AND "captured_at" IS NOT NULL;
```

The pre-existing `media_items_captured_md_idx` (migration `20260615000000_media_oncethisday_index`) has no leading `circle_id` and does not exclude archived rows, so a per-circle generation job would scan every circle's rows for the calendar day — and it cannot serve the backfill's `DISTINCT (month, day)` anchor scan at all, which needs `circle_id` as the leading key. Both indexes are kept: the dashboard still issues the un-scoped variant. Like `media_items_gallery_idx` and `media_items_map_locations_idx`, this index is hand-authored, **not** representable in Prisma's schema DSL, and is documented schema drift.

**Backfill mode** (`job.payload.backfill === true`, which [#315](https://github.com/marinoscar/MemoriaHub/issues/315) sets) widens the anchor set from today+tomorrow to every `(month, day)` the circle has a candidate on — at most 366 rows from one `DISTINCT` scan. Each pair is mapped to its **next** occurrence at or after today, so a backfilled memory's `periodKey`/`expiresAt` describe a day that is still ahead rather than one already past (which would make the row born expired and immediately purge-eligible). February 29 is handled by a round-trip check rather than date arithmetic: `Date.UTC(2027, 1, 29)` silently rolls over to March 1, so a naive implementation would key three out of four "February 29" memories to March 1.

**Retention tail.** `OnThisDayCurator.purge()` hard-deletes this circle's `on_this_day` rows whose `expiresAt` is more than 30 days past — **tombstoned or not**. Ignoring the tombstone here is safe rather than a contradiction of §2.5: the tombstone's job is "do not recreate this memory", and once the anchor day is a month gone the curator has no reason to generate that `periodKey` again until the date comes back around a year later, by which point the underlying library has changed and the memory is legitimately a new one. Keeping the tombstones forever would accumulate one unreadable row per (day × year) for the life of the deployment. The tail runs at the end of every generation job rather than on its own cron: the work is proportional to what generation just produced, it must not run when the feature is off, and a separate schedule would be a second thing to reason about for one batched `deleteMany`.

### 4.8 The Trips curator

Issue [#304](https://github.com/marinoscar/MemoriaHub/issues/304). Trips are the only memory type that requires real clustering, and the only one that needs a fact the library has never held: where **home** is. Everything below follows from inferring that one fact and then asking, day by day, "were we away?".

The decision algebra is pure and lives in `apps/api/src/memories/curators/trip-clustering.ts` (no Prisma, no Nest, no clock); `trip.curator.ts` is the I/O half — one streaming scan in, curated memories out.

| Field | Value |
|---|---|
| `periodKey` | trip start date, ISO `YYYY-MM-DD` |
| `subjectKey` | slugified dominant locality (ASCII-folded, dash-separated, e.g. `guanacaste`); `''` when nothing was reverse-geocoded |
| `expiresAt` | `NULL` — unlike On This Day, a trip stays interesting |
| `meta` | `{ locality, admin1, country, distanceKm, dayCount, startDate, endDate, homePlace, homeLevel, generatorVersion }` |

#### Home inference

Over the circle's coordinate-bearing candidates from a **fixed 24-month window**, the modal `geoLocality` holding a **>= 30% share** is home, and its mean lat/lng is the home centroid.

The window is deliberately **not** a setting and is deliberately not `trips.lookbackMonths`. Home is a slow-moving fact about a family, while the lookback answers "how far back do we look for trips?"; tying them together would mean an admin narrowing the trip window to three months silently re-infers home from one quarter's photos — exactly the case where a long vacation can outvote the house. Two years is long enough that no single trip can be modal, short enough to follow a real relocation.

**Locality first, `geoAdmin1` as a fallback at the same 30% floor.** `geoLocality` is the level a person would name, but it is also the level most likely to be sparse: offline reverse geocoding frequently resolves a region and not a town, and a rural library can have `geoAdmin1` on nearly everything and `geoLocality` on almost nothing. Trying locality alone would report "home unknown" for a circle whose home is obvious one level up. The fallback keeps the *same* floor rather than a looser one — a coarser geography is easier to be modal in, so failing to clear 30% even there means there is genuinely no home here.

**No home ⇒ no trips, and that is a normal outcome, not an error.** A travel-only archive, a circle spanning three countries, or a library that was never geocoded has no center of gravity, and every day would read as "away from" a place that is not home — a wall of bogus trips. The curator logs at `debug` and returns an empty result, satisfying the epic's failure-mode row "no geo data ⇒ trips curator skips, all other types unaffected". There is no `memories.trips.homeOverride` in v1; modal inference is zero-config and new-install friendly, and an override can be added later with no schema change.

#### Away-day classification

Candidates in the trip window are grouped by **UTC calendar day**, and each day gets one of three verdicts against home:

| Verdict | Condition | Effect on a run |
|---|---|---|
| `away` | >= 3 candidates **and** the day's **median** coordinate is farther than `trips.minDistanceKm` from home — or, with no coordinates at all, >= 3 candidates whose modal `geoAdmin1` differs from home's | anchors/extends a run |
| `home` | >= 3 candidates and the median is within `minDistanceKm` | **terminates** a run |
| `neutral` | anything else (too few candidates, no usable signal) | consumes gap budget, never splits |

**The median, not the mean.** One mis-geotagged frame — a phone that cached a stale fix, a scan with a hand-entered coordinate — would drag a mean hundreds of kilometers and invent a trip. Latitude and longitude are taken independently (a *marginal* median): not the geometric median, but O(n log n), dependency-free, and identical for the compact same-day clusters this actually sees.

**A thin day is neutral even when it is far away.** One airport-layover photo should not open a trip, and one photo taken at home mid-vacation should not close one. Requiring evidence in both directions is what makes the classification stable.

**The coordinate-less fallback can only ever ADD an away day.** A matching `geoAdmin1` is weak evidence of being home (adjacent regions are minutes apart) while a differing one is strong evidence of being away, so a mismatch classifies `away` and everything else stays `neutral` — never `home`.

#### Trip assembly

Away days merge into runs tolerating **one** gap day. A single photo-less day mid-week is a day you did not take pictures, not the end of the trip.

A `home` day inside that tolerance still **terminates** the run: it is positive evidence the trip ended, not merely an absence of evidence. Treating it as a gap would fuse a weekend away, a quiet week at home, and the next weekend away into one eleven-day "trip". Runs are also trimmed to away days at both ends, so a trip never reports a start date on which nothing said "away".

A run becomes a memory when it spans >= `trips.minDays` calendar days **and** yields >= `trips.minItems` items after curation. Two cheap floors are checked before any query — span, and raw candidate count across the run's days — so a run that cannot possibly qualify never pays for a curation pass. Item selection itself is entirely §4.2–§4.5's shared engine: same base filter, same scoring, same burst/duplicate collapse, same diversity buckets, same 3-video cap, same `maxItemsPerMemory`.

The **dominant place** (locality → admin1 → country) is resolved from the run's day aggregates — every candidate in range — rather than from the curated items. A 30-item selection is a quality sample, not a geographic one, and naming a trip after whichever town contributed the sharpest photos would be arbitrary.

#### Identity and refresh stability

This is the subtle part. A trip's detected boundaries **move** when new uploads land: a second camera's photos can reveal that the trip started two days earlier. Because `periodKey` is the start date, the identity keys move with them — so matching a re-detected trip to its existing memory **by key equality would mint a duplicate on every late import**.

Instead, a re-detected run is paired with the existing `trip` memory whose **day range it overlaps by >= 50%**, and that row is **re-keyed in place** (`UPDATE`, not a competing insert — the unique index permits it, since the row already owns the old slot).

The denominator is the load-bearing detail: overlap is measured against the **shorter** of the two spans, not their union. A 3-day trip growing into a 10-day one scores `3/3 = 1.0` and refreshes; Jaccard would score it `3/10 = 0.30` and create the duplicate this rule exists to prevent. The trade — a short range fully inside a much longer one always matches — is accepted, because a 2-day run inside an existing 30-day trip really is part of that trip. Matching is greedy in descending overlap order and one-to-one on both sides, so neither a run nor a memory is ever claimed twice, and the better fit wins over whichever run happened to be chronologically first.

Overlap is computed against `meta.startDate`/`meta.endDate` — the **detected** day range — rather than `periodStart`/`periodEnd`, which describe the curated item set and are often narrower (a trip's first and last day frequently lose their photos to the diversity cap). Rows written before those meta keys existed fall back to the period columns.

**Tombstoned trips take part in matching.** This is what makes §2.5's contract hold here at all: `upsertMemory`'s own tombstone check is keyed on `(periodKey, subjectKey)`, and a shifted boundary carries *different* keys, so a key-only check would sail straight past a deleted trip and insert a fresh one. A run overlapping a tombstone is refused before any curation work.

**A drifted subject re-titles.** When a better reverse-geocode changes the dominant locality, the row is re-keyed *and* `upsertMemory` is called with `retitle: true` — an optional flag (default `false`, so every other caller is unchanged) added for exactly this case. §4.9's anti-churn rule exists to protect a title that is still accurate; a memory keyed `playa-grande` and titled "Trip to Tamarindo" is not aged, it is falsified. An ordinary refresh — one photo joining — still preserves the title, AI ones included.

If the slot a re-key would move into is already held by a *different* memory, the row keeps its current identity and refreshes there instead. The keys are an identity, not data: a stale-but-stable one beats either a failed unique-index write or deleting a memory a user may have favorited.

#### Backfill

`payload.backfill === true` drops `lookbackMonths` and sweeps the whole library; the home window stays fixed at 24 months either way. This is a single in-memory pass per circle, the same precedent as the `location_inference` sweep.

**Memory is flat in library size** because the scan aggregates as it streams and **never retains media-item ids**: a qualifying run re-selects its items through `curate()` with a date-range `where` afterwards, so the ~95% of days spent at home cost two floats and a few tallies each. `MAX_SCAN_ROWS` (500 000) is a crash guard on the per-day coordinate samples, not a tuning knob.

#### Query plan — no new index

Verified with `EXPLAIN (ANALYZE, BUFFERS)` over a seeded 30 000-item circle: the scan is served by the **existing** `media_items_gallery_idx` (`(circle_id, captured_at DESC, id DESC) WHERE deleted_at IS NULL AND archived_at IS NULL`, migration `20260716000000_media_gallery_index`) as an `Index Scan Backward` with **no sort node** — a btree scans either direction, so the index's `DESC` declaration costs nothing here — leaving only `social_media_source IS NULL` as a cheap filter:

```
Limit (actual time=0.065..4.324 rows=1000)
  ->  Index Scan Backward using media_items_gallery_idx on media_items
        Index Cond: ((circle_id = $1) AND (captured_at IS NOT NULL) AND (captured_at >= $2))
        Filter: (social_media_source IS NULL)
```

So #304 adds **no migration**. The one known cost is inherited from §4.2's `loadCandidates`: Prisma's typed `where` cannot express a row-value comparison `(captured_at, id) > ($1, $2)`, so the keyset predicate is emitted as an `OR` and lands as a `Filter` rather than an `Index Cond` — page *N* re-walks the pages before it. It is bounded (~2.5 M index-entry visits across a 70 000-item circle, low seconds inside a daily background job) and dropping to raw SQL to avoid it would also give up the structural guarantee that `memoryCandidateBaseWhere()` is applied by the engine rather than by the caller.

#### Known gaps

- **A day straddling the ±180° antimeridian gets a meaningless median longitude**, and the home centroid has the same weakness (it is a plain mean). Both would misclassify a Fiji/Kiribati-area day. Documented rather than solved: the fix is circular-mean arithmetic like `interpolateLng`'s in the location-inference engine, and it is not worth the complexity until someone is affected.
- **A day whose photos are split ~50/50 between home and a destination** can produce a marginal median that is at neither — a phantom point built from one cluster's latitude and the other's longitude. Real travel days are not bimodal; a fixture of ours was, which is how this surfaced.
- **A trip that no longer detects is not deleted**, per §4.12's general rule — the curator only upserts runs that still qualify.
- **`trips.minItems` above `maxItemsPerMemory`** can never be satisfied, since curation caps the selection first. Both are admin-settable within their own bounds and the combination is not cross-validated.

### 4.9 Idempotent regeneration — `upsertMemory()`

Every curator writes through this one method, keyed on `@@unique([circleId, type, periodKey, subjectKey])`.

1. **Read the existing row first.** If `deletedAt` is set, return immediately with `skippedTombstone: true` — no write, no title computation, nothing. §2.5's contract is enforced here, and it outranks every other rule in this section.
2. **Create** (row absent): `Memory` + `MemoryItem[]` in one transaction, `generatedAt = refreshedAt = now()`, `titleSource = 'template'`. A `P2002` from a concurrent pass falls through to the refresh path (re-reading, and re-checking the tombstone).
3. **Refresh** (row present and live): items are **replaced** (`deleteMany` + `createMany` in one transaction) rather than diffed — `MemoryItem` carries no per-item user state and `position` shifts on nearly every refresh, so a delta computation would be strictly more code for the same result. `itemCount`, `periodStart`/`periodEnd`, cover, `meta` and `refreshedAt` are recomputed.

**`MemoryUserState` is untouched by design.** It lives in its own table keyed by memory id, so a refresh that replaces every item preserves seen/hidden/favorited for every user. That is precisely why per-user state was not modeled as columns on `Memory` (§2.4).

**Titles survive a minor refresh.** Membership change is measured as Jaccard **distance** on the media-item id sets; below `MATERIAL_CHANGE_THRESHOLD` (30%) the `title`/`subtitle`/`narrative`/`titleSource`/`titleModel` are all left alone. Without this, one new photo joining a ten-item memory would discard an AI title (#306) and re-pay for it on every generation run forever. At or above 30% the old title may now describe a collection that no longer exists, so it is reset to the template with `titleSource = 'template'`, `titleModel = NULL` and `narrative = NULL`, and handed back to AI re-titling on a later pass.

`UpsertMemoryResult` returns `{ memoryId, created, materiallyChanged, skippedTombstone }`. `materiallyChanged` exists for [#311](https://github.com/marinoscar/MemoriaHub/issues/311)'s notification and digest producers, which need "is there anything genuinely new to tell the circle about?" without re-diffing the item set themselves.

`meta.generatorVersion` (currently `1`) is stamped centrally on every write. Bump it when scoring or selection changes in a way that would produce a different item set from identical inputs — it is the only way to tell, after the fact, which algorithm produced a given memory.

### 4.10 Registry and per-curator error isolation

Curators are injected as an array under the `MEMORY_CURATORS` token (`memoryCuratorsProvider`, which moved to its own `curators/memory-curators.provider.ts` in #304 once it imported more than one curator — a file that also *defines* a curator importing its siblings is a needless coupling and an easy way to grow an import cycle), so #305 adds a provider plus one entry in that factory and touches nothing else. Order is execution order, cheapest-first: On This Day runs two bounded functional-index queries, Trips streams the circle's geo history. `MemoryGenerationHandler` iterates it:

- each curator is gated by **its own** `memories.<type>.enabled` toggle, checked via `MemoryCurator.isEnabled(settings)` rather than a stringly-typed settings key on the registry entry;
- each `run()` is **individually try/caught**, and so is each `purge()`;
- the retention tail runs **even when `run()` threw** — expired rows are stale regardless of whether this pass produced new ones, and a curator whose generation is broken is exactly the one whose old rows would otherwise accumulate;
- the job **succeeds** as long as the plumbing worked, logging a structured `memory_generation.completed` summary with `created`/`refreshed`/`tombstoned`/`purged`/`failedCurators`.

This is a correctness requirement, not politeness. The seven types are independent producers of independent content: a circle with malformed geo data must still get its On This Day memories, and a single throwing curator must not burn the job's retry budget or leave six other types un-generated until a human notices a red row in `/admin/settings/jobs`.

One wall clock (`ctx.now`) is captured once by the handler and shared by every curator, so a run that straddles midnight cannot have one curator anchoring on today and the next on tomorrow.

### 4.11 Settings resolution

`resolveMemoriesSettings()` deep-merges the stored `memories.*` namespace over `DEFAULT_SYSTEM_SETTINGS.memories` **once per generation job**, so curators read `settings.onThisDay.minItems` unconditionally and never carry their own `?? 10` fallbacks. The namespace is genuinely optional on an older JSONB row — that is what makes it migration-free (§9.2) — and per-curator fallbacks would be a fourth hand-maintained copy of every default, on top of the three §9.3 already warns about.

### 4.12 Known gaps

- **A period that falls below `minItems` after items are removed keeps its existing memory.** Curators only upsert periods that still qualify; they do not delete a memory whose material has since been trashed. Its `MemoryItem` rows for hard-deleted media cascade away and `itemCount` is corrected on the next refresh, but a memory whose items were all *soft*-deleted lingers until read-time filtering ([#307](https://github.com/marinoscar/MemoriaHub/issues/307)) hides it. Deleting it automatically was rejected for v1: a curator silently destroying a memory a user may have favorited is a worse failure than a stale one.
- **Backfill is unchunked.** A full On This Day backfill for a dense circle is up to 366 anchors × `lookbackYears` curations in one job, which can approach `ENRICHMENT_JOB_TIMEOUT_MS`. It is memory-safe (nothing accumulates across anchors) and restartable (every write is idempotent), but chunking the admin backfill into multiple jobs belongs to #315.
- **Truncation is chronologically biased.** When `DEFAULT_MAX_CANDIDATES` is hit the scan keeps the earliest candidates. See §4.2 for why that is accepted as a crash guard rather than solved.

## 5. AI Titles, Subtitles & Narratives

Placeholder. Covered by issue [#306](https://github.com/marinoscar/MemoriaHub/issues/306). Expected to define: the `ai.features.memories` `{ provider, model }` config (mirroring `ai.features.tagging`/`search`/`embedding`) and its `PUT /api/ai/features/memories` endpoint, and a `MemoryTitleService` that generates `title`/`subtitle`/`narrative` with a hard timeout and falls back to deterministic templates on any failure — `Memory.titleSource`/`Memory.titleModel` (§2.2) exist specifically to audit which path ran for a given row.

## 6. API

Placeholder. Covered by issue [#307](https://github.com/marinoscar/MemoriaHub/issues/307). Expected to define: list/feed/detail endpoints, per-user state (seen/hide/favorite via `MemoryUserState`), delete (the tombstone write, §2.5), save-as-album, and per-user preferences (hidden people, sensitive date ranges, digest opt-out).

## 7. Notification Center Integration & Email Digest

Placeholder. Covered by issue [#311](https://github.com/marinoscar/MemoriaHub/issues/311). Expected to define: a new `memories_ready` `NotificationType` enum value (see `docs/specs/notifications.md`) with a per-user preference, and a `MemoryDigestTask` cron → per-circle `memory_digest` `enrichment_jobs` row producing a per-recipient HTML email with a long-lived HMAC-signed public thumbnail route and a tokenized, no-login unsubscribe link.

## 8. Web UI

Placeholder. Covered by issue [#309](https://github.com/marinoscar/MemoriaHub/issues/309) (Home carousel & `/memories` hub) and issue [#313](https://github.com/marinoscar/MemoriaHub/issues/313) (full-screen story player, save-as-album, share, and memory preferences UI).

## 9. Settings

Introduced by issue [#302](https://github.com/marinoscar/MemoriaHub/issues/302). The admin page that edits these (`/admin/settings/memories`) arrives with issue [#315](https://github.com/marinoscar/MemoriaHub/issues/315); until then every key below is reachable through the generic `PUT`/`PATCH /api/system-settings` (Admin + `system_settings:write`).

The **full** namespace ships now, not just the keys #302 reads, so every later issue in the epic consumes its parameters through the one cached `SystemSettingsService.getSettings()` call with no further schema change. Issue #302 itself actively reads only `memories.generation.intervalHours` (plus the feature flag).

### 9.1 `features.memories` — the global flag

A boolean in the open `features` record (`z.record(z.string(), z.boolean())`), so it needs no schema change of its own; it is added to `FEATURE_KEYS` and to `DEFAULT_SYSTEM_SETTINGS.features` as `false`. **Default off.** It flows to clients automatically via `GET /api/features`, whose `getPublicFeatures()` spreads `settings.features` — which matters because that endpoint requires authentication only, so a non-admin circle member can resolve the gated affordance without a 403 on the Admin-only `GET /api/system-settings`.

`MEMORIES_ENABLED` (env, default `true`) is the hard kill-switch, with the same semantics as `THUMBNAIL_REPAIR_ENABLED` / `BURST_DETECTION_ENABLED`: when `'false'`, the cron enqueues nothing and the handler no-ops **regardless** of the system setting. The two are folded together by `isMemoriesEnabled(settings)` in `apps/api/src/common/types/settings.types.ts` — a single source of truth shared by the cron, the handler and every future Memories surface, mirroring `isWorkflowsEnabled` / `isPictureEnhancementEnabled` so no caller can drift on what "enabled" means. Documented in `infra/compose/.env.example`.

### 9.2 The `memories.*` namespace

| Key | Type / bounds | Default | Read by |
|---|---|---|---|
| `generation.intervalHours` | int 1–168 | `24` | #302 (the cron's interval gate) |
| `maxItemsPerMemory` | int 5–100 | `30` | #303 |
| `aiTitles.enabled` | bool | `true` | #306 |
| `onThisDay.enabled` | bool | `true` | #303 |
| `onThisDay.lookbackYears` | int 1–50 | `10` | #303 |
| `onThisDay.minItems` | int 1–20 | `3` | #303 |
| `trips.enabled` | bool | `true` | #304 |
| `trips.minDays` | int 1–14 | `2` | #304 |
| `trips.minItems` | int 3–100 | `10` | #304 |
| `trips.minDistanceKm` | int 5–500 | `50` | #304 |
| `trips.lookbackMonths` | int 1–240 | `18` | #304 |
| `people.enabled` | bool | `true` | #305 |
| `people.favoritesOnly` | bool | `true` | #305 |
| `people.minItems` | int 3–50 | `8` | #305 |
| `themes.enabled` | bool | `true` | #305 |
| `themes.minItems` | int 3–50 | `8` | #305 |
| `themes.maxPerPeriod` | int 1–10 | `3` | #305 |
| `seasonal.enabled` | bool | `true` | #305 |
| `seasonal.minItems` | int 5–100 | `12` | #305 |
| `yearInReview.enabled` | bool | `true` | #305 |
| `yearInReview.minItems` | int 5–100 | `15` | #305 |
| `digest.enabled` | bool | `true` | #311 |
| `digest.frequency` | enum `off`\|`daily`\|`weekly`\|`monthly` | `weekly` | #311 |
| `digest.sendHourUtc` | int 0–23 | `8` | #311 |
| `digest.imageTokenTtlDays` | int 7–90 | `30` | #311 |

Note the per-type `enabled` flags all default to **`true`** while `features.memories` defaults to **`false`**. That is intentional: the master flag is the only off switch that matters for a fresh install, and once an admin turns Memories on they should get all seven memory types without having to enable each one individually.

### 9.3 Three hand-maintained copies — a real pitfall

This repo duplicates every settings namespace by hand across **three** files, and all three must be edited together:

| File | Symbol | Role |
|---|---|---|
| `common/schemas/settings.schema.ts` | `systemSettingsSchema` | Validation + defaults for `PUT`, and for the merged document `patchSettings` re-parses |
| `common/schemas/settings.schema.ts` | `systemSettingsPatchSchema` | All-optional twin |
| `settings/dto/update-system-settings.dto.ts` | `patchSystemSettingsSchema` | **The wire DTO** |

The third one is the trap. It is what `nestjs-zod` validates the request body against, and it **strips unknown keys**, so a namespace added only to the first two validates and merges perfectly in unit tests while every real `PATCH` silently no-ops — the key never survives the DTO. (`workflows.*` and `backup.*` are, as of this writing, in exactly that state: schema-complete but absent from the wire DTO, hence not PATCH-able over HTTP.) `memories` is present in all three, and `test/memories/memories-settings.integration.spec.ts` round-trips every key through the real HTTP endpoint precisely to keep it that way.

`SystemSettingsService.patchSettings` also merges each key by hand (there is no generic deep merge), and `getSettings()`/`replaceSettings()` project the resolved document field by field — so a new namespace must be added there too or it will never be *returned*, only stored.

### 9.4 `ai.features.memories`

Lives under `ai.features.*`, not `features.*`. Shape is `{ provider, model } | null`, default `null` — the same nullable-object contract as `ai.features.enhance`, chosen because a half-filled provider/model pair is not a usable selection, so clearing either field clears the whole thing.

- `PUT /api/ai/features/memories` — body `{ provider, model }`, Admin + `ai_settings:write`. Mirrors `PUT /api/ai/features/tagging`.
- Surfaced (masked, like its siblings) by `GET /api/ai/settings`.
- Model candidates come from the existing `GET /api/ai/models?provider=&capability=chat` — memories generate titles/subtitles/narratives, which is a **chat** capability. No new capability value was added.
- `AiSettingsService.resolveMemoriesConfig()` returns the pair or `null`; `null` means memory titles fall back to deterministic templates (#306), never an error.

One deliberate divergence from the older `search`/`tagging`/`embedding` setters: a non-null selection is **validated against the credential store up front** and rejected with a `400` when the provider has no configured, *enabled* credential. Those older setters accept anything, which is tolerable for a feature whose next call is an interactive request the admin will see fail — but a bad Memories selection would only ever surface inside a background `memory_generation` job, where nobody is watching.

Consumed by `MemoryTitleService` in [#306](https://github.com/marinoscar/MemoriaHub/issues/306); #302 ships only the config, the endpoint and their tests.

## 10. RBAC

Placeholder. Covered by issue [#307](https://github.com/marinoscar/MemoriaHub/issues/307) and issue [#315](https://github.com/marinoscar/MemoriaHub/issues/315). No new permission has been introduced by issue #301 — the data model alone grants no access; every read/write path a later issue adds is expected to reuse the existing `media:read`/`media:write`/`media:delete` permissions plus per-circle `viewer`/`collaborator` roles, following the precedent set by Workflows and Notifications (see CLAUDE.md's RBAC Model section).

## 11. Future Work

| Capability | Notes |
|---|---|
| Native memory share target (`ShareTargetType` extension + public memory renderer) | Explicitly deferred by epic #300; v1 shares via save-as-album → the existing album share flow |
| Music/audio in the story player; video-file (MP4) export of a memory | Explicitly deferred by epic #300 |
| Activity-based personalization (learning from viewed/skipped memories) | Explicitly deferred by epic #300 |
| "Then and Now" composites, collages, cinematic photos | Explicitly deferred by epic #300 |
| Mobile app (Android) surfaces | API is designed so the app can consume it later; no Android work in this epic |
| Item-level scrubbing of hidden people inside mixed memories | v1 hides an entire memory whose `personId` matches a hidden person; a memory containing a hidden person only as one face among several is not scrubbed at the item level — documented limitation |

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | August 2026 | AI Assistant | Initial specification for issue #301: the `MemoryType` enum, the `Memory`/`MemoryItem`/`MemoryUserState` data model, the `periodKey`/`subjectKey` semantics, the tombstone contract, cascade summary, and alternatives considered. Sections 3–10 are placeholders for later issues in epic #300. |
| 0.4 | August 2026 | AI Assistant | Issue #304: added §4.8 (the Trips curator — fixed-24-month home inference with the 30% modal-share floor and the same-floor `geoAdmin1` fallback, median-based three-way away/home/neutral day classification and the coordinate-less metadata fallback that can only add an away day, gap-tolerant run merging where a home day terminates rather than bridges, the >=50%-of-the-SHORTER-span overlap matching that re-keys a boundary-shifted trip in place instead of duplicating it, tombstone participation in that matching, the `retitle` flag for a drifted subject, backfill and its flat-memory streaming aggregation, the EXPLAIN-verified reuse of `media_items_gallery_idx` with no new migration, and known gaps). Renumbered the former §4.8–§4.11 to §4.9–§4.12 so the curator sections sit together. §5–§8 and §10 remain placeholders. |
| 0.3 | August 2026 | AI Assistant | Issue #303: filled in §4 (Curation Engine — the structural base filter, constant-memory keyset candidate streaming with per-page batched signal lookups, the scoring weights and the neutral-NULL-sharpness rule, the pure-score-vs-selectionScore split for the long-video preference, burst/duplicate collapse and its burst-wins precedence, time-bucket diversity with the 3-video cap, deterministic ordering and the never-a-video cover rule, template titles for all seven types, the On This Day curator with its today+tomorrow anchors / one-query-per-anchor design / new circle-scoped functional index / backfill anchor widening / retention tail, the `upsertMemory()` idempotency and tombstone contract with its Jaccard title-preservation rule, the curator registry and per-curator error isolation, settings resolution, and known gaps). §5–§8 and §10 remain placeholders. |
| 0.2 | August 2026 | AI Assistant | Issue #302: filled in §3 (Generation — `MemoriesGenerationTask`'s three gates and zero-cost-when-off contract, the mandatory `skipDedup: true` rationale, the server-only `MemoryGenerationHandler` and its no-node-pair system-mode inference, job labels, and the `JobReason.backfill` deviation from the issue text) and §9 (Settings — `features.memories` + the `MEMORIES_ENABLED` kill-switch and their shared `isMemoriesEnabled()` gate, the full `memories.*` bounds/defaults table, the three-hand-maintained-copies pitfall, and `ai.features.memories` with its up-front credential validation). §4–§8 and §10 remain placeholders. |

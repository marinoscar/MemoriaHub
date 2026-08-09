# Memories — Resurface Your Best Moments

| Field | Value |
|-------|-------|
| **Version** | 1.0 (complete: data model + generation plumbing + curation engine; all seven curators; AI titles; read/act API + per-user preferences; web Home carousel, hub & story player; notifications & email digest; admin settings page & sharded library backfill) |
| **Last Updated** | August 2026 |
| **Status** | Implemented — Data Model (#301), Generation plumbing & Settings (#302), Curation engine / On This Day / template titles (#303), Trips curator (#304), People / Theme / Seasonal / Year-in-Review curators (#305), AI titles / subtitles / narratives (#306), API / per-user state / delete / save-as-album / preferences (#307), web Home carousel & `/memories` hub (#309), Notification Center integration & HTML email digest (#311), story player / save-as-album / share / preferences UI (#313), admin settings page & sharded library backfill (#315). The epic's remaining issue (#317) is documentation only |

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

With #315 landed, an enabled deployment curates all seven memory types, serves them over the API and the web hub, announces them through the Notification Center bell, mails them out as an HTML digest, plays a memory back as a full-screen story, saves and shares one as an album, lets each user hide the people and dates they never want resurfaced, and gives an admin one page to turn the feature on, tune every parameter, pick the titling model, and sweep the existing library in bounded background jobs. The epic's remaining issue is documentation.

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

`JOB_TYPE_LABELS` (`apps/api/src/enrichment/job-type-labels.ts`) gains `memory_generation: 'Memory generation'` so the type renders with a friendly name in `/admin/settings/jobs`. `memory_digest: 'Memory email digest'` sits alongside it ([§7.2](#72-digest-architecture)); both are server-only global jobs, one per circle — generation curates, digest mails the result out.

### 3.5 The library backfill, and why it is sharded

`POST /api/admin/memories/backfill` (issue [#315](https://github.com/marinoscar/MemoriaHub/issues/315), Admin + `system_settings:write`, body `{ circleId? }`) sweeps the **existing** library so a deployment that has just switched Memories on lights up with years of memories immediately, instead of the hourly cron trickling in today's anniversaries one day at a time.

It **only enqueues**. What "backfill" means — every curator's widened horizon (§4.7's every-`(month, day)` anchor set, §4.8's whole-geo-history trip scan, §4.9's all-years person census, §4.10–§4.11's all-history periods) — lives in the curators, keyed off `payload.backfill`, so there is exactly one implementation of it and this endpoint cannot drift from the scheduled path.

**Why it is not one job per circle.** A scheduled run is small by construction: two anchor days, a bounded lookback, the current and previous year. A backfill deliberately removes every one of those horizons, and the result is a job whose work is proportional to the whole library. On This Day is the worst case — up to 366 anchor days × `lookbackYears` curations, each a query plus a scored selection plus an upsert — which #303 shipped as one job while explicitly noting it can approach `ENRICHMENT_JOB_TIMEOUT_MS` (10 minutes by default). A job killed by that timeout is not merely slow: `attempts` is charged at *claim* time, so each kill burns an attempt, and after `ENRICHMENT_MAX_ATTEMPTS` the backfill fails permanently having produced only whatever the first few minutes managed each time.

So the plan is split into bounded units (`apps/api/src/memories/admin/memory-backfill.shards.ts`), following the precedent `duplicate_detection_batch` set with its 100-items-per-job chunking chosen to stay under the worker's stuck-job threshold:

| Shard | Count per circle | Bound |
|---|---|---|
| On This Day, one calendar month each | 12 | ≤ 31 anchors × `lookbackYears` |
| Trip / People highlights / People over years / Theme / Seasonal / Year in Review | 1 each (6) | Bounded by period or subject count, not by 366 days |

**18 rows per circle.** The axes differ per curator on purpose: only On This Day's cost scales with distinct calendar days, and a month is the natural bounded slice of that. Nothing is sharded further by year, person or tag — that would multiply job rows for slices whose individual cost is already small, and each extra shard re-pays that curator's census query.

Each shard is an ordinary `memory_generation` row: background priority 100 (so it can never starve upload enrichment), `skipDedup: true`, `reason: 'backfill'`, and a payload naming its slice — `{ backfill: true, curators: [...], anchorMonths?: [...], aiTitleCap }`. Being ordinary rows is the point: they are retryable, claimable by any worker slot, visible in `/admin/settings/jobs` under `type=memory_generation`, and individually idempotent, because every curator write is an upsert keyed on `(circleId, type, periodKey, subjectKey)`. A shard that fails and retries re-does only its own slice.

**The payload contract is total.** `parseMemoryGenerationPayload` (`memory-generation.payload.ts`) coerces the untrusted JSONB — hand-editable from the jobs dashboard, and possibly written by a different release — and every malformed field degrades to *absent*, i.e. to the full unsharded behaviour. That direction is deliberate: a job that runs every curator is merely slower, whereas one that silently runs none would leave an admin's backfill looking complete while producing nothing. A `curators` list naming nothing the registry knows is logged and no-ops rather than throwing.

**The AI-title budget is divided, not multiplied.** #306's `BACKFILL_AI_TITLE_CAP` is a per-**job** ceiling, so N shards would silently turn one admin click into an N× larger provider bill. The planner hands each shard `cap / shards` via `payload.aiTitleCap`, and `beginRun` clamps that to the cap so a payload can only ever *lower* it. Subsequent scheduled runs get a fresh, uncapped budget, so the library still converges on AI titles over time — exactly the convergence §5.5 designed for.

**Skipping, not double-queueing.** Circles are keyset-paged 100 at a time with **one** batched in-flight query per page; a circle that already has a `memory_generation` job pending or running is skipped and counted in `skipped`, which is what makes a double-clicked button harmless. The response is `{ enqueued, circles, skipped }`, where `enqueued` counts job **rows** (18 per circle) rather than circles. A per-shard enqueue failure is logged and skipped — one bad insert must not cost the rest of the deployment its backfill.

Gating matches the sibling global backfills exactly: `isMemoriesEnabled(settings)` — folding in the `MEMORIES_ENABLED` kill-switch, so a hard-disabled deployment cannot be made to enqueue jobs its handler would no-op — returning **400** when off, and **404** for an unknown `circleId` rather than a cheerful `{ enqueued: 0 }` that reads like success.

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

**Calendar bucketing is an opt-in second policy** (`selectByBuckets()`, added by #305, selected per call via `CurateOptions.bucketBy`). Equal time spans cannot express "every year appears" or "every month appears" — for a person photographed heavily in 2016 and again in 2025 with a quiet stretch between, equal thirds of the elapsed span put two buckets inside the same busy period. The bucketed policy takes an explicit key function (`yearBucket` for `person_over_years`, `monthBucket` for `year_in_review`) and fills **round-robin**: every bucket contributes its best item before any bucket contributes a second, so the `maxItems` cut stays unbiased rather than exhausting the earliest buckets. An optional `maxPerBucket` bounds any one bucket's share, which matters when buckets are few relative to the budget. The 3-video cap behaves exactly as above — a rejected video does not cost its bucket its turn, the bucket simply advances to its next candidate. Every other curator uses the default policy and passes nothing.

Both policies are pure and exported, and both are unit-tested with plain object literals (`memory-curation.pure.spec.ts`, `curators/curator-rules.spec.ts`).

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

**A drifted subject re-titles.** When a better reverse-geocode changes the dominant locality, the row is re-keyed *and* `upsertMemory` is called with `retitle: true` — an optional flag (default `false`, so every other caller is unchanged) added for exactly this case. §4.12's anti-churn rule exists to protect a title that is still accurate; a memory keyed `playa-grande` and titled "Trip to Tamarindo" is not aged, it is falsified. An ordinary refresh — one photo joining — still preserves the title, AI ones included.

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
- **A trip that no longer detects is not deleted**, per §4.15's general rule — the curator only upserts runs that still qualify.
- **`trips.minItems` above `maxItemsPerMemory`** can never be satisfied, since curation caps the selection first. Both are admin-settable within their own bounds and the combination is not cross-validated.

### 4.9 The People curators

Issue [#305](https://github.com/marinoscar/MemoriaHub/issues/305). Two memory types, one shared notion of who counts: `person_highlights` ("Best of Abuela, 2025" — one memory per person **per year**) and `person_over_years` ("Camila through the years" — one memory per person, spanning everything). This is the face-recognition payoff, and the pair users most often go looking for on purpose rather than stumbling into.

| | `person_highlights` | `person_over_years` |
|---|---|---|
| `periodKey` | the calendar year, `"2025"` | `"all"` |
| `subjectKey` | `personId` | `personId` |
| `personId` column | set | set |
| `meta` | `{ year, personName, generatorVersion }` | `{ firstYear, lastYear, yearCount, personName, generatorVersion }` |
| Floor | `memories.people.minItems` (8) curated items | same, plus **≥3 distinct years** of material |
| Diversity | engine default (equal time buckets) | **year buckets**, ≤4 items per year |
| `expiresAt` | `NULL` — a person memory stays relevant | `NULL` |

**Eligibility is one rule, in one place** (`curators/person-candidates.ts`), shared by both curators so they cannot drift on the question with the most policy in it. A person qualifies when they are live (`deletedAt IS NULL`), not circle-hidden (`hiddenAt IS NULL`), identifiable (a non-empty `name` **or** a `coverFaceId`), and — when `memories.people.favoritesOnly` is on, which is the default — marked `favorite`. The "non-empty" half is tightened in memory rather than in SQL: Prisma cannot express `trim(name) <> ''`, and a person named `"   "` with no cover face would otherwise get a memory titled after nothing.

**Per-user hidden-people preferences are deliberately NOT applied here.** Memories are circle-scoped content generated once for everybody; whose faces a given user does not want to see is a per-user preference, and applying it at generation time would mean either generating per user (N× the rows and N× the cost) or letting whichever user's preferences were read first decide for the whole circle. That filtering is read-time and belongs to [#307](https://github.com/marinoscar/MemoriaHub/issues/307). See §11 for the item-level limitation the epic accepts alongside it.

**An archived face does not count.** The census and both curators require `faces.hidden_at IS NULL`, mirroring the archive semantics of `PATCH /api/people/faces/bulk/hide`: an archived face is no longer evidence the person is in that photo, so it must not qualify a year they are effectively absent from.

**One grouped census decides what is worth curating.** A single query returns `COUNT(DISTINCT media_item)` per `(person, year)` for the whole circle — `persons × years-with-data` rows, a few hundred — and only pairs already clearing `minItems` on raw counts get a `curate()` pass. The alternative (streaming every person's candidates through the engine to discover most person-years are short) would page the library once per person. `COUNT(DISTINCT)` rather than `COUNT(*)` because one media item can carry several faces of the same person — a video's cross-frame identity rows, or a genuine second detection — and it is still one photo.

The census can only ever **over**-count relative to the curated set (collapse and the video cap remove items, never add), so a pair under the floor there cannot clear it afterwards. That is what makes the pre-filter sound rather than merely cheap.

**Person predicates go to the engine, not into an id list.** Both curators hand `faces: { some: { personId, hiddenAt: null } }` to `curate()` as part of the slice `where`, so the base filter, the keyset streaming and near-duplicate collapse all apply exactly as they do for every other type — there is no parallel selection path.

**Scheduled runs do the current and previous year; backfill does all of them.** "Last year" stays in scope well into the following autumn because a December import lands in the previous year's memory long after that year ended. `person_over_years` has no such narrowing: its period is always `"all"`, so scheduled and backfill runs do identical work.

#### Why `person_over_years` needs its own diversity policy

The engine's `selectDiverse` divides the memory's **time span** into equal buckets. For a person photographed heavily in 2016 and again in 2025 with a quiet stretch between, equal thirds of nine elapsed years put two buckets inside the same busy period and none in the middle — and the entire promise of this type is "every year appears", which is a statement about the calendar rather than about elapsed time.

So #305 adds `selectByBuckets()` to the engine and an opt-in `CurateOptions.bucketBy` (§4.5), used here with `key = capturedAt's UTC year` and `maxPerBucket = 4`. It is **round-robin, not bucket-at-a-time**: every year contributes its best item in round 1, its second-best in round 2, and so on, so a 30-item budget over twelve years yields at least two items from every year rather than four each from the first seven and nothing after. Bucket-at-a-time filling would reproduce precisely the chronological bias the policy exists to remove. The per-year cap is what lets quiet years appear at all; four photos of one prolific year is plenty, and issue #305 fixes the "2–4 items per year" range.

The **≥3-year floor** is what separates the two types. Two years is not "through the years", it is two years, and the per-year highlight memories already tell that story better. It is checked on the census (years with any material) rather than on the curated set, so a person whose middle year loses its slots to the item cap still qualifies.

#### Cover preference

A person memory's cover is the curated item carrying that person's **highest-confidence face** (photos only, NULLs sorted last, id tiebreak), overriding the engine's generic "highest-scored non-video item". In a memory built from group shots the engine's choice is easily the frame where the subject is a blur in the background. When nothing qualifies — an all-video selection, or only NULL-confidence faces — the engine's cover stands.

#### Person delete and merge

`Memory.personId` is a **Cascade** FK, and that is the entire cleanup story:

- **Delete** removes the person's memories outright, never leaving one dangling against a person who no longer exists.
- **Merge** (`PeopleService.merge`) reassigns the source's faces to the target and **soft**-deletes the source, which drops it out of `loadEligiblePersons`. The source's memories stop being regenerated immediately; the next run refreshes the survivor's memories over the now-larger face set.

Neither curator tries to migrate, repair or re-key anything on a merge, and that is deliberate: regenerating under the survivor is both simpler and more correct than transplanting a memory whose item set was curated from a different candidate pool.

#### Bounds

`MAX_ELIGIBLE_PERSONS` (500) caps the persons considered in one pass — reachable only with `favoritesOnly = false` in a circle with a very large cluster population, where the work would otherwise be `persons × years` curation passes. The ordering is deterministic (favorites first, then id) so the cut is stable across runs rather than reshuffling which persons get memories, and it logs a warning. A crash guard, not a tuning knob.

### 4.10 The Theme curator

Issue #305. "Golden Sunsets", "Beach", "Pets" — memories built from the AI auto-tagging vocabulary, and the only type whose subject is a piece of **admin-controlled configuration** rather than something the library derived on its own.

| Field | Value |
|---|---|
| `periodKey` | the calendar year `"2025"`, or `"all"` for the whole-history period |
| `subjectKey` | the tag name, **lowercased** |
| `meta` | `{ tag, year, generatorVersion }` (`year: null` for the all-history period) |
| Floor | `memories.themes.minItems` (8) curated items |
| Cap | `memories.themes.maxPerPeriod` (3) memories per period |

**Why the tag vocabulary and not CLIP clustering.** Unsupervised embedding clustering would find themes nobody named, but its output is unexplainable ("here are 40 photos that are near each other in a 512-dimensional space") and untunable. Tag themes are explainable, already computed, free, and admin-controllable — an admin who does not want "Food" memories disables that label. Epic #300 defers clustering explicitly.

**Three filters decide which tags become memories:**

1. **`media_tags.source = 'ai'`.** A manually applied tag is a filing decision, not a claim about content; a user who tagged 200 photos "Taxes" did not ask for a memory about it. The distinction exists in the schema precisely because AI and manual tag instances are governed by different rules.
2. **The label is still `enabled` in `tag_labels`.** Disabling a label is how an admin retires a concept, and a retired concept must stop producing memories without anyone hunting down what it already generated. The join is on `LOWER(name)`, so a tag whose label was deleted outright — which leaves manual `media_tags` rows behind, per `DELETE /api/tag-labels/:id` — cannot resurrect a retired theme either.
3. **`THEME_TAG_DENYLIST`** — `screenshot`, `screenshots`, `document`, `documents`, `text`, `whiteboard`. A handful of vocabulary entries describe an artifact rather than a moment. They score *well* (screenshots are sharp and often favorited for reference) and would produce genuinely bad memories. Deliberately tiny and hand-maintained rather than heuristic.

**Ranking is by distinct qualifying items, and the memory is still curated.** One grouped query returns `COUNT(DISTINCT media_item)` per `(LOWER(tag), year)` for the circle; the top `maxPerPeriod` become memories. So "the top themes" means the themes with the most material, while each memory is that theme's *best* photos — favorites-weighted, near-duplicate collapsed — not all of them.

**The all-history period is an exact sum, not an approximation.** A media item has exactly one `capturedAt` and therefore contributes to exactly one year's distinct count, so a tag's per-year counts *partition* its all-history set with no overlap to correct for. That is what lets one grouped query serve every period, and it is unit-tested directly.

**Scheduled runs do the current year only** — the only period a new upload can change, and the one a user is most likely to be shown. **Backfill** does every year with material *plus* the all-history period, which is what makes a young, thinly-spread library produce themes at all: a circle whose photos are scattered across eight years may have no single year clearing `minItems` for "Sunsets" while having plenty overall.

**Walking past a tag that falls short.** The rule is "the top N tags that produce at least `minItems` **curated** items", which cannot be evaluated without curating — a tag can clear the raw census and then fall short once near-duplicates collapse. When that happens the curator continues down the ranking rather than producing fewer memories, bounded at `maxPerPeriod × 3` attempts per period so a circle with 200 sparse tags cannot turn one period into 200 curation passes. Ties in the ranking break on tag name, so which themes exist is stable across runs over an unchanged library.

**A tombstoned theme still consumes a slot.** The user deleted *that* theme for *that* period; quietly promoting the next-ranked tag into its place would read as the delete having done nothing.

### 4.11 The Seasonal and Year-in-Review curators

Issue #305. The whole-library payoff: no subject, no clustering, no AI signal required. Everything interesting about these two is **which** date range and **when**.

| | `seasonal` | `year_in_review` |
|---|---|---|
| `periodKey` | `"2025-summer"` — year is the year the season **starts** | `"2025"` |
| `subjectKey` | `""` (unused) | `""` (unused) |
| `meta` | `{ season, seasonYear, seasonOrdinal, generatorVersion }` | `{ year, monthsCovered, generatorVersion }` |
| Floor | `memories.seasonal.minItems` (12) | `memories.yearInReview.minItems` (15) |
| Diversity | engine default | **month buckets**, no per-bucket cap |
| `expiresAt` | `NULL` | `NULL` |

Both gate on a **shared per-month census** (`curators/circle-month-counts.ts`): one `GROUP BY (year, month)` aggregate returning at most `12 × years-of-history` rows, from which a period's raw count is a range sum. A period under its floor therefore costs **no candidate scan at all**. Its `WHERE` clause is the base filter hand-written for raw SQL, and it must stay identical to `memoryCandidateBaseWhere()` — a census that counted archived items would send a curator off to curate a period that then comes back short. The integration suite asserts the two agree.

#### Seasonal

**Only completed seasons.** A "Summer 2026" memory generated in July would be a partial summer, and every subsequent generation run would rewrite it as more photos landed — churning the item set and, once [#306](https://github.com/marinoscar/MemoriaHub/issues/306) lands, re-paying for an AI title, daily, for three months. Waiting until the season has fully elapsed makes the memory stable the moment it is created. `mostRecentCompletedSeason()` owns that rule.

**The season year is the year the season STARTS.** Northern-hemisphere meteorological winter runs December Y → February Y+1, so `2025-winter` legitimately contains January 2026 photos and its `periodKey` disagrees with a naive `getUTCFullYear()` of its own contents. `seasonOf()` performs that fold once, centrally; `seasonForMonth()` in the title templates answers only "which season is month N" and knows nothing about years.

The season **ordinal** — the arithmetic that makes "the previous season" well-defined — orders seasons `spring, summer, fall, winter` *within* a season year, not alphabetically or winter-first. Winter Y begins in December Y, i.e. **after** fall Y; ordering it first would make `previousSeason(spring 2026)` return fall 2024 instead of winter 2025, silently skipping a year. This is the one piece of the file most worth its unit tests.

**Scheduled runs do exactly one season** — there is only ever one that can newly qualify between two runs — so the daily job costs one census query plus at most one curation pass. **Backfill** enumerates every completed season from the circle's oldest material forward, contiguously (a gap season is cheap: its raw count is zero and it is skipped before any query). A circle whose only photos sit inside the still-running season produces nothing, which falls out of the enumeration returning empty for an inverted range rather than needing a special case.

#### Year in Review

**Generated during December of Y and all of January Y+1.** December because the year-in-review is a December ritual and the memory has to *exist* before anyone looks for it — [#311](https://github.com/marinoscar/MemoriaHub/issues/311)'s digest and notification producers announce content generation must already have produced. All of January because "your year in review" is exactly what people go looking for over New Year, and a memory that only ever appeared for 31 days in December would be gone by the time most of the circle noticed. Outside that window a scheduled run generates nothing and does not touch the database at all.

The December half means a review **is** generated for a year with three weeks left to run, with late-December uploads landing through refresh. That is the deliberate trade: an existing-but-slightly-early memory beats a missing one, and `upsertMemory`'s Jaccard rule (§4.12) keeps the refresh from churning the title unless the additions are material. Backfill applies the same completeness rule — every past year, plus the current one only once December has arrived — so a mid-year backfill never mints a three-month "Your 2026 in review" that then churns for the rest of the year.

**Bucketed by month.** A year in review whose thirty photos all come from one two-week holiday is not a year in review. Equal-span diversity is the same thing as month bucketing *only if* the year's material is spread across it; a library with a six-month gap collapses into two dense clusters. `bucketBy: { key: monthBucket }` states the intent structurally instead. No per-bucket cap is set: with twelve buckets and a 30-item budget the round-robin already yields two to three items a month, and a year whose material is genuinely concentrated in four months should be allowed to fill its slots from those four.

`monthBucket` is **year-qualified** (`year * 12 + monthIndex`) rather than a bare 0–11 month, so January 2024 and January 2025 can never merge into one bucket if a future caller hands the policy a range wider than a year.

### 4.12 Idempotent regeneration — `upsertMemory()`

Every curator writes through this one method, keyed on `@@unique([circleId, type, periodKey, subjectKey])`.

1. **Read the existing row first.** If `deletedAt` is set, return immediately with `skippedTombstone: true` — no write, no title computation, nothing. §2.5's contract is enforced here, and it outranks every other rule in this section.
2. **Create** (row absent): `Memory` + `MemoryItem[]` in one transaction, `generatedAt = refreshedAt = now()`, `titleSource = 'template'`. A `P2002` from a concurrent pass falls through to the refresh path (re-reading, and re-checking the tombstone).
3. **Refresh** (row present and live): items are **replaced** (`deleteMany` + `createMany` in one transaction) rather than diffed — `MemoryItem` carries no per-item user state and `position` shifts on nearly every refresh, so a delta computation would be strictly more code for the same result. `itemCount`, `periodStart`/`periodEnd`, cover, `meta` and `refreshedAt` are recomputed.

**`MemoryUserState` is untouched by design.** It lives in its own table keyed by memory id, so a refresh that replaces every item preserves seen/hidden/favorited for every user. That is precisely why per-user state was not modeled as columns on `Memory` (§2.4).

**Titles survive a minor refresh.** Membership change is measured as Jaccard **distance** on the media-item id sets; below `MATERIAL_CHANGE_THRESHOLD` (30%) the `title`/`subtitle`/`narrative`/`titleSource`/`titleModel` are all left alone. Without this, one new photo joining a ten-item memory would discard an AI title (#306) and re-pay for it on every generation run forever. At or above 30% the old title may now describe a collection that no longer exists, so it is rewritten: AI re-titling runs in the same pass when it is configured (§5.6), and otherwise the row is reset to the template with `titleSource = 'template'`, `titleModel = NULL` and `narrative = NULL`.

`UpsertMemoryResult` returns `{ memoryId, created, materiallyChanged, skippedTombstone }`. `materiallyChanged` exists for [#311](https://github.com/marinoscar/MemoriaHub/issues/311)'s notification and digest producers, which need "is there anything genuinely new to tell the circle about?" without re-diffing the item set themselves.

`meta.generatorVersion` (currently `1`) is stamped centrally on every write. Bump it when scoring or selection changes in a way that would produce a different item set from identical inputs — it is the only way to tell, after the fact, which algorithm produced a given memory.

### 4.13 Registry and per-curator error isolation

Curators are injected as an array under the `MEMORY_CURATORS` token (`memoryCuratorsProvider`, which moved to its own `curators/memory-curators.provider.ts` in #304 once it imported more than one curator — a file that also *defines* a curator importing its siblings is a needless coupling and an easy way to grow an import cycle). Adding a memory type is a provider plus one entry in that factory and nothing else, which is exactly what #305 did for its five: the handler was not touched.

Order is execution order, cheapest-first: On This Day runs two bounded functional-index queries; Trips streams the circle's geo history; the people and theme curators answer a grouped census before curating anything; seasonal and year-in-review each curate one full calendar period. A job cut short by a timeout has then produced the daily content users actually see on Home. `MemoryGenerationHandler` iterates the array:

- each curator is gated by **its own** `memories.<type>.enabled` toggle, checked via `MemoryCurator.isEnabled(settings)` rather than a stringly-typed settings key on the registry entry;
- each `run()` is **individually try/caught**, and so is each `purge()`;
- the retention tail runs **even when `run()` threw** — expired rows are stale regardless of whether this pass produced new ones, and a curator whose generation is broken is exactly the one whose old rows would otherwise accumulate;
- the job **succeeds** as long as the plumbing worked, logging a structured `memory_generation.completed` summary with `created`/`refreshed`/`tombstoned`/`purged`/`failedCurators`.

This is a correctness requirement, not politeness. The seven types are independent producers of independent content: a circle with malformed geo data must still get its On This Day memories, and a single throwing curator must not burn the job's retry budget or leave six other types un-generated until a human notices a red row in `/admin/settings/jobs`.

One wall clock (`ctx.now`) is captured once by the handler and shared by every curator, so a run that straddles midnight cannot have one curator anchoring on today and the next on tomorrow.

### 4.14 Settings resolution

`resolveMemoriesSettings()` deep-merges the stored `memories.*` namespace over `DEFAULT_SYSTEM_SETTINGS.memories` **once per generation job**, so curators read `settings.onThisDay.minItems` unconditionally and never carry their own `?? 10` fallbacks. The namespace is genuinely optional on an older JSONB row — that is what makes it migration-free (§9.2) — and per-curator fallbacks would be a fourth hand-maintained copy of every default, on top of the three §9.3 already warns about.

### 4.15 Known gaps

- **A period that falls below `minItems` after items are removed keeps its existing memory.** Curators only upsert periods that still qualify; they do not delete a memory whose material has since been trashed. Its `MemoryItem` rows for hard-deleted media cascade away and `itemCount` is corrected on the next refresh, but a memory whose items were all *soft*-deleted lingers until read-time filtering ([#307](https://github.com/marinoscar/MemoriaHub/issues/307)) hides it. Deleting it automatically was rejected for v1: a curator silently destroying a memory a user may have favorited is a worse failure than a stale one.
- ~~**Backfill is unchunked.**~~ **Resolved by [#315](https://github.com/marinoscar/MemoriaHub/issues/315)** — the admin backfill now enqueues 18 bounded shards per circle (On This Day split by calendar month, one shard per other curator) rather than one job whose On This Day pass alone could reach 366 anchors × `lookbackYears`. See [§3.5](#35-the-library-backfill-and-why-it-is-sharded). The *scheduled* path is unchanged and was never at risk: it curates two anchor days.
- **Truncation is chronologically biased.** When `DEFAULT_MAX_CANDIDATES` is hit the scan keeps the earliest candidates. See §4.2 for why that is accepted as a crash guard rather than solved.
- **`person_highlights` never writes `periodKey = 'all'`,** although the `MemoryType` enum reserves it. An all-time view of a person is what `person_over_years` already is, and generating both would produce two near-identical memories for the same subject. The key shape is kept available for a future variant.
- **`themes.minItems` / `seasonal.minItems` / `yearInReview.minItems` above `maxItemsPerMemory`** can never be satisfied, since curation caps the selection first — the same un-cross-validated combination already noted for `trips.minItems` in §4.8.
- **A theme's identity is its tag name.** Renaming a `TagLabel` produces a new `subjectKey` and therefore a new memory, orphaning the old row (which is then never refreshed) rather than re-keying it in place the way a drifted trip is (§4.8). Tag renames are rare and admin-driven; the trips machinery exists because trip boundaries move on their own.
- **`MAX_ELIGIBLE_PERSONS` truncation is silent to the user.** It logs a warning and is only reachable with `favoritesOnly = false` in a circle with a very large cluster population — see §4.9.
- **Seasons are northern-hemisphere only.** `SEASON_LABELS` / `seasonForMonth` centralize the assumption (§4.6) so a hemisphere or locale setting replaces one table, but no such setting exists yet: a southern-hemisphere circle gets "Summer 2025" over its actual winter.

## 5. AI Titles, Subtitles & Narratives

Template titles (§4.6) are correct everywhere and generic everywhere. `MemoryTitleService` (`apps/api/src/memories/titles/`) upgrades them to warm, specific prose — *"Five golden days on the Pacific coast — sunsets, surf, and Camila's first time in the ocean"* — using the admin-selected `ai.features.memories` provider and model (§9.4), and degrades to the template on **any** failure.

### 5.1 The contract: `generate()` returns a title or `null`, and never throws

`MemoryTitleService.generate()` is **total**. It resolves to a `MemoryAiTitle` or to `null`, and `null` means "write the deterministic template". Every one of the following lands on `null`:

| Condition | Provider called? |
|---|---|
| `memories.aiTitles.enabled` is `false` | **no** |
| `ai.features.memories` is unset (no provider configured) | **no** |
| The selected provider has no credential, or its credential is disabled | no |
| The selected provider key is not in `AiProviderRegistry` | no |
| A backfill run has spent its call budget (§5.5) | **no** |
| An earlier call in this run was throttled (§5.5) | **no** |
| HTTP error, network failure, SDK exception | yes |
| The call exceeds the 10 s hard timeout (§5.4) | yes |
| The response is not JSON, is JSON of the wrong shape, or has an empty title (§5.3) | yes |
| A fact lookup for the prompt fails | no |

Three properties follow, and all three are stated success criteria of epic #300:

- **Titling can never fail a generation run.** There is no exception path out of `generate()`, so a curator cannot lose its job's retry budget to a cosmetic field.
- **A deployment with no AI provider is a supported configuration, not a broken one.** Every fallback logs at **DEBUG**, never `warn` or `error` — logging normal degradation as an error trains operators to ignore the log. The unit suite asserts this directly: each fallback test checks that nothing above debug was emitted.
- **`titleSource` / `titleModel` audit which path actually ran.** A row is either `('ai', '<model id>')` or `('template', NULL)`; there is no third state and no partial one, because both are written by the one `titleColumns()` helper in `MemoryCurationService`.

### 5.2 What is sent, and what is not

**Metadata only — never image bytes.** Vision-model titling from the actual pixels was rejected for v1 on cost and latency at library scale. It is also largely redundant: the tags and descriptions below were themselves produced by a vision model (§ auto-tagging), so the visual signal arrives secondhand and already paid for.

The complete list of what may leave the deployment is the `MemoryTitleFacts` type in `memory-title.prompts.ts`:

| Fact | Source |
|---|---|
| Memory type, item count | the `Memory` being written |
| Date range (`periodStart`/`periodEnd`, ISO day precision) | the curated selection |
| Place — locality, admin1, country | `meta` (Trips curator, §4.8) |
| Person names (≤ 5, subject first) | assigned faces on the selected items, excluding hidden/deleted/merged people |
| Top AI tags with counts (≤ 10) | `media_tags` with `source = 'ai'` on the selected items |
| Item descriptions (≤ 5, each truncated to 200 chars) | `MediaItem.description` |
| Years-ago / theme tag / season / year | `meta` |
| The deterministic template title and subtitle | §4.6 — the floor the model is asked to beat |

Absent **by construction**, because the builder takes facts rather than rows: media-item ids, the circle id, the person id, the user id, file names, storage keys, GPS coordinates, EXIF. A prompt-builder test asserts that a rendered prompt over a maximal fact set contains no UUID.

All four input caps are enforced **inside the builder**, not by its caller, so no call site can widen what gets sent.

### 5.3 The prompt lives in one file, and its output is snapshotted

`memory-title.prompts.ts` holds the system prompt as a single exported constant plus the per-type context builder. A prompt has no type errors and no test failures of its own, so a wording change is invisible in a diff unless the output is asserted somewhere: `memory-title.prompts.spec.ts` snapshots the rendered prompt for **all seven memory types**, which turns prompt drift into a reviewable diff.

The response contract is strict JSON — `{"title", "subtitle", "narrative"}` — with caps of **60 / 80 / 240** characters. Those caps are stated in the system prompt *and* enforced on parse, from the same three constants, so the two can never disagree.

`parseMemoryTitleResponse()` (`memory-title.parse.ts`) is likewise total: it strips a ``` / ```json fence, slices from the first `{` to the last `}` (which removes a chatty preamble and a sign-off in one step), `JSON.parse`s in a try/catch, validates with zod, normalizes an empty or `null` subtitle/narrative to `NULL`, and hard-caps every field with an ellipsis. A missing, non-string or blank **title** fails the whole parse — a memory with no title is not a partial success, it is the template case. Unknown extra keys are ignored rather than rejected: strictness there would turn a usable answer into a fallback for no benefit.

### 5.4 The hard timeout bounds the whole stream

The provider is called through the existing `AiProvider.chat()` abstraction — the same streaming chat path agentic search uses — not a second HTTP client.

`MEMORY_TITLE_TIMEOUT_MS` is **10 000 ms**, and it bounds the *whole* stream rather than each chunk: each `next()` is raced against the **remaining** budget, so a provider dribbling one token every nine seconds is caught just as a silent one is. On timeout the iterator's `return()` is invoked fire-and-forget — awaiting it would re-block on the very network call that just stalled — so the generator can release its connection. A `MAX_RESPONSE_CHARS` ceiling (8 000) additionally stops a model stuck in a repetition loop from growing an unbounded string inside a memory-sensitive worker.

`MEMORY_TITLE_TEMPERATURE` is `0.7`. Carrying it required adding an **optional** `temperature` to `ChatRequest`, forwarded verbatim by both providers and omitted entirely when unset — so no existing caller's behavior changed.

### 5.5 The run budget: one per job, shared by every curator

`MemoryTitleRun` is a small mutable object created once per `memory_generation` job by `MemoryGenerationHandler.beginRun()`, carried on `MemoryCuratorContext.titling`, and forwarded verbatim by each of the seven curators as `titling: ctx.titling` on their `upsertMemory` call.

**Why a passed object rather than service state.** `MemoryTitleService` is a Nest singleton and the enrichment worker can run several `memory_generation` jobs concurrently (`ENRICHMENT_WORKER_CONCURRENCY`). A mutable field on the service would let one circle's rate-limit trip silently template another circle's memories, and one circle's backfill would consume another's budget.

**An absent run means template titles.** That default is deliberately fail-safe: a curator (or a test) that does not thread it degrades to the documented floor rather than making unbudgeted, uncapped model calls.

The run carries two independent stop conditions:

- **Rate limiting stops the run; it does not fail the job.** A `429` or `529` (Anthropic "Overloaded") — classified by the shared `classifyRateLimit()` — sets `stopped`/`stopReason = 'rate_limited'`, and every remaining memory in the job is templated with no further calls. Routing this through the enrichment rate-limit-deferral path was explicitly rejected: that would defer a whole generation job, whose real output is the memories, over a cosmetic field.
- **Backfill is capped at `BACKFILL_AI_TITLE_CAP` = 100 calls per job.** A 70k-item library backfill can create thousands of memories in one unattended run; without the cap it would fire thousands of model calls at once. Beyond the cap everything is templated, and each later scheduled run gets a fresh budget, so the library converges instead of billing for itself all at once. Scheduled (non-backfill) runs are uncapped — they produce few memories by construction (typically < 20).

`attempts` are charged **before** the call, so a timing-out or 500-ing provider consumes budget too; otherwise a persistently failing provider would retry uncapped. The job's `memory_generation.completed` log line reports `aiTitleCalls` and `aiTitleStopReason`, which is the one-line explanation for a run whose memories are mostly template-titled despite a configured provider.

### 5.6 Where titling is called from

`MemoryCurationService.upsertMemory()` — the single write path every curator funnels through (§4.12) — and only on the two branches that **reset** titling:

1. **Create.** A new memory is titled on the spot.
2. **A refresh that resets the title:** membership moved by at least `MATERIAL_CHANGE_THRESHOLD` (30% Jaccard distance), or the curator set `retitle` because the memory's *subject* drifted (the Trips re-keying case, §4.8).

A **minor** refresh calls nothing and keeps whatever the row already carries, including an existing AI title and narrative. That anti-churn rule is what makes the cost story work: without it, one new photo joining a ten-item memory would discard an AI title and re-pay for it on every generation run forever.

Two ordering properties matter and are both tested:

- **The tombstone check comes first.** A user-deleted memory is not re-titled — no model call is made at all.
- **The model call happens outside the write transaction.** A 10-second call inside `$transaction` would hold row locks and a pool connection for its whole duration. Every fact the prompt needs comes from the selection the curator already computed, so titling completes before the transaction opens.

When a call succeeds but the model returned no subtitle, the **template's** subtitle is written rather than leaving the card bare; the narrative stays `NULL`, since it is an AI-only field. When a *re-title* fails on a memory that previously had an AI title, all five columns are reset together — leaving `titleModel` or `narrative` behind would attach a model id and a blurb to a title that model never wrote.

### 5.7 Testing

No test in this feature can reach a network. The service suite drives a hand-written `AiProvider` double returned by a stubbed `AiProviderRegistry`, which is a level below the repo's `jest.mock('openai')` convention and strictly stronger — a mocked SDK still requires the production code to route through it, whereas here there is no SDK in the graph at all.

| Suite | Covers |
|---|---|
| `memory-title.prompts.spec.ts` | per-type prompt snapshots, the four input caps, the no-UUID privacy assertion, cap constants echoed in the system prompt |
| `memory-title.parse.spec.ts` | fences, preambles, truncated/array/wrong-type/blank-title JSON, length capping, "never throws" over every malformed shape |
| `memory-title.service.spec.ts` | every row of §5.1's table, the 429/529 stop-the-run behavior, the backfill cap, and that each fallback logs at debug only |
| `memory-generation.handler.spec.ts` | one budget per job, shared by every curator; the `aiTitles.enabled` flag and the backfill flag reaching `beginRun` |
| `test/memories/memories-ai-titles.integration.spec.ts` (DB-gated) | the five persisted title columns for success and failure, anti-churn preservation, material-change re-titling, a failed re-title clearing a stale `titleModel`, `retitle`, and the tombstone short-circuit |

### 5.8 Known gaps

- **A reasoning model that rejects an explicit temperature degrades silently.** Some newer OpenAI models accept only their default temperature and answer `400`. That is a clean fallback to templates rather than an outage, but an admin who selects such a model gets template titles with only a debug log to explain it. The Doctor sweep does not yet include an `ai.memories` check.
- **A failed titling attempt is not retried until the memory changes materially again.** The anti-churn rule (§5.6) is membership-based and does not know *why* a row is template-titled, so a memory templated because the provider was down stays templated until its item set moves by 30%. Retrying template-titled rows on a later run was rejected for v1: it would re-call for every memory on a deployment with no provider configured, which is exactly the case the whole degradation story exists to make free.
- **The backfill cap is per job, not per library.** A backfill re-run gets a fresh 100 calls. That is intended (it is how a large library converges over several runs), but it means the cap bounds a single unattended run's cost, not the total cost of repeatedly backfilling.
- **No response cache.** The rendered prompt is deterministic, so identical facts would key a cache exactly — but memories are titled once and then protected by the anti-churn rule, so there is little to hit.
- **English only.** The system prompt and the template floor are both English; there is no locale setting to hand the model.

## 6. API

Introduced by issue [#307](https://github.com/marinoscar/MemoriaHub/issues/307). Everything lives in `apps/api/src/memories/api/` — `MemoriesController`, `MemoriesService`, the query/response DTOs, and `memory-preferences.ts` (the read-time preference compiler). The module edges this adds are `MemoriesModule → CirclesModule` (per-circle role checks) and `MemoriesModule → MediaModule` (batched thumbnail signing plus the album service that save-as-album reuses); neither points back, so there is no cycle and no `forwardRef`.

### 6.1 Endpoint catalogue

| Method & path | Permission + circle role | Behavior |
|---|---|---|
| `GET /api/memories?circleId=&type=&year=&favorite=&cursor=&pageSize=` | `media:read` + **viewer** | Keyset page of memory cards, `(generatedAt DESC, id DESC)`, no `COUNT(*)` |
| `GET /api/memories/feed?circleId=` | `media:read` + **viewer** | Home carousel: today's `on_this_day` first, then newest unseen, then newest seen; hard cap 10 |
| `GET /api/memories/:id` | `media:read` + **viewer** | Full detail + `narrative` + the ordered item list |
| `POST /api/memories/:id/seen` | `media:read` + **viewer** | Idempotent `seenAt` — 204 |
| `POST` / `DELETE /api/memories/:id/hide` | `media:read` + **viewer** | Per-user hide / un-hide — 204 |
| `POST` / `DELETE /api/memories/:id/favorite` | `media:read` + **viewer** | Per-user favorite / un-favorite — 204 |
| `POST /api/memories/:id/save-album` | `media:write` + **collaborator** | Creates an album from the memory's items — `201 { albumId }` |
| `DELETE /api/memories/:id` | `media:write` + **collaborator** | Circle-level tombstone (§2.5) + a `memory:deleted` audit event — 204 |

`POST /api/admin/memories/backfill` (Admin + `system_settings:write`) belongs to this API map but lives in `AdminMemoriesController`, not this controller — it is an administration action over the generation pipeline rather than a circle-scoped read. See [§3.5](#35-the-library-backfill-and-why-it-is-sharded).

Per-user preferences are **not** endpoints of this controller at all — see §6.7.

### 6.2 Three invariants every read obeys

Stated once here because they are asserted in every method of `MemoriesService` and are the things a future change is most likely to break.

**The tombstone.** `deletedAt IS NOT NULL` is excluded from *every* read without exception — list, feed, detail, and the `:id` lookup behind every state write and every mutation. Prisma has no global scope (§2.5), so this is application discipline; in this service it is centralised in one `activeWhere()` helper plus the identical predicate inside `loadAccessibleMemory()`, so there are exactly two places to audit rather than nine.

**The active filter.** `expiresAt IS NULL OR expiresAt > now()`. Only `on_this_day` sets an expiry (start of the day after its anchor, §4.7), so this is what retires yesterday's "6 years ago" card. It applies to detail as well as to the lists: an expired anchor-day memory is genuinely over, and the `on_this_day` retention tail hard-deletes it shortly afterwards anyway, so serving it from a stale link would only produce a card that vanishes moments later.

**Per-user hide is a different thing from the tombstone, and is deliberately not conflated with it.** `MemoryUserState.hiddenAt` is personal and reversible: the memory stays visible to every other member, and it stays reachable *by its own id* for the user who hid it (so the detail page can offer "un-hide"). Only the circle-level tombstone removes it for everyone, and only that is permanent.

### 6.3 The feature flag is checked BEFORE any query

With `features.memories` off — the default — `GET /api/memories` returns `{ items: [], meta: { pageSize, nextCursor: null, hasMore: false } }`, `GET /api/memories/feed` returns `{ items: [] }`, and every `:id` route returns **404**. Not an error, not a 403: a disabled feature is invisible, not broken, so a client that has not yet been taught about the flag degrades to an empty surface rather than an error toast.

The gate runs as the *first statement* of every handler, ahead of the circle-access check. That ordering is the point: "no cron work, no jobs, no nav entry, endpoints return empty — **zero cost**" is a stated epic success criterion, and checking membership first would already have cost two queries per request on a deployment that has the feature switched off. The only work a gated-off request performs is the cached `SystemSettingsService.getSettings()` read (5 s TTL, usually a cache hit). It resolves through the shared `isMemoriesEnabled()` helper, which folds in the `MEMORIES_ENABLED` env kill-switch, so this surface can never disagree with the generation cron about what "enabled" means (§9.1).

A side effect worth naming: while the flag is off, a non-member also gets an empty list rather than a 403. That is strictly less information disclosure, not more.

### 6.4 `GET /api/memories` — keyset, and why the cursor comes from the raw page

Keyset only. There is deliberately **no** `page` escape hatch of the kind `GET /api/media` carries: that endpoint's offset mode exists purely for legacy clients (the Android app, the CLI) that predate keyset, and nothing has ever consumed memories, so neither the dual-mode branch nor its `COUNT(*)` is inherited. Ordering is `(generatedAt DESC, id DESC)`; the `id` tiebreak is not decorative — one generation run writes a whole batch of rows with near-identical `generatedAt`, so without it the keyset would be non-deterministic exactly where it is used most.

Filters:

- `type` — a `MemoryType` value, passed straight through.
- `year` — **not a column**: a memory covers a *range*, so this compiles to an overlap test against that UTC calendar year (`periodStart < Jan 1 of year+1 AND periodEnd >= Jan 1 of year`). A trip spanning New Year's Eve therefore appears under both years, which is what a user filtering "2023" expects of a photo taken on 2023‑12‑31.
- `favorite=true` — narrows to the caller's own favorites via `userStates: { some: { userId, favoritedAt: { not: null } } }`.

Per-user hidden rows are excluded **in SQL** (`NOT: { userStates: { some: { userId, hiddenAt: { not: null } } } }`), so a user who has hidden a lot still gets full pages.

The preference filter (§6.7) cannot be, and runs in memory over the fetched page. That creates one subtle trap, which the implementation avoids explicitly: **`nextCursor` and `hasMore` are derived from the RAW page, before preference filtering.** Deriving them from the filtered list would make a page whose every row was preference-hidden report `nextCursor: null`, silently truncating the browsable history at the first fully-hidden page. The visible consequence is that a page may return fewer than `pageSize` items while still reporting `hasMore: true` — correct, and the standard behaviour of any post-filtered keyset.

Card DTO: `{ id, type, title, subtitle, itemCount, periodStart, periodEnd, coverMediaItemId, coverThumbnailUrl, meta, myState: { seen, favorited }, generatedAt }`. `myState` on a *card* carries no `hidden`, because it would be a constant `false` there — hidden rows never reach a list. Detail's `myState` adds it.

### 6.5 `GET /api/memories/feed`

Ordering is: today's `on_this_day` memories with the **closest year first** ("1 year ago" before "9 years ago"), then the newest unseen, then the newest seen, capped at 10.

Two bounded reads rather than one, for two independent reasons. Today's anchor memories must appear *even when they are not among the newest rows overall* — a backfill can generate a pile of trips after them — so they cannot be found by taking the newest N. And ranking them needs `meta.yearsAgo`, a JSONB field that SQL would sort badly and an in-memory sort handles trivially. `periodKey` for an `on_this_day` memory *is* the anchor day in UTC (`toIsoDateKey`, §4.7), so "today's" is an exact string match, not a range scan. The second query excludes that same `(type, periodKey)` pair so a memory can never appear twice in one feed.

The non-anchor read takes `FEED_CANDIDATE_LIMIT = 60` rather than 10: hidden rows are already gone in SQL, but the preference filter runs afterwards in memory, so a user with several hidden people would otherwise get a short feed. Still one bounded read, no second round-trip.

Feed cards extend the list card with `itemThumbnailUrls` — up to the first four items by `position`, for the fan effect behind the cover.

### 6.6 `GET /api/memories/:id`

Applies the tombstone and active filters (§6.2) but **not** the per-user preference filter and **not** the per-user hide: a direct link — from the story player, a notification, the email digest, or the user's own hidden list — must resolve. Hiding and deleting are the tools on that page, and both are offered there.

A memory whose circle the caller does not belong to returns **404, not 403**, so a stranger cannot use the status code to confirm that a memory id exists. This is the same enumeration-resistant policy as the notifications `:id` routes and public shares. A *member* who merely lacks the rank — a viewer attempting a delete — does get a 403, because their membership is not a secret and the distinction is actionable to them. The whole rule lives in one helper, `MemoriesService.loadAccessibleMemory(id, userId, permissions, requiredRole)`, which deliberately does **not** call `assertCircleAccess` (that one throws 403 for a non-member, which is exactly the leak being avoided) but does reproduce its super-admin bypass.

Item DTO: `{ id, mediaItemId, position, mediaType, width, height, durationMs, capturedAt, thumbnailUrl }`, ordered by `position`. There is no item pagination: a memory holds at most `memories.maxItemsPerMemory` (bounded 5–100) rows.

### 6.7 Per-user preferences — the `user_settings.memories` namespace

Read and written **only** through the existing `GET`/`PATCH`/`PUT /api/user-settings`. No new endpoint, no new table, no migration, no new permission — the same model as `user_settings.dataTables` (#255) and `user_settings.notifications` (#251), and the canonical schema sits beside theirs in `apps/api/src/common/schemas/settings.schema.ts`.

```
memories: {
  hiddenPersonIds:   string uuid[]                         (<= 200),
  hiddenDateRanges:  [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }]  (<= 50, from <= to),
  emailDigestOptOut: boolean,
}
```

**Absent means default**, and that rule is load-bearing exactly as it is for the other two namespaces: every field is `.optional()` with **no** `.default()` anywhere, and nothing is ever populated server-side. An absent namespace / field means "no preference" — nobody hidden, no date sensitive, digest not opted out. That is what lets the namespace ship with no data migration (every existing row simply has no namespace), and it makes any field added here later opt-**in** rather than silently applied to everyone who once saved a preference. A `.default([])` on `hiddenPersonIds` would pin a stored blob to "nothing hidden" and make it indistinguishable from "never expressed a preference".

Both date bounds are validated as **real calendar days**, not just `\d{4}-\d{2}-\d{2}`: the regex alone accepts `2026-02-31`, and a bound that silently rolled into the next month would filter days the user never named.

PATCH merges **field-wise**, one level deep (`UserSettingsService.mergeMemories`, shaped exactly like `mergeNotifications`): an unlisted field is untouched, a listed field is **replaced wholesale**, a field set to `null` is deleted (resetting it to its absent default rather than pinning `[]` / `false`), and `memories: null` clears the namespace. An emptied namespace collapses back to `undefined`, because the absent namespace *is* the canonical "nothing persisted" state and storing `{}` would only be noise. The lists are replace-not-append deliberately: "hide this person" and "un-hide this person" are the same PATCH from the client's point of view, and an append-only merge would leave removal inexpressible.

**Read-time filtering** applies to `GET /api/memories` and `GET /api/memories/feed`, in memory, after the page is fetched — both rules are cheap column comparisons over at most 60 rows:

- **hidden person** — drop memories whose `personId` is listed;
- **sensitive dates** — drop memories whose `[periodStart, periodEnd]` **overlaps** any hidden range. Overlap, not containment: a trip that merely crosses a hidden anniversary is precisely the case the user is trying not to be shown. A range is inclusive of both endpoints, so `to` is expanded to the following UTC midnight and compared half-open.

`resolveMemoryPreferences()` compiles the stored blob once per request into a `Set` of ids plus millisecond intervals, so a page of 20 rows does not re-parse the same date strings 20 times. It is deliberately defensive: the schema validates on *write*, but an older or hand-edited JSONB blob can hold anything, and a malformed preference degrades to "no filter" with a logged warning rather than 500-ing a browse page. A failed settings read degrades the same way — over-showing beats an error on a browse surface.

Filtering is read-time and **never** a generation input. Generation is circle-scoped: one `Memory` row is shared by every member, so a personal preference cannot influence what gets curated without leaking one member's preferences into another member's feed. That is why the People curators ignore this namespace entirely (§4.9).

**V1 limitation (from the epic, deliberate):** a memory is dropped **whole**. A hidden person removes the `person_highlights` / `person_over_years` memories keyed to them, but a trip or theme memory that merely *contains* that person among several faces is **not** scrubbed at the item level. Item-level scrubbing is listed in §11.

`emailDigestOptOut` is stored and validated here; it is consumed by the digest's per-recipient send ([§7.5](#75-per-recipient-rendering)) and set without a login by the tokenized unsubscribe route ([§7.8](#78-the-public-routes)).

### 6.8 Per-user state writes

`POST /:id/seen`, `POST`/`DELETE /:id/hide`, `POST`/`DELETE /:id/favorite` — all 204, all scoped to the JWT's `userId`, all requiring circle membership only.

Setting a timestamp is `COALESCE(field, now())`: re-running never moves an existing value, so `seenAt` always names the **first** view — the same idempotency contract as `POST /api/notifications/:id/read`. In Prisma that costs two statements, and both are needed: the `upsert` covers "no state row yet", and a guarded `updateMany ... WHERE field IS NULL` covers "a row already exists because the user favorited it earlier, but *this* column is still null".

Clearing is `updateMany` and never an upsert: un-hiding a memory the user never hid is a no-op, and creating an all-null state row to record that nothing happened would be pure garbage.

### 6.9 `DELETE /api/memories/:id` — the tombstone write

Sets `deletedAt = now()`. The memory disappears for **every** member, and permanently: because `@@unique([circleId, type, periodKey, subjectKey])` spans tombstoned rows (§2.5), the next generation run's `upsertMemory` finds the tombstone and skips that natural key instead of resurrecting or duplicating it. The underlying photos are untouched — delete removes the curated collection, never the media.

Writes an `audit_events` row (`action: 'memory:deleted'`, `targetType: 'memory'`) carrying the circle, type, natural key and title, so a "why did that memory vanish" question is answerable after the fact.

Requires `media:write` + **collaborator**, the same bar as any other mutation of circle content. A viewer who simply wants it out of their own way has `POST /:id/hide`. A repeat delete returns 404, since the first one made the row invisible to every read — including this route's own lookup.

### 6.10 `POST /api/memories/:id/save-album`

Body `{ name? }`; omitted means "use the memory's title" (truncated to the 256-char album-name cap). Returns `201 { albumId }`.

Every mutation goes through the **existing** album service path — `MediaService.createAlbum` → `addAlbumItems` → `updateAlbum` for the cover — rather than writing `Album`/`AlbumItem` rows directly. That is deliberate: it inherits their circle checks, their `MediaTouchService` backup-feed bookkeeping (issue #310) and their cover-membership validation for free, and it cannot drift from them. Items are added in the memory's `position` order, which `addAlbumItems`' sequential inserts preserve as `addedAt` order — the order `GET /api/media/albums/:id` reads them back in.

Two details worth stating:

- **Soft-deleted items are dropped first.** `addAlbumItems` rejects the *whole* batch if any id is trashed, so a memory generated before one of its photos was trashed would otherwise be permanently unsaveable. The same check governs the cover: a trashed cover is simply not carried over rather than 400-ing the save.
- **Not idempotent, by design** (per #307): saving the same memory twice yields two albums, because a user may genuinely want a second copy to edit.

This is also how v1 *shares* a memory: save it as an album, then use the existing album share flow. A native memory share target is explicitly deferred (§11).

### 6.11 Thumbnail signing

Every payload that carries a thumbnail — list cards, feed cards (cover **plus** up to four item thumbnails each), and detail (cover plus every item) — is signed through `MediaThumbnailService.signThumbsBatched`, in **one** call per response covering every key at once. That means a single `storageObject.findMany`, each distinct `(provider, bucket)` resolved once, and each distinct key signed once.

This is a hard repo rule, not a preference: the per-item `findUnique`-per-thumbnail pattern is exactly the N+1 that caused multi-second loads and 502s on large circles, documented in `docs/audits/search-audit.md`. The feed is the most exposed surface here — ten cards times five thumbnails is fifty keys — which is why the fan's item thumbnails are folded into the same batched call as the covers rather than signed per card.

### 6.12 Serialization

Every timestamp is emitted as an ISO 8601 **string**, and no payload in this API contains a `BigInt` (the repo's `JSON.stringify` gotcha): the only `BigInt` column anywhere near this feature is `storage_objects.size`, which nothing here selects, and `MediaItem.durationMs` is a plain `Int?`.

Handler return values are wrapped by the global `TransformInterceptor`, so a list's own pagination meta lands at `data.meta` — the same shape `GET /api/media` and `GET /api/notifications` already produce.

### 6.13 Known gaps

- **Preference filtering shortens pages.** Because it runs after the fetch (as specified by #307), a page can return fewer than `pageSize` items. Pushing `hiddenPersonIds` into the SQL `WHERE` as `personId: { notIn }` would fix it for the person rule; the date-range rule would still need the in-memory pass, so the asymmetry was not worth two filtering paths in v1.
- **No item-level scrubbing** of hidden people inside mixed memories (§6.7, §11).
- **`emailDigestOptOut`** is consumed by the email digest ([§7.5](#75-per-recipient-rendering)), which reuses this section's `resolveMemoryPreferences` / `isMemoryHiddenByPreferences` helpers rather than reimplementing them. The in-app toggle that flips it back on is [§8.17](#817-the-preferences-ui-and-the-absent-key-contract-it-must-not-break).
- **Expired memories 404 on detail.** A user who opens an `on_this_day` story a minute before midnight will find the link dead a minute later. The alternative — serving expired memories by id — was rejected because the `on_this_day` retention tail hard-deletes them shortly afterwards anyway, so the link would break regardless, just less predictably.
- **No cross-circle "all my memories" view.** Every read is scoped to one `circleId`, matching the rest of the media surface.

## 7. Notification Center Integration & Email Digest

Introduced by issue [#311](https://github.com/marinoscar/MemoriaHub/issues/311). Two delivery channels for the same underlying fact — *new memories exist* — with deliberately different volume guards, audiences and failure modes: the in-app **bell** (§7.1) and the **email digest** (§7.2 onward).

Both are **best-effort**. A failed notification write and a failed email send are logged and counted; neither ever throws into, blocks, or rolls back the thing that triggered it. That is the same contract the circle-invitation / membership-confirmation sends and every notification producer already follow.

### 7.1 The `memories_ready` notification

| | |
|---|---|
| **Enum value** | `memories_ready`, added to `NotificationType` in its own migration (`20260810000000_add_memories_ready_notification_type`) — Postgres cannot add an enum value in the same transaction as statements using it; precedent `20260705000000_add_media_tag_source_system` |
| **Primitive** | `upsertCountedEvent()` — a counted **EVENT**, not a **STATE** row |
| **Window** | 24 h rolling, anchored on `updated_at` |
| **Partition** | `matchData: { circleId }` |
| **Producer** | `MemoriesNotificationService` (`apps/api/src/memories/notifications/`) |
| **Audience** | Every circle member, every per-circle role |
| **Title / body / link** | `"{count} new memor{y\|ies} in {circle}"` / the run's top memory title / `/memories` |
| **Preference** | Automatic — `notificationTypeKeySchema` derives from the live enum; absent ⇒ enabled |

**Why counted-event and not state.** Memories arrive in *batches*: one generation pass routinely creates six or more (a year of On This Day anchors, several trips, a theme), and an admin backfill creates dozens. `emit()` would append one row per memory — exactly the fan-out the notification design exists to prevent — and a member of three circles would find their bell buried after a single backfill. `upsertCountedEvent()` folds every creation in the window into ONE row whose `data.count` grows: "6 new memories in Familia" becomes "31 new memories in Familia" after the backfill, still one row.

It is deliberately **not** `upsertState()`. A state row would require widening the raw-SQL partial unique index `notifications_review_queue_live_uniq_idx`, whose predicate lists only the four `review_queue_*` values — but more importantly the semantics are wrong: "N new memories arrived" counts things that *happened*, not the current depth of a queue the user drains. There is no number that falls back to zero when the user acts, which is the property that makes a STATE row a STATE row.

**Audience rationale.** Every member regardless of role, because browsing memories needs no write access — a `viewer` genuinely can act on this. Same reasoning as `upload_completed`, and deliberately unlike #246's collaborator-only review-queue audience, where resolving a group *does* need write access.

**Only creations notify.** `MemoryGenerationHandler` calls `recordGeneratedAsync()` only when the run's `created` count is greater than zero. A refresh-only pass resurfaces nothing new, and a bell row that says so every day is how a user learns to ignore the bell.

**Module placement — the constraint that decided it.** `NotificationsModule` imports **nothing**, and that is load-bearing for the acyclicity of the module graph. The producer needs circle-membership lookups, so it lives in **`MemoriesModule`**, which imports `NotificationsModule` — an edge pointing *into* notifications exactly like `MediaModule`'s and `WorkflowsModule`'s. No cycle is closed and no `forwardRef` is needed. (This is the same reasoning that put #246's review-queue reconcile in the separate `NotificationsReconcileModule`.)

**Web.** `memories_ready` is registered in `apps/web/src/components/notifications/notificationMeta.tsx` (icon `AutoAwesome`, positive tone) and `apps/web/src/types/notifications.ts`; the per-type toggle appears in `NotificationSettings.tsx` automatically, since that list is derived from the type map.

### 7.2 Digest architecture

```
MemoryDigestTask  (hourly @Cron)
      │  gates 1–8, per circle
      ▼
enrichment_jobs row  type='memory_digest', circleId, priority 100, skipDedup
      ▼
MemoryDigestHandler  (server-only)
      ▼
MemoryDigestService.sendForCircle()
      │  per recipient: preferences → filter → render → send
      ▼
EmailService.sendEmail('memory-digest', …)   →  SES | SMTP
```

| File | Role |
|---|---|
| `apps/api/src/memories/digest/memory-digest.task.ts` | Hourly cron; picks due circles, enqueues one job each |
| `apps/api/src/memories/digest/memory-digest.service.ts` | The gate stack, the watermark/candidate queries, and the per-recipient send |
| `apps/api/src/memories/digest/memory-digest.handler.ts` | `memory_digest` enrichment handler |
| `apps/api/src/memories/digest/digest-token.util.ts` | HMAC sign/verify for the image and unsubscribe capabilities |
| `apps/api/src/memories/digest/public-memory-digest.controller.ts` | The three `@Public()` routes |
| `apps/api/src/memories/digest/unsubscribe-page.ts` | The two standalone HTML pages |
| `apps/api/src/email/templates/memory-digest.email.ts` | The email itself |

**Why the send is a job and not in-process work.** `ShareExpiringTask` and #246's reconcile do their work in process, because both are bounded local SQL that cannot fail transiently. Sending is the one part of this feature that talks to a third party, so it is the part that genuinely *does* fail transiently. Being an `enrichment_jobs` row gives it the queue's retry budget, makes a stuck send visible in `/admin/settings/jobs`, and bounds a broken provider to `ENRICHMENT_MAX_ATTEMPTS` rather than an hourly silent failure nobody sees.

**Server-only, by omission.** `MemoryDigestHandler` defines no `nodeResultSchema` / `persistNodeResult` pair, so `EnrichmentHandlerRegistry.serverOnlyTypes()` infers the type and it becomes eligible for the `ENRICHMENT_WORKER_MODE=system` claim set with no explicit pinning — the same inference that covers `memory_generation`, `face_auto_archive_sweep` and the `location_inference` sweep. It is correspondingly absent from the CLI's `NODE_JOB_TYPES`. A node holds neither the email credential nor the `SECRETS_ENCRYPTION_KEY`-derived signing key, and there is no per-item unit of work to hand it.

**Why `skipDedup: true` is mandatory** — identical to §3.2's reasoning for `memory_generation`: `EnrichmentJobService`'s default dedup keys on `(type, mediaItemId)`, and for a global job `mediaItemId` is NULL for *every* circle, so the first circle's pending job would swallow the enqueue for the whole deployment. The task's own per-circle pending/running check is the correctly-scoped replacement.

### 7.3 The gate stack

Evaluated in this order, cheapest first. Gates 1–5 are deployment-wide and read **once per sweep** through the cached `getSettings()`; gates 6–8 are per circle.

| # | Gate | Where | Effect when closed |
|---|---|---|---|
| 1 | `MEMORIES_ENABLED !== 'false'` | task | Cron returns before any settings read |
| 2 | `features.memories` | `evaluateGlobalGate` | `reason: 'feature_disabled'` — no circle paging at all |
| 3 | `memories.digest.enabled` | `evaluateGlobalGate` | `reason: 'digest_disabled'` — the admin global kill |
| 4 | `memories.digest.frequency !== 'off'` | `evaluateGlobalGate` | `reason: 'frequency_off'` |
| 5 | `email.enabled && email.provider && email.fromAddress` | `evaluateGlobalGate` | `reason: 'email_unconfigured'` |
| 6 | `now.getUTCHours() >= memories.digest.sendHourUtc` | task | `gate: 'before_send_hour'` |
| 7 | Last **succeeded** `memory_digest` job older than the frequency window | task | circle counted as `skipped` |
| 8 | **≥ 1 memory created or refreshed since that watermark** | task **and** handler | circle counted as `skipped` / run `skippedReason: 'no_new_content'` |

**Zero cost when off** is a stated epic success criterion, not a nicety. With `features.memories` off — the default — an hourly tick costs exactly one *cached* settings read and returns: no circle paging, no job rows, no mail. The same holds when the admin has killed the digest, set `frequency: 'off'`, or simply never configured email; gate 5 is what makes "email not configured ⇒ the digest task no-ops and in-app memories are unaffected" true at the *cron* level rather than only at the send, so a deployment with no SMTP does not queue a job per circle per period forever.

**Gate 8 is the hard one.** The epic states it absolutely: **no new content ⇒ no email, ever**. A weekly digest that arrives every week saying nothing happened is the fastest way to train a family to filter the sender. It is enforced **twice** — in the task before enqueueing, so a quiet circle costs one bounded `SELECT` instead of a job row plus a worker slot plus a red-herring entry in the job dashboard; and again in the handler, because the two happen minutes apart, a memory can be tombstoned in between, and a job can be hand-retried from `/admin/settings/jobs` long afterwards.

**The one-tick tolerance.** The frequency window is `FREQUENCY_HOURS[frequency] − 1h` (`daily` 24, `weekly` 168, `monthly` 720). Without the subtraction the digest drifts an hour later every period: a run that finished at 08:00:30 is not yet 24 h old when the next day's 08:00:10 tick evaluates it, so it slips to 09:00, then 10:00. One cron period of slack pins the send to its intended hour, and it cannot cause a double-send because the send-hour gate already admits at most one qualifying window per day *and* gate 8 requires new content the previous send consumed.

### 7.4 The watermark is the job row

Nothing is persisted to record "a digest was sent". The **`finishedAt` of the most recent succeeded `memory_digest` job for the circle** *is* the watermark, read by `MemoryDigestService.lastDigestAt()`. The currently-running job is `running`, not `succeeded`, so it can never be its own watermark — which is what lets the handler re-derive exactly the boundary the task used with no state threaded through the job payload.

This is also why the handler **succeeds on a partial send**: a failed row is not a watermark, so a retry would re-mail everyone the first pass already reached. There is no per-recipient checkpoint, and duplicate mail is worse than a missed one. Per-recipient failures are counted in the completion log line (`sent` / `failed` / `skippedOptOut` / `skippedEmpty` / `skippedNoEmail`); only an infrastructure error — the circle read itself failing — escapes and fails the job so the queue retries it.

"New content" means **created OR materially refreshed** (`generatedAt > watermark OR refreshedAt > watermark`), restricted to live, non-expired rows (`deletedAt IS NULL` and `expiresAt IS NULL OR expiresAt > now()`). A trip that grew from 40 photos to 120 because the user finally uploaded the rest of the holiday is genuinely worth resurfacing, and `refreshedAt` is the only signal for it. A first-ever digest has no watermark and takes the circle's newest memories outright.

### 7.5 Per-recipient rendering

One broadcast email per circle would be cheaper and is **wrong**: each member has their own `user_settings.memories` preferences (hidden people, sensitive date ranges) and their own `emailDigestOptOut`. Those are read-time filters (§6.7), so the only way to honour them is to build the list per recipient.

The digest is #307's **first consumer** of `emailDigestOptOut`, and it reuses #307's `resolveMemoryPreferences()` / `isMemoryHiddenByPreferences()` from `apps/api/src/memories/api/memory-preferences.ts` rather than reimplementing them — a second copy of the date-range overlap arithmetic is exactly the drift this epic keeps warning about.

Per recipient, in order:

1. **No email address** → `skippedNoEmail`.
2. **`emailDigestOptOut === true`** → `skippedOptOut`. Never mailed, full stop.
3. **Filter** the shared candidate pool through their preferences, then take the top `DIGEST_MEMORY_LIMIT` (5 — one hero plus four cards, matching the template exactly; a sixth would silently vanish).
4. **Empty after filtering** → `skippedEmpty`. An email that shows them nothing is worse than silence.
5. Otherwise render and send.

The candidate pool is loaded **once for the circle** (`DIGEST_CANDIDATE_LIMIT` = 25, deliberately larger than the 5 rendered so a member with several hidden people still gets a full email rather than a short one), and preferences are read for the whole membership in **one** `userSettings.findMany` — the same batching #246's reconcile does. Image tokens are minted once per circle too, since a token is a capability over the *media item*, not over the reader; only the unsubscribe URL is per recipient.

Ordering puts **`on_this_day` first** regardless of `generatedAt` — it is the one type anchored to today, so it is both the most likely thing the reader wants and the strongest subject line. The sort runs in memory over an already-bounded page rather than as a SQL `CASE`, since the index serving the query orders by `generatedAt`.

A preference read that fails resolves to "no preference" with a logged warning: over-showing beats failing a send.

### 7.6 The email

`apps/api/src/email/templates/memory-digest.email.ts`, registered in the typed `TEMPLATES` map as `memory-digest`.

**Outlook for Windows is the binding constraint.** It renders through the Word HTML engine: no flexbox, no grid, no `max-width` on a `div`, no reliable `background-image`, no `border-radius`. Everything about the template follows from that, and `memory-digest.email.spec.ts` pins each rule so a future edit that "looks fine in Gmail" cannot ship silently:

- **Tables for layout**, never divs — nested `<table role="presentation">` with explicit pixel widths.
- **Inline styles on every element.** Gmail strips `<head><style>` except media queries, so the `<style>` block carries *only* the ≤480px stacking query, which is a progressive enhancement: without it the grid stays two-column, which is the desktop design anyway.
- **No web fonts, no JavaScript, no SVG, no external CSS.**
- **Every `<img>` carries `width`, `height` and `alt`.** Fixed dimensions stop the layout collapsing while images load; alt text is what most Outlook readers actually see, since remote images are blocked there by default.
- **Bulletproof buttons** — a padded `<td>` with a background colour wrapping an `<a>`. A styled anchor loses its background in Outlook and becomes invisible text.
- **Gradients degrade**: the golden-hour band (`#f6d365 → #fda085`) paints a solid `bgcolor` **first**, so Outlook shows a warm band rather than a white void. `border-radius` is simply ignored there — squared corners are an accepted, documented degradation.
- **600px body width**, the widest every major client renders un-scaled.

Structure: gradient header band with a hidden preheader ("Your memories from {circle}") → greeting → **hero** memory (600×338 cover, type chip, 24px/700 title, subtitle, and the AI `narrative` when present) → up to **four** two-column cards (268×151 cover, chip, 16px/600 title, subtitle) → "See all memories" CTA → footer with the membership explanation and the unsubscribe link. The narrative is hero-only: four stacked paragraphs would turn a glanceable digest into an essay. A memory with no usable cover renders a **same-size** gradient placeholder, so a still-processing cover cannot shuffle every card below it.

**Subject line.** `"{count} new memories from {circle}"`, or — when a today-anchored `on_this_day` memory is present — `"On this day: {title} — and {n} more memories"`, which is the most emotionally specific thing in the mail and the strongest reason to open it.

**Plaintext part** is generated alongside (titles, subtitles, links, and the unsubscribe URL) via `layout.ts`'s `plainText()`. A multipart mail with an *empty* text part scores worse for spam than one with none, and the text part is all a terminal client or a text-mode screen reader ever sees.

**Light mode only.** `prefers-color-scheme` handling in email is a minefield — Outlook.com and Gmail both rewrite colours in dark mode in ways that fight any author-side scheme — so the design commits to one look. Known limitation.

### 7.7 Stateless signed capabilities

Two things in the mail must work for a reader with no session, weeks later. Both are solved the same way and neither creates a database row.

**Format**: `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload))`. The payload is readable by design — it carries an opaque UUID and an expiry, never a secret — and the signature is what makes it unforgeable. Same shape as the OAuth `state` token (`oauth-state.util.ts`).

| | Image token | Unsubscribe token |
|---|---|---|
| Payload | `{ m: mediaItemId, e: exp, p: 'memory-digest-image' }` | `{ u: userId, e: exp, p: 'memory-digest-unsubscribe' }` |
| TTL | `memories.digest.imageTokenTtlDays` (7–90, default 30) | 90 days (`UNSUBSCRIBE_TTL_DAYS`) |
| Grants | The **thumbnail** of exactly one media item | Opting exactly one user out of digests |

Signed-storage URLs expire in 24 h, which is useless for something sitting in an inbox — hence the long-lived capability. Inline/CID attachments were rejected (multi-MB mails, SES size limits), and minting a `MediaShare` row per image was rejected as DB litter with revocation churn.

**Security properties, each load-bearing:**

- **Keyed per purpose.** The two token kinds are signed with *different* `deriveSubKey()` sub-keys (`apps/api/src/common/crypto/secret-cipher.ts`, an HKDF-extract-style HMAC over a labelled constant), so an image token can never be replayed as an unsubscribe token or vice versa. The purpose is *also* carried in the signed payload and re-checked — belt and braces, so a future refactor that accidentally shared a key still fails closed. Both directions, and the shared-key scenario, are tested.
- **Never the master key.** Signing uses a derived sub-key, not `SECRETS_ENCRYPTION_KEY` itself, whose job is AES-256-GCM encryption of credentials at rest. Handing the same bytes to a routine whose outputs are published in emails would needlessly widen what an oracle against one primitive could say about the other.
- **Constant-time comparison.** `crypto.timingSafeEqual` over equal-length buffers, never `===`. Lengths are compared first (that comparison leaks only the length of a base64url SHA-256 digest, a constant).
- **Expiry is inside the signature**, so it cannot be extended by editing the URL. Expiry is the *only* revocation mechanism, which is precisely why the image capability is deliberately narrow.
- **No cross-resource replay.** A token names exactly one media item or one user; changing the id invalidates the signature. There is no wildcard token.
- **Every failure is the same failure.** Malformed, tampered, wrong-purpose and expired all return `null` and become a bare `NotFoundException`, so the routes are not an oracle for which media ids or user ids exist — the same enumeration-resistant posture as public shares and the notification `:id` routes.

### 7.8 The public routes

All three are `@Public()` and live in `PublicMemoryDigestController`.

| Route | Behaviour |
|---|---|
| `GET /api/public/memories/digest-image/:token` | Verifies the token, resolves the item's `metadata.thumbnailStorageKey`, streams those bytes |
| `GET /api/public/memories/digest-unsubscribe/:token` | Verifies the token, renders a confirmation page. **Mutates nothing** |
| `POST /api/public/memories/digest-unsubscribe/:token` | Verifies the token, sets `user_settings.memories.emailDigestOptOut = true` |

**Thumbnails only, never originals.** The image route selects *only* `metadata` from the media item — the original's storage key is never even read — so no token, valid or forged, has a code path to full-resolution bytes. An item whose thumbnail has not been generated yet 404s rather than falling back to the original. Bytes are proxied (not redirected to a signed storage URL) for the same reason `PublicShareController` proxies: the storage URL and the bucket layout it reveals never leave the server. Headers: `Content-Type: image/jpeg` (thumbnails are always JPEG, so the type is not derived from anything attacker-influenced), `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: public, max-age=86400, immutable` — the bytes behind a storage key never change, and an email client's image proxy (Gmail's, notably) fetches once and serves the reader forever after. A trashed item (`deletedAt IS NOT NULL`) goes dark immediately; archived items are still served, matching the public-share policy. A storage failure becomes a bare 404, never a 500 carrying a provider message.

**GET must not mutate.** Mail clients, corporate link scanners and prefetchers follow every GET in a message; if GET unsubscribed, a security scanner would silently opt out every recipient it "protected". So the GET renders a page whose only control is a form that POSTs the same token. The pages (`unsubscribe-page.ts`) are standalone HTML rather than React routes — the reader is by definition not logged in, possibly in a webmail preview pane, and must get an answer without a SPA bundle, an auth redirect, or any JavaScript. **No user-supplied string appears in any of the three pages**: the confirm page interpolates exactly one value, a token this server minted and already verified, URL-encoded, into a form action. Nothing to escape, and nothing that confirms to a stranger holding a stale link *whose* link it is. Every failure — bad signature, wrong purpose, expired, deleted user — renders the **same** `invalidLinkPage()` at status 404, saying only that the link no longer works.

**The POST** re-verifies, resolves the user (a token for a since-deleted user 404s rather than letting Prisma throw), and writes through `UserSettingsService.patchSettings` — the same zod validation, per-namespace merge and version increment as the in-app toggle ([§8.17](#817-the-preferences-ui-and-the-absent-key-contract-it-must-not-break)) that flips it back. It is idempotent: unsubscribing twice is a no-op that still renders the success page, which matters because a mail client may fire one-click more than once.

**`List-Unsubscribe` headers.** The template returns:

```
List-Unsubscribe: <{unsubscribeUrl}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

RFC 2369 + RFC 8058. The URL embeds a per-recipient token, which is exactly why per-message `headers` had to be threaded through `RenderedEmail → EmailMessage →` both the SES and SMTP providers rather than living in provider configuration. `One-Click` promises the client that a bare POST to that URL unsubscribes with no further interaction, which the POST route honours.

One-click POSTs `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded`. Bare Fastify parses only JSON and `text/plain`, but `@nestjs/platform-fastify`'s adapter already registers a urlencoded parser during `app.init()` — so nothing needs adding, and adding one anyway throws `Content type parser … already present` and fails startup outright. That is recorded as a warning in `common/fastify-setup.ts` and covered end to end by `test/memories/memory-digest-public.integration.spec.ts`. The body is never read: the capability is the signed token in the URL, never the body.

**`maxParamLength` — the bug that would have killed every link in every email.** Fastify's default limit on a single route parameter is **100 characters**, and a request exceeding it is rejected with `414 URI Too Long` before the handler is entered. Every digest token is longer than that (a base64url JSON payload plus a base64url SHA-256 signature; the unsubscribe token is ~150 characters), so with the default in place *every cover image and every unsubscribe link in every delivered digest is dead* — and no controller unit test can see it, because a unit test calls the method directly and never crosses the router. The limit is raised to `MAX_ROUTE_PARAM_LENGTH` (512) in `apps/api/src/common/fastify-setup.ts`, which **`main.ts` and the integration harness both construct their adapter from**; keeping it in one place is the point, since a test that boots a differently-configured server is not testing the server users get. `verify()` independently rejects anything over 4096 characters, so the router limit is a first bound, not the only one.

**Both unsubscribe routes write their own response** (`@Res()`) rather than returning a string under `@Header('Content-Type', 'text/html')`. That decorator applies *before* the handler runs, so a thrown `NotFoundException` would be serialized as a JSON object into a response already declared as HTML — which Fastify refuses to send, turning every invalid-token 404 into a 500. Writing the response explicitly keeps the success and failure paths symmetric and lets the 404 be a real HTML page a human can read.

**Re-subscribing** is the profile settings toggle ("Email me memory digests") in [§8.17](#817-the-preferences-ui-and-the-absent-key-contract-it-must-not-break), which writes the same key — and, being a *re*-subscribe, DELETES it rather than writing `false`.

### 7.9 Known gaps

- **A partial send is not resumable.** If the provider dies halfway through a large circle, the job still succeeds (§7.4) and the members it never reached simply wait for the next period. A per-recipient checkpoint table was rejected as disproportionate: circles are families, not mailing lists.
- **The digest is per circle, not per user.** A member of four circles that all have new content receives four emails in the same hour. Coalescing across circles would need a user-scoped scheduler and a watermark per (user, circle) pair; deferred.
- **`sendHourUtc` is UTC only** — there is no per-user or per-circle timezone. A deployment spanning many timezones cannot hit "9am local" for everyone. The `backup.*` namespace's IANA-timezone precedent exists if this becomes worth doing.
- **Item-level scrubbing** of hidden people inside mixed memories is not applied to the email either — it inherits §6.7's whole-memory rule exactly.
- **Image tokens cannot be revoked** before expiry, by design (no token table). A leaked digest URL exposes one thumbnail until `imageTokenTtlDays` elapses. Lowering the setting shortens the window for *future* mails only.
- **The `<style>` mobile query is best-effort.** Clients that strip it render the two-column grid on a phone; legible at 600px, but not the intended layout.
- **Light mode only** (§7.6).
- **Rendering is verified by unit tests plus manual inspection** in Gmail, Outlook and Apple Mail — there is no automated cross-client rendering check in CI.

## 8. Web UI

Introduced by issue [#309](https://github.com/marinoscar/MemoriaHub/issues/309): the Home carousel, the `/memories` hub, the `/memories/:id` detail page, and the client plumbing all three share. Completed by issue [#313](https://github.com/marinoscar/MemoriaHub/issues/313): the full-screen story player (§8.12–§8.15), the save-as-album dialog and the album-chaining share hand-off (§8.16), and the per-user memory-preferences UI (§8.17).

### 8.1 File map

| Path | Role |
|---|---|
| `apps/web/src/types/memories.ts` | DTO types mirroring `memory-response.dto.ts` |
| `apps/web/src/services/memories.ts` | One function per §6.1 endpoint |
| `apps/web/src/hooks/useMemoriesEnabled.ts` | The feature gate — `true \| false \| null` |
| `apps/web/src/hooks/useMemoriesFeed.ts` | Carousel feed |
| `apps/web/src/hooks/useMemories.ts` | Hub list, cursor-paginated |
| `apps/web/src/hooks/useMemory.ts` | Detail, with `notFound` separated from `error` |
| `apps/web/src/hooks/useMemoryActions.ts` | Optimistic seen/favorite/hide/delete |
| `apps/web/src/hooks/useMemoryListState.ts` | The list mutators both list hooks share |
| `apps/web/src/hooks/useLongPress.ts` | Touch entry point to the card action menu |
| `apps/web/src/components/memories/MemoryCard.tsx` | The one card, `size: 'compact' \| 'large'` |
| `apps/web/src/components/memories/MemoriesCarousel.tsx` | The Home row |
| `apps/web/src/components/memories/MemoryActionMenu.tsx` | Kebab / long-press menu |
| `apps/web/src/components/memories/DeleteMemoryDialog.tsx` | Tombstone confirm |
| `apps/web/src/components/memories/MemoryStoryPlayer.tsx` | The full-screen story player (#313) |
| `apps/web/src/components/memories/storyTiming.ts` | The player's pure timing model (#313) |
| `apps/web/src/components/memories/MemoryAlbumDialogs.tsx` | Save-as-album naming dialog + share hand-off (#313) |
| `apps/web/src/components/settings/MemoriesSettings.tsx` | Per-user memory preferences (#313) |
| `apps/web/src/components/memories/memoryTypeMeta.tsx` | Per-type icon + labels |
| `apps/web/src/components/memories/memoryFormat.ts` | Period, month-group and a11y-label formatting |
| `apps/web/src/pages/Memories/MemoriesPage.tsx` | `/memories` |
| `apps/web/src/pages/Memories/MemoryDetailPage.tsx` | `/memories/:id` |

Routes are registered in `App.tsx` (lazily, like every other page) and the sidebar entry sits in `primaryItems` directly under Photos.

### 8.2 The gate is strict-true, and it is checked in three places

`useMemoriesEnabled()` reads `GET /api/features` through the existing `useFeatureFlags()` module cache — **not** `GET /api/system-settings`, which requires the Admin-only `system_settings:read` and would 403 for an ordinary circle member. It returns `boolean | null`, where `null` means "not resolved yet", and every consumer gates on `=== true`.

That is not stylistic. A truthy check has two distinct failure modes here, both of which the sidebar's picture-enhancer entry already documents: the nav item or carousel row **flashes in** for one render while the flags load and then disappears, and a flags *outage* — which leaves `features` at `null` rather than throwing — would be indistinguishable from "off" only by accident. Strict-true makes both cases render nothing.

Three surfaces gate on it, for three different reasons:

- **Sidebar** — no nav entry when off. The hook adds no second request; it reads the same module-level cache the enhancer entry does.
- **`MemoriesCarousel`** — renders `null` when off, and passes `enabled: false` into `useMemoriesFeed`, so **no request is issued at all**. Rendering conditionally would have been enough to hide it and *not* enough to satisfy the epic's zero-cost criterion, which is why the flag is threaded into the hook rather than wrapped around the component.
- **`MemoriesPage` / `MemoryDetailPage`** — the routes always resolve (a bookmark must not 404) and the page renders a short "Memories are turned off for this installation" notice instead, with a link to `/admin/settings/memories` for an admin only.

The `MEMORIES_ENABLED` env kill-switch is **not** folded into the client flag. `getPublicFeatures()` returns the raw `features` record, so a deployment that leaves the setting on while disabling the env var will show the nav entry against an API that returns empty lists. That degrades to a clean empty state rather than an error (§6.3), which is the intended shape of every "off" path in this feature, and is recorded here rather than fixed on the client — the server-side helper is the single source of truth and the fix, if one is ever wanted, belongs in `getPublicFeatures()`.

### 8.3 The carousel is self-hiding by contract

`<MemoriesCarousel>` sits at the top of `HomePage` and renders `null` — contributing no heading, no spacing, no empty state — whenever the flag is not strictly on, there is no active circle, the feed resolved empty, **or the feed request failed**.

This is load-bearing rather than tidy. `HomePage`'s own header comment records that dashboard clutter was deliberately removed in issue #250, and the epic requires a brand-new install to look exactly as it does today. A "no memories yet" placeholder on Home would violate both, and an error row would make a transient API failure look like a broken product on the app's busiest route. The hub is where the empty state belongs, because a user who navigates to `/memories` asked to see it.

The one visible state before data arrives is a skeleton row with the exact card geometry, shown only on the first load. Once loading settles with nothing to show, the row disappears for good.

There is deliberately **no polling**. Memories are regenerated by an hourly cron at most (§3.1), so a poll would spend requests observing a value that cannot have changed; the feed refetches on circle switch only.

### 8.4 One card, two sizes

`MemoryCard` is the single component behind both surfaces, so their anatomy cannot drift:

- Cover thumbnail filling the card (`object-fit: cover`), with a bottom gradient scrim carrying a 2-line-clamped title and a subtitle.
- A frosted type badge top-left (`backdrop-filter: blur(8px)`) with the per-type icon from `memoryTypeMeta`.
- **Unseen ring** — a 2.5px primary→secondary gradient, the story-app convention. It is drawn as a gradient-filled *padding box* around the cover rather than a `border`, because a CSS gradient cannot be a border and stay crisp at arbitrary DPR. A seen card loses the ring and is slightly desaturated.
- `size: 'large'` additionally fans up to four item thumbnails behind the cover and shows an item-count chip.

**The fan only appears on the carousel, and that is a DTO fact rather than a bug.** `itemThumbnailUrls` ships on the *feed* card (§6.5) and not on the list card, so the hub's large tiles render without it. The component branches on the field's presence rather than on which surface it is mounted in, so if the list DTO ever grows the field the fan appears there with no code change.

Two colours in this file are literal `rgba()` rather than theme tokens — the scrim and the frosted-chip fill. That is the documented exception: a caption laid over an arbitrary user photo has to stay legible against *both* themes and against whatever the photo happens to be, which no palette token can express. Everything else comes from the MUI theme.

### 8.5 Motion is opt-out, and hover is pointer-only

Two animations exist: a 200ms `cubic-bezier(0.2,0,0,1)` scale-and-lift on the card, and a slow 6s Ken Burns zoom on the cover. Both are gated on `useMediaQuery('(prefers-reduced-motion: reduce)')` being false, and additionally on an `md`+ viewport, so a touch device never acquires a sticky hover state it has no way to leave. Smooth scrolling on the carousel chevrons falls back to `behavior: 'auto'` under the same preference.

Focus visibility is **not** gated on the motion preference — the shadow lift still applies on `:focus-within` regardless, because that one is an accessibility affordance rather than decoration.

### 8.6 Seen tracking

A card fires `POST /api/memories/:id/seen` once it has been **≥90% visible for a full second**, or immediately when opened. The dwell timer is what separates "the user looked at this" from "this scrolled past at speed"; without it, one flick through the carousel would mark every card seen.

`MemoryCard` owns the observation but never calls the API — it invokes an `onSeen` callback, and the owning surface decides what seen means. The write itself lives in `useMemoryActions.markSeen`, which dedups against a **module-scoped** `Set`. Module scope, not hook state, because the carousel and the hub observe the same cards: a user who sees a card on Home, opens the hub, and sees it again would otherwise POST twice for a value the server pins to the first view anyway. A failed report removes the id from the set, so the next view retries rather than losing the write permanently.

The ring updates optimistically. `markSeen` is the one action in this feature that is fire-and-forget: a lost seen write costs nothing beyond a ring that clears on the next view, so it does not roll back or surface an error.

### 8.7 Optimistic actions, and what rollback has to restore

Favorite, hide and delete all flip the caller's local state first, issue the request, and revert **that exact flip** on failure. Two details make the difference between a correct rollback and a plausible-looking one:

- **`patchMyState` merges, it does not replace.** Favoriting a card must not clear its `seen` flag, and a whole-object patch is precisely how that bug happens. The shared `useMemoryListState` hook exposes a merge-only mutator so no caller can get this wrong.
- **`restoreItem` puts a card back at its original index.** `removeItem` snapshots `{ index, item }` before dropping the row; rolling a refused hide or delete back to the *end* of the list would read to the user as a different, wrong outcome.

Both list hooks (`useMemories`, `useMemoriesFeed`) get these mutators from the same place, so the two surfaces cannot diverge on rollback semantics.

### 8.8 The hub

**URL-driven filters.** `?type=`, `?year=` and `?favorite=` *are* the page's state, so a filtered view is shareable, survives reload, and steps through the back button. Every value read out of the URL is coerced against what the API accepts (the `parseSortBy` pattern from `BurstsPage`) — a hand-edited query string is untrusted input, and an unrecognised `type` or an out-of-range `year` is dropped rather than forwarded.

The `person_highlights` and `person_over_years` kinds share **one** filter chip ("People"), which filters by `person_highlights`. `GET /api/memories` takes a single-valued `type`, so an OR across the two is not expressible; this is a known narrowing rather than an oversight.

**Layout.** A CSS grid of `repeat(auto-fill, minmax(240px, 1fr))` — the column count is decided by the container, not a breakpoint table, so a phone gets one column and an ultrawide gets many with no extra code. `trip` and `year_in_review` tiles span two columns from `md` up for visual rhythm; they are *not* widened at `xs`, where a `span 2` in a one-column grid would either overflow the track or silently collapse. Every tile reserves its box with `aspect-ratio` before its image loads, and all imagery is `loading="lazy"`, so the grid never shifts under a scrolling user.

**Grouping.** Month headers are keyed on `generatedAt` — when curation created the memory — not on the period it covers, because the list is ordered newest-generated-first and grouping by anything else would produce headers that repeat as the user scrolls. The group key is `YYYY-MM` so two Augusts never collide by label.

**Infinite scroll** reuses the existing `useIntersectionObserver` with a 400px `rootMargin`, disabled while a page is in flight or the cursor is exhausted.

**Actions** are reachable two ways — a kebab on the card (pointer) and a long-press (touch) — both opening the same `MemoryActionMenu`, so the two entry points cannot offer different actions. The long-press cancels if the finger moves more than ~10px, which is the single most common false positive in a scrollable grid. Delete is **omitted rather than disabled** for a viewer: a disabled destructive item advertises a capability the user does not have and invites them to go hunting for the permission. The API enforces the same rule independently (`media:write` + collaborator), so this is presentation of an authorization decision, never the decision itself.

**Empty states** distinguish the two cases that look identical and mean opposite things. Flag on with zero memories is the *new-install* state and reads as "nothing here yet" — "Your memories will appear here — MemoriaHub curates them automatically as your library grows" — with an admin-only hint linking to the backfill. A filtered-empty result reads "No {type} memories yet." instead, so a user never mistakes an over-narrow filter for an empty library.

### 8.9 Delete says what it does

`DELETE /api/memories/:id` is a circle-level tombstone whose natural key curation checks on every future run (§2.5). The memory is therefore not "deleted until it regenerates" — it can never come back, and it disappears for every other member of the circle at the same moment. `DeleteMemoryDialog` states both facts literally ("It won't be created again", "This can't be undone"), clarifies that the underlying photos are untouched, and offers **per-user hide as an in-dialog alternative**, because "I don't want to see this" is by far the more common intent and a user who arrives here by that route should not have to guess that a reversible option exists elsewhere in the menu.

### 8.10 Where the #309/#313 seam fell

For the record, since three sections below exist to close it. #309 shipped the surfaces and left three placeholders: **Play** navigated to `/memories/:id` and the detail page's Play button raised a "coming soon" toast; **save as album** worked end-to-end but always used the memory's own title, with no dialog; and **per-user preferences** had no UI at all. #313 replaced all three. One #309 decision stands unchanged and is worth restating, because it looks like duplication:

- **The detail page renders its own item tile**, not a gallery tile. `MemoryDetailItem` is a deliberately narrow projection (id, media type, dimensions, duration, signed thumbnail) and is *not* a `MediaItem`; adapting one to the other would mean inventing the fields `MediaGallery`'s tile needs and cannot get, and every one of them would be a lie. This is a real duplication and is accepted knowingly. §8.13 explains how the story player closes the same gap differently — by *resolving* the real `MediaItem` on demand rather than by faking one.

### 8.11 Retired with this issue

`components/home/OnThisDay.tsx`, `components/home/MemoryHighlights.tsx`, `components/home/QuickActions.tsx` and `hooks/useDashboard.ts` were deleted. All four were orphaned by the issue #250 Notification Center cutover — nothing had imported them since — and this epic replaces that generation of UI outright; leaving them would have left a second, unreachable memories surface in the tree. `GET /api/media/dashboard` and its `getDashboard()` client remain, still used elsewhere.

A side effect worth naming: `HomePage`'s "review-queue banners removed" regression guard used to work by mocking `useDashboard` with non-zero counts. With the hook gone, that guard is now the *compiler* — there is no module left to import — and the suite's remaining assertions cover the rendered shape instead.

### 8.12 The story player — why it is not `MediaLightbox` with a flag

`MediaLightbox` is the existing full-screen viewer and it already has an autoplay slideshow, so extending it was the obvious first idea. It was rejected. That component is ~1,000 lines of *viewer*: zoom, a properties pane, orientation editing, AI enhance, archive, trash, tag and metadata reruns, an overflow menu, and a fixed 4-second slideshow bolted on. A story is a different interaction model end to end — per-item timing, segmented progress, hold-to-pause, Ken Burns, a title card, an end card — and every one of those would have had to be threaded through code paths that exist for something else, with a `storyMode` flag deciding which half of the component is live.

What IS reused is the machinery rather than the shell: `getMedia()` for the signed full-resolution URL, the module-scope full-item cache, the neighbour-prefetch idea, the pointer-swipe arithmetic, and `Dialog fullScreen` — whose Modal supplies the focus trap, so the accessibility requirement is satisfied by the framework instead of by a hand-rolled trap that would need its own tests. `MemoryStoryPlayer` is a comparable size to `MediaLightbox` once its comments are counted, but none of it is conditional on a mode: the file is the player plus four private presentational pieces (`ProgressSegments`, `SlideLayer`, `TitleCard`, `EndCard`) that are deliberately kept co-located, because they consume style constants and the `--story-inset-*` safe-area variables the player defines on its Dialog paper — splitting them would move that coupling across a file boundary without removing it.

### 8.13 The timing model, and why two clocks

Every constant lives in `storyTiming.ts` as a pure function over the DTO, so the pacing is unit-testable without mounting a Dialog, a `<video>` and four CSS animations.

| Step | Duration |
|---|---|
| Title card | 2,500 ms |
| Photo | 5,000 ms |
| Video | `min(measured ?? durationMs ?? cap, 15 s)`, floored at 1,500 ms |
| End card | never advances |

A story is a walk over `[-1, 0 … n-1, n]`: `-1` is the title card, `0…n-1` the items, `n` the end card. Each step drives **two synchronized clocks**:

- a `setTimeout` that performs the advance, and
- a CSS animation that fills the active progress segment (and runs Ken Burns).

They are separate deliberately. Driving the bar from JS would mean a `requestAnimationFrame` loop re-rendering the tree 60 times a second for a decoration. Driving the *advance* from `animationend` would tie correctness to an animation that `prefers-reduced-motion`, a background tab, or a `display: none` ancestor may legally never run — a player that silently stops advancing whenever motion is suppressed. So **JS owns correctness, CSS owns smoothness**, and one boolean pauses both: `animation-play-state: paused` freezes the fill exactly where the timer's remaining-time arithmetic freezes the clock.

Pause is a **derived value**, never state: `paused = userPaused || holding || suspended`. Press-and-hold, the pause button and an open save-as-album dialog therefore take the same path and cannot disagree about who resumed. Pausing **banks the unspent remainder** rather than restarting the slide, so a photo paused with 1 s left advances 1 s after the resume.

Three details that are easy to get wrong and are therefore pinned by tests:

- **The reset key is the step index, not the duration.** Two consecutive photos both last 5,000 ms, so keying the timer's restart on the duration would leave the second slide running out the first one's timer and advancing early.
- **A measured video duration is tagged with its item's id.** The `<video>` element reports its real length on `loadedmetadata`, which wins over the ingest-time `durationMs` (that value can be absent for an old import or a failed ffprobe, or stale relative to the bytes being played). Tagging the measurement removes any window in which the previous clip's length paces the next slide, so no reset-on-navigate is needed at all.
- **A sub-second clip is floored at 1,500 ms.** `min(duration, 15 s)` taken literally gives a 300 ms clip a 300 ms segment, which reads as a flicker rather than a slide. This is the one deliberate deviation from #313's literal wording.

**Media resolution.** The memory DTO ships an 800 px signed thumbnail per item and no place name. A full-screen story needs the original bytes — mandatory for a video, visibly better for a photo on a desktop display — plus `geoLocality` for the caption, so the player resolves `GET /api/media/:id` for the current slide and the next two, caching results module-wide. Meanwhile the thumbnail is what is on screen, which is why a slow or failed fetch degrades to "slightly soft" rather than to a black frame. Neighbours are additionally **mounted at `opacity: 0`** so the browser has already decoded them by the time they become current; that, plus an `Image()` warm of the resolved original, is what removes the flash on advance. A `<video>` is only ever mounted for the *current* slide — mounting a hidden one would autoplay it.

### 8.14 Motion, and what `prefers-reduced-motion` actually turns off

- **Ken Burns**: a slow `scale(1) → scale(1.08)` with a translate, alternating pan direction per item so consecutive slides do not drift the same way. Transform-only, so it stays on the compositor: no layout, no paint, no jank on a phone.
- **Crossfade**: 400 ms opacity transition between slides.
- **Title card**: the type chip, title, subtitle and AI narrative fade up on a 120 ms stagger.

Under `prefers-reduced-motion: reduce` all three are suppressed and the player **cuts** instead — and keeps working, which is the property the reduced-motion test exists to protect.

The progress fill is deliberately **not** suppressed. It is the only indication of how long the current slide will hold, which makes it feedback rather than decoration; a story whose progress bar sat still would leave a reduced-motion user unable to tell whether the player had frozen.

### 8.15 Interaction and accessibility

**Pointer.** A full-bleed gesture surface sits above the slides and below the chrome. A tap in the left 30% goes back, anywhere else advances; a horizontal drag past 50 px is a swipe; a press held for 220 ms is hold-to-pause. A drag cancels a *pending* hold but never releases an *engaged* one, so a finger that shifts slightly while resting on the screen does not silently resume playback. The surface is `aria-hidden` and unfocusable — keyboard users have the arrow keys and the explicit chevrons, so exposing an unlabelled full-screen hit target would only add noise to the tab order.

**Keyboard.** `←`/`↑` back, `→`/`↓` forward, `Space` toggles pause, `Home`/`End` jump to the title and end cards, `M` toggles mute, `Esc` closes (MUI's own handler). The listener is bound to the window rather than the dialog node so shortcuts work wherever focus sits inside the trap — including on the backdrop, which is what holds focus right after the dialog opens. It **skips `Space` and `M` when the event target is interactive**, so a focused button still activates on Space instead of double-firing.

**Screen readers.** The whole bar is ONE `role="progressbar"` with `aria-valuenow`/`aria-valuemax`/`aria-valuetext`; the individual segments are `aria-hidden` decoration. Marking each segment up as its own progressbar would announce a dozen unlabelled meters and convey nothing about position. A `role="status" aria-live="polite"` region announces `Photo 3 of 12 · 12 March 2023` on every step — for a non-sighted user that region is the *only* channel carrying position, which is why it names the index rather than merely describing the slide. The accessible name sits on the Paper (the node carrying `role="dialog"`), not on the Modal root, or the dialog announces as unnamed.

**Phone.** Safe-area insets are applied to the chrome (`env(safe-area-inset-*)`) while the media itself stays edge to edge; every control clears the 44 px touch target.

**Videos** autoplay muted with a visible unmute control in the top bar rather than a bare tap-to-unmute — the surface tap advances the story, so unmuting needed an affordance that is also reachable by keyboard. A refused `play()` (autoplay policy, decode failure) degrades to a still poster that still advances on time, because the story's clock is its own.

### 8.16 Save as album, and sharing by album chaining

**Save as album** opens a naming dialog prefilled with the memory's title (client-capped at the API's 256 characters), calls `POST /api/memories/:id/save-album`, and reports a snackbar linking to the new album.

**Share** is **album chaining**, per the epic's explicit v1 decision. A memory has no public share target — `ShareTargetType` is `media_item | album`, and extending it would mean a new enum value, a new public renderer and a new unauthenticated read path, all deferred to v2. So sharing saves the memory as an album *silently* (using the memory title), then hands that album id to the very same `ShareDialog`/`SharePanel` the album page uses, landing the user directly on the copy-public-link step. Nothing in the sharing subsystem changed.

The one thing this owes the user is honesty: sharing creates a visible album in their library. The first step of the flow says so before the album exists, rather than leaving them to find an album they never asked for.

`MemoryAlbumDialogs` owns both flows for all three call sites (hub, detail page, player), each of which keeps a single `MemoryAlbumMode | null`. The silent save is keyed on the flow rather than on the callback's identity, so a re-render cannot fire a second save — that failure would litter the library with duplicate albums and nothing would fail loudly, which is why it is pinned by a test. The dialogs render at `zIndex: modal + 2` so they sit over the player, and the player is `suspended` (paused) while one is open.

### 8.17 The preferences UI, and the absent-key contract it must not break

`MemoriesSettings` is a section on the user settings page, structurally modelled on `NotificationSettings`, reading and writing `user_settings.memories` (§6.7) through the existing `PATCH /api/user-settings`. There is no memories-specific settings endpoint and none was added.

The namespace is stored **sparsely** and absent means *no preference*: nobody hidden, no sensitive window, digest ON. That contract is what let it ship without a migration, and it is what a preferences UI most easily destroys — so this component:

- **derives** every control from `settings.memories`, with no defaulted local mirror that could be written back;
- **PATCHes exactly the one key it changed**, never a materialized namespace;
- **clears a key with `null`** (a JSON Merge Patch delete) rather than `[]` / `false`, so removing your last hidden person returns you to the absent default instead of pinning you to today's default forever. Re-subscribing to the digest likewise deletes `emailDigestOptOut` rather than writing `false`.

Three controls:

- **Hide people** — an autocomplete over the active circle's people with cover-face avatars. Because the preference is app-wide while the picker can only show one circle, ids it cannot resolve (set in another circle, or belonging to a since-deleted or merged person) are surfaced as plain removable chips and **preserved across saves**; dropping them would silently un-hide somebody the user asked to hide.
- **Hide date ranges** — from/to rows with a `from ≤ to` check. These use **native `<input type="date">`**: `@mui/x-date-pickers` is not a dependency of this app, `SharePanel` already sets the native-input precedent, and the native control emits exactly the `YYYY-MM-DD` the API accepts, whereas a picker returning a `Date` would need a formatting step whose only likely contribution is a timezone bug.
- **Email digest** — a switch bound to the inverse of `emailDigestOptOut`. This is the in-app counterpart of the tokenized unsubscribe link in §7.8; both write the same key.

**Why the ranges have a Save button and the other two do not.** A switch flip and a chip removal are complete gestures — the intent is unambiguous the moment they happen, so they save immediately as a one-key delta, exactly like the notification switches. A date range is *incomplete* until both bounds are filled and ordered; saving per keystroke would PATCH a half-typed year that the API would reject. So ranges are edited locally and committed explicitly.

The section is gated strict-true on `useMemoriesEnabled()` and threads that into `usePeople` (`enabled ? circleId : null`), so with the flag off it renders nothing **and** fires no people request — the same standard as the carousel (§8.3).

### 8.18 The admin settings page

`apps/web/src/pages/Admin/MemoriesSettingsPage.tsx` (`/admin/settings/memories`, issue [#315](https://github.com/marinoscar/MemoriaHub/issues/315)) is the deployment-wide counterpart to §8.17's per-user preferences, and the two are deliberately different surfaces: one decides what the *feature* does, the other what one *person* sees. It follows `BurstsSettingsPage`/`EnhancerSettingsPage` exactly — admin gate → `Navigate`, `useSystemSettings()`, local state synced with `?? default`, `Paper` sections, snackbars — plus a route in `App.tsx` and a tile in `SettingsHubPage` (AI & Enrichment group, `AutoAwesomeMotion`).

Six sections:

1. **Feature toggle** — `features.memories`, plus prose on the default-off posture and the `MEMORIES_ENABLED` env kill-switch that overrides it.
2. **AI titles** — the `memories.aiTitles.enabled` switch, and the provider/model picker for `ai.features.memories` (§9.4).
3. **Generation** — `generation.intervalHours`, `maxItemsPerMemory`.
4. **Memory types** — a switch plus that type's parameters for each of the six curator families.
5. **Email digest** — `digest.*`, with a warning when no email provider is configured.
6. **Backfill** — the circle selector and the button described in §3.5.

Five things about it are load-bearing rather than cosmetic:

**The feature toggle merge-spreads.** `features` is one open `Record<string, boolean>` holding every flag in the deployment, so `updateSettings({ features: { memories: checked } })` would clear auto-tagging, face recognition and the rest. The page writes `{ ...(settings?.features ?? {}), memories: checked }`, and a test asserts the two unrelated flags survive — this is the documented footgun of the settings shape, not a hypothetical.

**One Save for the whole `memories` namespace.** Per-section saves would let an admin persist a `minItems` above `maxItemsPerMemory` in two steps without ever seeing them side by side. A single `updateSettings({ memories: { … } })` writes the namespace as one consistent document, matching how the curators read it (§4.14). The AI model is the one exception — it is not in this namespace at all, and saves separately through `PUT /api/ai/features/memories`.

**Every bound is duplicated from the zod schema, on purpose.** The `BOUNDS` table at the top of the file mirrors §9.2 so a number field rejects out-of-range input in the browser instead of surfacing an opaque 400. That makes the page a **fourth** hand-maintained copy of this namespace on top of the three §9.3 already warns about — the tradeoff was taken because the alternative is a form that lets an admin type a value the API silently refuses, but a bound changed on the server has to be changed here too.

**The credential warning exists because the failure is invisible.** Selecting a provider with no enabled credential is not an error anywhere: titling just returns `null` and every memory gets a template title (§5.1), which is *correct* behaviour and therefore indistinguishable from working. The page cross-checks the selection against `GET /api/ai/settings`'s provider list and says so out loud, linking to `/admin/settings/ai` — the same reasoning behind `EnhancerSettingsPage`'s readiness panel. The same logic drives the digest section's "Email not configured" chip: `digest.enabled` with no email provider is a switch that does nothing.

**The backfill button is gated on the feature flag client-side and the API 400s anyway.** Both, deliberately: the client gate is the affordance (with a caption saying why it is disabled), the server gate is the guarantee — and only the server sees `MEMORIES_ENABLED`. On success the alert reports `enqueued`/`skipped` and links to `/admin/settings/jobs?type=memory_generation`, because a backfill's real progress lives in the job queue, not on this page; the caption states up front that it is idempotent, background-priority, and AI-title-capped, so nobody has to read §3.5 to know it is safe to press twice.

## 9. Settings

Introduced by issue [#302](https://github.com/marinoscar/MemoriaHub/issues/302) and edited by the `/admin/settings/memories` admin page ([§8.18](#818-the-admin-settings-page)) since issue [#315](https://github.com/marinoscar/MemoriaHub/issues/315). Every key below also remains reachable through the generic `PUT`/`PATCH /api/system-settings` (Admin + `system_settings:write`), which is what the page itself uses.

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

Filled in by issue [#307](https://github.com/marinoscar/MemoriaHub/issues/307) for the user-facing API. The admin surface — `/admin/settings/memories` and the library backfill ([#315](https://github.com/marinoscar/MemoriaHub/issues/315)) — reuses `system_settings:read`/`system_settings:write` like every other admin settings page, and the AI model picker on that page reuses `ai_settings:write` because it writes `ai.features.memories` through the existing `PUT /api/ai/features/memories`.

**No new permission was introduced, and none should be.** A memory is a *derived view* over media the caller can already see — it grants access to nothing they could not reach through `GET /api/media`. `media:read` / `media:write` plus the per-circle roles express the intent exactly, so a `memories:*` permission would add a second thing to keep in sync with the media permissions for zero additional expressiveness. That was the epic's explicit decision, and it follows the precedent set by Workflows (which reuses `media:read`/`media:write`/`media:delete` + per-circle roles) and Notifications (authentication only, because every route is already user-scoped).

| Capability | System permission | Per-circle role | Notes |
|---|---|---|---|
| List, feed, detail | `media:read` | **viewer** | Circle-scoped list/feed use `assertCircleAccess`; `:id` routes use the 404-not-403 path (§6.6) |
| Mark seen / hide / un-hide / favorite / un-favorite | `media:read` | **viewer** | Scoped to the JWT's `userId` and touching no circle content, so membership is the real gate; `media:read` rides along because it is what the whole surface is gated on and a caller without it has no business reading the memory the state refers to |
| Save as album | `media:write` | **collaborator** | Same bar as `POST /api/media/albums`, whose service path this reuses |
| Delete (tombstone) | `media:write` | **collaborator** | Mutates circle content for every member; a viewer's equivalent is the personal hide |
| View / edit `/admin/settings/memories` | `system_settings:read` / `system_settings:write` (+ **Admin** role) | — | Not circle-scoped: these are deployment-wide settings |
| Run the library backfill | `system_settings:write` (+ **Admin** role) | — | Same guard as `POST /api/admin/bursts/backfill` and every other global backfill |
| Choose the memory-titling model | `ai_settings:write` (+ **Admin** role) | — | Written through the existing `PUT /api/ai/features/memories`; the page adds no endpoint of its own |

**Super-admin bypass.** A user holding `circles:manage_any`, `media:write_any` or `media:read_any` bypasses the per-circle role check entirely, exactly as `CircleMembershipService.assertCircleAccess` does elsewhere — `loadAccessibleMemory` reproduces that bypass rather than inventing a second policy. This is what lets a system Admin moderate a circle they do not belong to.

**Two status-code rules.** A memory in a circle the caller is not a member of is **404** (enumeration-resistant — the caller must not be able to confirm the id exists), while a member who lacks the *rank* gets **403** (their membership is not a secret and the distinction is actionable). See §6.6.

**Preferences carry no permission at all.** The `user_settings.memories` namespace (§6.7) is read and written through the existing `GET`/`PATCH`/`PUT /api/user-settings`, which is already scoped to the calling user — there is nothing an additional permission would protect, the same rationale that kept `notifications` and `dataTables` permission-free.

**The notification and digest surfaces add no permission either.** `memories_ready` follows the Notification Center's authentication-only model (every row is already `userId`-scoped, so an Admin-gated permission would protect nothing). The three digest routes ([§7.8](#78-the-public-routes)) are `@Public()` by necessity — their whole purpose is to work with no session — and their access control is the HMAC signature rather than RBAC. That is a deliberate substitution, not an exemption: each token is a single-resource, expiring, purpose-bound capability that grants strictly less than any role would ([§7.7](#77-stateless-signed-capabilities)), and the failure mode of every invalid token is an identical bare 404.

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
| 1.0 | August 2026 | AI Assistant | Issue #315: added §3.5 (the library backfill — why it enqueues rather than implements backfill semantics, why one job per circle could not hold On This Day's 366-anchor pass under `ENRICHMENT_JOB_TIMEOUT_MS` and what a claim-time-charged attempt makes that cost, the 12-months + 6-curators shard plan and why only On This Day needed an intra-curator axis, the total payload parser and its degrade-to-more-work direction, the divided-not-multiplied AI-title budget, and the per-page batched in-flight skip with its 400/404 gating) and §8.18 (the admin settings page — its six sections, the merge-spread feature toggle, the one-Save-per-namespace decision, the bounds table as a knowingly-fourth hand-maintained copy, and why the missing-credential and unconfigured-email warnings exist at all: both failures are silent by design). Marked §4.15's "backfill is unchunked" gap resolved, pointed §6.1's backfill row at `AdminMemoriesController`, and extended §9's lead-in and §10's RBAC table with the admin surface.  |
| 0.9 | August 2026 | AI Assistant | Issue #313: completed §8 (Web UI) — §8.10 rewritten from "what #309 stops at" to a record of where the seam fell, plus new §8.12 (why the story player is a dedicated component rather than `MediaLightbox` with a `storyMode` flag, and what is reused instead), §8.13 (the timing table; the two-clock model with JS owning advance correctness and CSS owning smoothness, and why driving the advance off `animationend` would break under reduced motion or a background tab; pause as a derived value that banks its remainder; the step-index reset key, the item-id-tagged video measurement, and the 1,500 ms short-clip floor as the one deliberate deviation from the issue text; on-demand full-media resolution with opacity-0 neighbour mounting), §8.14 (what `prefers-reduced-motion` turns off, and why the progress fill is deliberately not one of them), §8.15 (tap zones / hold-to-pause / swipe and the engaged-hold rule; the window-bound keyboard map and its interactive-target `Space` guard; one progressbar rather than a dozen unlabelled meters, the polite live region as the only position channel for a screen reader, and the accessible name belonging on the Paper; safe-area insets; muted video autoplay with a real unmute control), §8.16 (save-as-album naming, and sharing as album chaining with the honesty requirement, the shared three-call-site component, and the flow-keyed effect that prevents duplicate albums), and §8.17 (the preferences UI and the absent-key contract it must not break — derive-never-mirror, one-key deltas, `null`-to-delete; unresolvable person ids preserved rather than dropped; native date inputs and why; why only the date ranges have a Save button). Updated the status line, §1, the file map, and the §6.7 / §7.8 pointers to the in-app digest toggle. §8 is now complete; only #315's admin page remains outstanding for the epic. |
| 0.8 | August 2026 | AI Assistant | Issue #309: filled in §8 (Web UI — the file map; the strict-true `useMemoriesEnabled()` gate, its three consumers, why the flag is threaded INTO the feed hook rather than wrapped around the component, and the deliberately unfolded `MEMORIES_ENABLED` env kill-switch; the carousel's self-hiding contract including the failed-request case and why Home carries no empty state or poll; the one-card/two-sizes anatomy, the gradient-padding-box unseen ring, the fan's DTO-driven absence on the hub, and the two literal-rgba exceptions; motion as opt-out with pointer-only hover and ungated focus; the ≥90%-for-1s seen dwell and its module-scoped cross-surface dedup; the merge-not-replace and index-preserving-restore rollback rules; the hub's URL-coerced filters, the single People chip narrowing, the auto-fill grid with `md`-only wide spans, `generatedAt` month grouping, dual kebab/long-press action entry, omitted-not-disabled Delete, and the two distinct empty states; the delete dialog's permanence copy and in-dialog hide alternative; the #313 seam; and the retired dashboard components). §7 remains a placeholder. |
| 0.7 | August 2026 | AI Assistant | Issue #307: filled in §6 (API — the endpoint catalogue with its permission/role column; the three read invariants and why per-user hide is deliberately not the tombstone; the flag-checked-before-any-query ordering that makes the default-off state cost zero queries and return empty lists rather than errors; keyset-only pagination, the `year` range-overlap compilation, and why `nextCursor` must come from the RAW page; the feed's two bounded reads, exact-`periodKey` anchor match and 60-row candidate window; the 404-not-403 `loadAccessibleMemory` policy and why it does not call `assertCircleAccess`; the `user_settings.memories` namespace with its absent-means-default rule, field-wise merge, overlap-not-containment date filtering and the read-time-never-generation-input rationale; COALESCE state writes and why clearing never upserts; the tombstone write and its audit event; save-as-album's reuse of the album service path plus its trashed-item and non-idempotence decisions; the one-batched-call thumbnail rule; serialization; and six known gaps) and §10 (RBAC — the no-new-permission decision, the capability table, super-admin bypass, the two status-code rules, and why preferences carry no permission). §7 and §8 remain placeholders. |
| 0.6 | August 2026 | AI Assistant | Issue #306: filled in §5 (AI Titles, Subtitles & Narratives — the total `generate()` contract and the complete failure table with which entries avoid a provider call at all, the metadata-only prompt payload and the absent-by-construction privacy list, the one-file prompt with its per-type snapshots and the strict-JSON/length-cap contract shared between the system prompt and the parser, the 10s whole-stream timeout with its remaining-budget race and fire-and-forget iterator close plus the new optional `ChatRequest.temperature`, the per-job `MemoryTitleRun` budget and why it is a passed object rather than service state, the rate-limit stop-the-run rule and the 100-call backfill cap, the two `upsertMemory` branches that call titling and the tombstone/outside-the-transaction ordering, the no-network test strategy, and five known gaps). §6–§8 and §10 remain placeholders. |
| 0.1 | August 2026 | AI Assistant | Initial specification for issue #301: the `MemoryType` enum, the `Memory`/`MemoryItem`/`MemoryUserState` data model, the `periodKey`/`subjectKey` semantics, the tombstone contract, cascade summary, and alternatives considered. Sections 3–10 are placeholders for later issues in epic #300. |
| 0.5 | August 2026 | AI Assistant | Issue #305: added §4.9 (the People curators — the one shared eligibility rule and why per-user hidden people are deliberately excluded from generation, the archived-face exclusion, the grouped `(person, year)` census and why over-counting makes the pre-filter sound, the year-bucketed diversity policy and the >=3-year floor that separates the two types, the highest-confidence cover override, and the Cascade-FK delete/merge story), §4.10 (the Theme curator — the tag-vocabulary-over-clustering rationale, the three filters `source='ai'` / enabled label / denylist, ranking by distinct qualifying items with the exact per-year sum behind the all-history period, walking past a short tag under a bounded attempt cap, and why a tombstoned theme consumes its slot), and §4.11 (Seasonal & Year-in-Review — the shared per-month census, completed-seasons-only and the season-year fold with its spring-first ordinal, and the December/January window plus month bucketing). Extended §4.5 with the opt-in `selectByBuckets` calendar policy, rewrote §4.13's registry paragraph for the full seven, and added five known gaps to §4.15. Renumbered the former §4.9–§4.12 to §4.12–§4.15 so the curator sections stay together. §5–§8 and §10 remain placeholders. |
| 0.4 | August 2026 | AI Assistant | Issue #304: added §4.8 (the Trips curator — fixed-24-month home inference with the 30% modal-share floor and the same-floor `geoAdmin1` fallback, median-based three-way away/home/neutral day classification and the coordinate-less metadata fallback that can only add an away day, gap-tolerant run merging where a home day terminates rather than bridges, the >=50%-of-the-SHORTER-span overlap matching that re-keys a boundary-shifted trip in place instead of duplicating it, tombstone participation in that matching, the `retitle` flag for a drifted subject, backfill and its flat-memory streaming aggregation, the EXPLAIN-verified reuse of `media_items_gallery_idx` with no new migration, and known gaps). Renumbered the former §4.8–§4.11 to §4.9–§4.12 so the curator sections sit together. §5–§8 and §10 remain placeholders. |
| 0.3 | August 2026 | AI Assistant | Issue #303: filled in §4 (Curation Engine — the structural base filter, constant-memory keyset candidate streaming with per-page batched signal lookups, the scoring weights and the neutral-NULL-sharpness rule, the pure-score-vs-selectionScore split for the long-video preference, burst/duplicate collapse and its burst-wins precedence, time-bucket diversity with the 3-video cap, deterministic ordering and the never-a-video cover rule, template titles for all seven types, the On This Day curator with its today+tomorrow anchors / one-query-per-anchor design / new circle-scoped functional index / backfill anchor widening / retention tail, the `upsertMemory()` idempotency and tombstone contract with its Jaccard title-preservation rule, the curator registry and per-curator error isolation, settings resolution, and known gaps). §5–§8 and §10 remain placeholders. |
| 0.2 | August 2026 | AI Assistant | Issue #302: filled in §3 (Generation — `MemoriesGenerationTask`'s three gates and zero-cost-when-off contract, the mandatory `skipDedup: true` rationale, the server-only `MemoryGenerationHandler` and its no-node-pair system-mode inference, job labels, and the `JobReason.backfill` deviation from the issue text) and §9 (Settings — `features.memories` + the `MEMORIES_ENABLED` kill-switch and their shared `isMemoriesEnabled()` gate, the full `memories.*` bounds/defaults table, the three-hand-maintained-copies pitfall, and `ai.features.memories` with its up-front credential validation). §4–§8 and §10 remain placeholders. |

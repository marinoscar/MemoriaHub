# Memories — Resurface Your Best Moments

| Field | Value |
|-------|-------|
| **Version** | 0.2 (data model + generation plumbing) |
| **Last Updated** | August 2026 |
| **Status** | Partial — Data Model (#301), Generation plumbing & Settings (#302); §4–§8 and §10 are placeholders for later issues in epic #300 |

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

Sections 4–8 and 10 are placeholders that name the issue expected to fill them in; do not treat their absence as an oversight. Until curators land in #303–#305, an enabled deployment schedules jobs and creates **zero** memory rows — which is the intended, tested intermediate state.

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

Placeholder. Covered by issue [#303](https://github.com/marinoscar/MemoriaHub/issues/303) (curation engine, On This Day curator), issue [#304](https://github.com/marinoscar/MemoriaHub/issues/304) (Trips curator), and issue [#305](https://github.com/marinoscar/MemoriaHub/issues/305) (People, Theme, Seasonal & Year-in-Review curators). Expected to define: the shared base filter (`capturedAt IS NOT NULL AND deletedAt IS NULL AND archivedAt IS NULL AND socialMediaSource IS NULL`), quality scoring (favorites, sharpness, favorite-person faces), burst/duplicate best-shot collapse via `suggestedBestItemId`, time-bucket diversity, and per-type minimum item counts.

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
| 0.2 | August 2026 | AI Assistant | Issue #302: filled in §3 (Generation — `MemoriesGenerationTask`'s three gates and zero-cost-when-off contract, the mandatory `skipDedup: true` rationale, the server-only `MemoryGenerationHandler` and its no-node-pair system-mode inference, job labels, and the `JobReason.backfill` deviation from the issue text) and §9 (Settings — `features.memories` + the `MEMORIES_ENABLED` kill-switch and their shared `isMemoriesEnabled()` gate, the full `memories.*` bounds/defaults table, the three-hand-maintained-copies pitfall, and `ai.features.memories` with its up-front credential validation). §4–§8 and §10 remain placeholders. |

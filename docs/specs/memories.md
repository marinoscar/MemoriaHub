# Memories — Resurface Your Best Moments

| Field | Value |
|-------|-------|
| **Version** | 0.1 (data model only) |
| **Last Updated** | August 2026 |
| **Status** | Partial — Data Model Implemented (issue #301); all other sections are placeholders for later issues in epic #300 |

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

This issue (#301) lays only the database foundation: the `MemoryType` enum and the `Memory` / `MemoryItem` / `MemoryUserState` models, with no generation, curation, AI, API, or UI code yet. Every later issue in the epic builds on this schema without altering it. Sections 3–10 below are placeholders that name the issue expected to fill them in; do not treat their absence as an oversight.

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

Placeholder. Covered by issue [#302](https://github.com/marinoscar/MemoriaHub/issues/302) (settings namespace, feature flag, AI model selection, and the generation job skeleton) and issue [#303](https://github.com/marinoscar/MemoriaHub/issues/303) (curation engine, On This Day curator, template titles). Expected shape per the epic's architecture summary: an hourly `MemoriesGenerationTask` cron enqueuing one `memory_generation` `enrichment_jobs` row per circle (`skipDedup: true`, background priority), whose handler runs each enabled type-specific curator with per-curator error isolation, server-only (no `nodeResultSchema`).

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

Placeholder. Covered by issue [#302](https://github.com/marinoscar/MemoriaHub/issues/302) (feature flag and settings namespace skeleton) and issue [#315](https://github.com/marinoscar/MemoriaHub/issues/315) (admin settings page `/admin/settings/memories` and library backfill). Expected namespace per the epic's architecture summary: `features.memories` (global flag, default off) and a `memories.*` namespace covering `generation.intervalHours`, `maxItemsPerMemory`, `aiTitles.enabled`, and per-type sub-namespaces (`onThisDay`, `trips`, `people`, `themes`, `seasonal`, `yearInReview`, `digest`) — see epic [#300](https://github.com/marinoscar/MemoriaHub/issues/300) for the full parameter table and bounds/defaults.

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

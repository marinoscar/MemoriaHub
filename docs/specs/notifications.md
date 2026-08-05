# Notification Center — Feature Spec

| Field | Value |
|-------|-------|
| **Epic** | #240 |
| **Children** | #244 (schema) · #245 (service + API) · #246 (review-queue reconcile) · #247 (event producers) · #248 (retention purge) · #249 (bell) · #250 (inbox page) · #251 (preferences) |
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [The Problem This Replaces](#2-the-problem-this-replaces)
3. [Data Model](#3-data-model)
4. [The Three Write Primitives](#4-the-three-write-primitives)
5. [Producers](#5-producers)
6. [The `countAtRead` Contract](#6-the-countatread-contract)
7. [Retention](#7-retention)
8. [Preferences (#251)](#8-preferences-251)
9. [Frontend](#9-frontend)
10. [RBAC](#10-rbac)
11. [Module Graph and the No-Imports Rule](#11-module-graph-and-the-no-imports-rule)
12. [API Endpoints](#12-api-endpoints)
13. [Known Gaps and Limitations](#13-known-gaps-and-limitations)
14. [Implementation Notes Where the Build Diverged From the Issues](#14-implementation-notes-where-the-build-diverged-from-the-issues)
15. [Future Work](#15-future-work)

---

## 1. Overview and Goals

Epic #240 gives MemoriaHub one push surface — a bell in the AppBar, a badge on the sidebar, and a full inbox at `/notifications` — for everything the app previously either nagged the user about on Home or said nothing about at all. Eight child issues built it in dependency order:

| Issue | Delivered |
|---|---|
| #244 | Schema only: the `notifications` table, `NotificationType` enum, and the partial unique index (§3). No writer, no reader. |
| #245 | `NotificationsService` (the single write/read path) and the authenticated CRUD API. |
| #246 | `ReviewQueueReconcileService` — the hourly sweep that keeps the four `review_queue_*` STATE rows in sync with real pending counts. |
| #247 | The four EVENT producers: uploads, enrichment failures, workflow runs, expiring shares. |
| #248 | `notification_purge` — the retention sweep. |
| #249 | `NotificationBell` + `NotificationPanel` in the AppBar. |
| #250 | The sidebar badge and the `/notifications` inbox page. |
| #251 | Per-type user preferences, including dismiss-on-disable. |

Goals:

- **One row per fact, however many times that fact would otherwise be reported.** A review queue's pending count is a single number, not one row per item in it. A bulk import is a handful of counted rows, not one per file.
- **A single write path.** Every producer — present or future — calls into `NotificationsService`, never `prisma.notification.create()` directly, so the dedup and preference-gating rules cannot drift between call sites.
- **Self-healing.** The review-queue rows are periodically re-stated from the real counts rather than incrementally patched from events, so a missed write, a crash mid-run, or a row a user resolved by hand all converge on the next hourly tick.
- **Preferences are enforced once, centrally**, not re-implemented per producer.

## 2. The Problem This Replaced

Before this epic, `HomePage` rendered up to three `Alert` banners — one each for pending burst groups, pending duplicate groups, and pending location suggestions — sourced from `GET /api/media/dashboard`'s `pendingBurstGroups` / `pendingDuplicateGroups` / `pendingLocationSuggestions` counts. This had three compounding problems:

- **They filled the viewport.** Three stacked `Alert` banners above the gallery is a lot of vertical space on a phone, and Home is the app's most-visited route — the exact place that space is most expensive.
- **They could not be dismissed.** An `Alert` has no acknowledgment state. A user who has already decided "I'll deal with the 40 duplicate groups later" sees the same banner, unchanged, on every visit to Home until the underlying queue actually drains.
- **They persisted until the queue drained, not until the user acted on it.** A circle with 929 pending duplicate groups is not a "deal with this today" problem — it is background debt that will take many sessions to work through, if ever. The old design had exactly one way to make the banner go away: clear the entire queue. There was no notion of "I've seen this, stop reminding me until it changes."

There was also no push surface at all for anything that was not one of those three counts — a finished upload, a permanently-failed enrichment job, a workflow run finishing, a public share about to expire. Those events either had no notification (uploads, workflow runs, shares) or were visible only if an admin happened to check `/admin/settings/jobs` (enrichment failures).

Issue #250's `HomePage` change deleted the three banners outright — see the file's own header comment, which states the rationale verbatim: leaving them in place "would have meant two independent surfaces racing to report the same numbers." `useDashboard()`'s three review-queue counts went with them; the endpoint (`GET /api/media/dashboard`) and its hook still exist for On This Day / recent / favorites, but Home no longer calls either for review-queue counts.

## 3. Data Model

Migration `20260805000000_add_notifications`. One table, one enum.

```prisma
enum NotificationType {
  review_queue_bursts
  review_queue_duplicates
  review_queue_location_suggestions
  review_queue_enhancements
  upload_completed
  enrichment_failed
  workflow_run_completed
  share_expiring
}

model Notification {
  id          String            @id @default(uuid()) @db.Uuid
  userId      String            @map("user_id") @db.Uuid
  circleId    String?           @map("circle_id") @db.Uuid
  type        NotificationType
  title       String
  body        String?
  link        String?
  data        Json?             @db.JsonB
  readAt      DateTime?         @map("read_at") @db.Timestamptz
  dismissedAt DateTime?         @map("dismissed_at") @db.Timestamptz
  createdAt   DateTime          @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime          @updatedAt @map("updated_at") @db.Timestamptz

  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  circle Circle? @relation(fields: [circleId], references: [id], onDelete: Cascade)
}
```

`circleId` is nullable — `null` means a system/global notification (`enrichment_failed` is the only type that currently uses this; it links to an app-wide admin surface, not a circle).

### 3.1 The STATE vs. EVENT split

The eight enum values fall into two families that the table treats completely differently:

| Family | Types | Cardinality |
|---|---|---|
| **STATE** | `review_queue_bursts`, `review_queue_duplicates`, `review_queue_location_suggestions`, `review_queue_enhancements` | At most **one live row** per `(userId, circleId, type)`, refreshed in place |
| **EVENT** | `upload_completed`, `enrichment_failed`, `workflow_run_completed`, `share_expiring` | One row per occurrence (or per counted-batch, §4), appended freely |

A STATE row is a *fact about the world right now* — "this circle currently has N pending duplicate groups" — and re-stating that fact should overwrite the previous statement of it, not add to it. An EVENT row is a *thing that happened* — "these 40 files finished uploading" — and each occurrence is discrete history worth keeping (or worth folding into a running tally, but never worth silently discarding).

### 3.2 Indexes

| Index | Serves |
|---|---|
| `(user_id, read_at)` | Unread-count query and the `status=unread`/`status=read` list filters |
| `(user_id, created_at DESC)` | Paginated list, newest first |
| `(user_id, dismissed_at)` | The `status=dismissed` filter and excluding dismissed rows everywhere else |
| `(dismissed_at, updated_at)` | The #248 retention purge's dismissed-row pass (§7) |
| `(read_at)` | The #248 retention purge's read-row pass (§7) |

### 3.3 The partial unique index — `notifications_review_queue_live_uniq_idx`

This is the single load-bearing constraint of the whole schema:

```sql
CREATE UNIQUE INDEX "notifications_review_queue_live_uniq_idx"
    ON "notifications" ("user_id", "circle_id", "type")
    WHERE "dismissed_at" IS NULL
      AND "circle_id" IS NOT NULL
      AND "type" IN (
          'review_queue_bursts',
          'review_queue_duplicates',
          'review_queue_location_suggestions',
          'review_queue_enhancements'
      );
```

Three things about this predicate are each doing real work:

- **`dismissed_at IS NULL`** is what makes it a *live-row* constraint rather than an all-time constraint. Dismissing a row removes it from the index's scope entirely, so a fresh live row for the same `(user, circle, type)` can be created afterward without colliding with the dismissed one — dismissal is a real end-of-life event for that occurrence of the state, not a flag on a row that still has to keep its slot forever.
- **`type IN (...)` naming exactly the four `review_queue_*` values** is what makes the four EVENT types exempt from this index altogether. They never match the predicate, so nothing stops `NotificationsService.emit()` from writing as many `upload_completed` rows as it is asked to — deduplicating those is a job for the write primitives (§4), not the schema.
- **`circle_id IS NOT NULL`** exists for a reason that is easy to get wrong: **Postgres unique indexes treat every `NULL` as distinct from every other `NULL`.** Without this clause, two different global (`circle_id = NULL`) `review_queue_bursts` rows for the same user would each satisfy the index (`NULL` is never equal to `NULL`, so there is no collision to reject), silently defeating the "at most one live row" guarantee for exactly the case a reader would least expect it to fail. In practice a `review_queue_*` row's `circleId` is always non-null — there is no "global" review queue, every review queue belongs to a circle — so this clause is not currently rejecting anything real. It is there anyway, to make that invariant an explicit, enforced property of the schema rather than an accidental one nobody would notice breaking.

This is raw-SQL-only schema drift, not representable in Prisma's schema DSL (Prisma has no syntax for a partial index). It follows the same precedent already established in this repo for `media_items_gallery_idx`, `media_items_map_locations_idx`, `people_circle_id_hidden_at_idx`, and the `review_run_items` partial uniques (see [review-runs.md §3.3](review-runs.md#33-exclusive-arc-integrity-constraints)) — documented as intentional drift in a comment directly above the `Notification` model in `schema.prisma`, since Prisma's own migration diffing cannot see it and would otherwise try to "fix" it away on a future `prisma migrate dev`.

## 4. The Three Write Primitives

`NotificationsService` (`apps/api/src/notifications/notifications.service.ts`) is the **only** code path in the codebase permitted to write a `notifications` row. It exposes three producer-facing methods, and the reason there are three — not one, not two — is that no single upsert shape can correctly serve every combination of "does this need deduplicating" and "what does deduplication mean here."

| Primitive | Applies to | Cardinality | Backed by |
|---|---|---|---|
| `emit()` | Per-occurrence EVENT types (`workflow_run_completed`, `share_expiring`) | One row per call, no dedup | Plain `create()` |
| `upsertState()` | STATE types (the four `review_queue_*`) | One LIVE row per `(userId, circleId, type)` | The partial unique index (§3.3) |
| `upsertCountedEvent()` | EVENT types that must NOT fan out (`upload_completed`, `enrichment_failed`) | One row that accumulates a `data.count`, optionally within a rolling window | A `pg_advisory_xact_lock` (no index behind it) |

### 4.1 `emit()` — the simple case

```ts
async emit(input: EmitNotificationInput): Promise<void>
```

A plain `create()`. Used exactly where fan-out is *correct*: a workflow run finishing, or a share approaching expiry, is a discrete, deliberate thing — a person started a run, or time passed on a specific share — and each occurrence genuinely deserves its own row and its own place in the user's history. Gated on `NotificationPreferencesService.isEnabled()` before the write (§8); a suppressed type simply writes nothing.

### 4.2 `upsertState()` — why it could not be a Prisma `upsert`

```ts
async upsertState(input: UpsertStateNotificationInput): Promise<void>
```

Prisma's typed `upsert()` requires a unique constraint it can see in the schema DSL. The guarantee here comes from a **raw-SQL partial unique index** (§3.3), which Prisma cannot represent, so there is no `@@unique` for `upsert()` to key off. The method is therefore hand-rolled as *update-live-first, create-if-none*:

1. `updateMany({ where: { userId, circleId, type, dismissedAt: null }, data: payload })`.
2. If that touched zero rows, `create()`.
3. If the `create()` throws Prisma error `P2002` (unique violation), a concurrent caller won the race between steps 1 and 2 — fold the payload into the row that now exists via the same `updateMany` from step 1, which is exactly what the loser of the race should have done anyway.

`readAt` is **deliberately left alone** by this method. Whether a refreshed count should re-mark an already-read row unread is not a decision the write path can make correctly on its own — see §6.

### 4.3 `upsertCountedEvent()` — the advisory lock, and why it exists

```ts
async upsertCountedEvent(input: UpsertCountedEventInput): Promise<void>
```

This is the third primitive because neither of the first two is safe for "fold repeated occurrences of an EVENT type into one row, without an index to lean on." `upsertState()`'s optimistic update-then-create-then-catch-P2002 works *because* a database constraint is standing behind it to catch the race. Event types have no such constraint — by design, the partial unique index's predicate lists only the four `review_queue_*` values, so two concurrent uploads landing in the same circle could both run "find the live row in this window" and both see nothing, and both `INSERT`, producing exactly the duplicate rows this primitive exists to prevent.

The fix is `pg_advisory_xact_lock(hashtext(lockKey))`, taken at the top of a transaction and held for the life of that transaction (released automatically on commit or rollback). An advisory lock is the right tool specifically because **no row has to exist for it to protect the find-or-create** — a row lock (`SELECT ... FOR UPDATE`) cannot serialize "check whether a row exists" against another transaction doing the identical check, because there is nothing to lock yet. `lockKey` is built from everything the subsequent lookup predicate filters on (`userId`, `type`, `circleId`, `matchData`), so two genuinely different aggregation keys can only ever share a lock by hash collision — harmless (a little needless serialization), never incorrect.

Two independent aggregation shapes are expressed by the same primitive, selected by whether `windowMs` is passed:

- **Rolling window** (`upload_completed`, 15 minutes): a live row whose `updated_at` falls outside the window is left alone and a *new* row is started. The anchor is `updated_at`, not `created_at`, so a steady multi-hour import keeps extending the same row (each write refreshes `updated_at`, which keeps it inside the window for the next write) rather than rolling over to a fresh row every 15 minutes — while an import that resumes next week correctly gets its own row.
- **Accumulate-until-dismissed** (`enrichment_failed`, `windowMs` omitted): the row grows forever until a user dismisses it. There is no time boundary because an unnoticed failure backlog should keep accumulating into the same row, not silently fork into a new one every 15 minutes while an admin isn't looking.

`matchData` (e.g. `{ jobType: 'auto_tagging' }`) adds a JSONB containment predicate (`data @> ...`) that further partitions live rows beyond `(userId, circleId, type)` — this is what keeps a `geocode` failure backlog and an `auto_tagging` failure backlog as two separate rows for the same admin.

The read-then-write inside the lock is deliberate rather than one clever `UPDATE ... RETURNING`: the row's `title` is a function of the *resulting* total (`buildTitle(count)`), with caller-side pluralization and interpolated names (a circle name, an uploader's display name) that would otherwise have to be assembled in SQL. Under the advisory lock, read-then-write is exactly as safe as a single atomic statement would be — nothing else can observe or mutate the aggregation key while the lock is held.

## 5. Producers

Five producers write through the three primitives above. Their volume guards are each shaped differently on purpose — every one of the four EVENT-producer shapes below solves a *different* fan-out problem, and using one shape everywhere would either under-aggregate or throw away information that matters.

| Producer | Type(s) | Trigger | Guard shape | Why this shape |
|---|---|---|---|---|
| `ReviewQueueReconcileService` (#246) | The four `review_queue_*` | Hourly cron, re-states from the real count | Upsert to ONE row per `(user, circle, type)` — 929 pending groups collapses to a `count: 929` on a single row | The queue's size is a fact re-derived from scratch every tick, not an incremental delta — a reconcile, not an event stream. See §5.1. |
| `UploadNotificationService` (#247) | `upload_completed` | `MediaService.createMedia`, per non-deduplicated item | 15-minute rolling window anchored on `updated_at`, race-safe via the advisory lock | A single upload is not interesting; a *burst* of them (a bulk import) is one interesting event, and "still uploading right now" vs. "uploaded a while ago, then uploaded again" are two different notifications worth separating. |
| `EnrichmentFailureNotificationListener` (#247) | `enrichment_failed` | `ENRICHMENT_JOB_SETTLED_EVENT`, `outcome === 'failed'` | One live row per `(admin, jobType)`, **no window** | A failure backlog is an operational debt that should keep growing until someone looks at it — a 15-minute window would silently fragment a multi-hour poison-pill incident into a dozen separate, easy-to-miss rows. |
| `WorkflowRunNotificationService` (#247) | `workflow_run_completed` | A run's `maybeFinalizeRun` reaching a terminal status | Per-run `emit()`, **except** `on_media_enriched` micro-runs are suppressed unless the recipient opted in (§8) | A run is a discrete, deliberate thing (someone clicked "run" or scheduled it) and deserves its own row — the fan-out risk here is not "too many runs" but "too many *automatic* runs", which is why the guard is a preference, not a window. |
| `ShareExpiringService` (#247) | `share_expiring` | Daily 9am cron, 7-day lead window | `data.notifiedFor` idempotency stamp, checked against **dismissed rows too** | The sweep runs every day and the lead window is 7 days wide, so the *same* share is a candidate on 7 consecutive days — the stamp, not a window, is what stops that from becoming 7 emits per share. |

### 5.1 Review-queue reconcile: upsert, not increment

`ReviewQueueReconcileService.reconcileAll()` is a **reconcile**, not an event producer — it does not react to a burst group being created or resolved. It runs hourly, reads `MediaService.computeReviewCounts(circleId)` once per circle (the exact same method behind `GET /api/media/dashboard` and `GET /api/media/review-counts`, so there is no second counting path that could drift from what the user sees on those surfaces), and re-states the truth for every eligible member:

- `count > 0` → `upsertState()` with `data: { count }` (or `{ count, countAtRead }` when a prior snapshot exists — see §6).
- `count <= 0` → `resolveStatesByIds()` on every live row of that type, so a drained queue's notification disappears rather than sitting at "0 pending" forever.

Audience is **collaborators and circle admins only** — `role IN ('collaborator', 'circle_admin')`. A `viewer` member cannot resolve or dismiss a review group (that needs `media:write` plus the per-circle collaborator role), so notifying them about a queue they cannot act on would be pure noise. This is enforced by the member query itself: `viewer` rows are simply never in the `userIds` list a circle's sweep fans `upsertState()` out across, so no row is ever created for one — the property is provable by reading the query, not merely something the reconcile happens not to do today.

A queue whose *feature flag* is off (e.g. `features.burstDetection = false`) is handled once, up front, for the whole sweep: every live row of that type across every user is resolved with a single `resolveStatesByType()` call, and circle paging is skipped entirely for that queue. Without this, a row created before the admin flipped the flag off would never be re-visited (the reconcile that would drain it to zero is exactly the thing that stopped running for it) and would nag forever pointing at a surface the admin turned off.

Feature flags are read **once per sweep**, not once per circle, through the cached `SystemSettingsService.getSettings()` call — a 500-circle deployment costs one settings read, not 500. Preferences for a circle's whole eligible membership are similarly primed in one `findMany` (`NotificationsService.primePreferences`) before the per-member fan-out, turning what would be up to 200 extra `user_settings` reads per circle into one.

### 5.2 Upload notifications: two recipients per upload, differently worded

`UploadNotificationService.recordUpload()` increments **two** rows per non-deduplicated upload: one for the uploader ("N items uploaded to Circle") and one for every *other* member ("Alice added N photos to Circle"). This deliberately differs from the review-queue audience rule above: browsing new photos needs no write access, so a `viewer` genuinely can act on "someone added photos" — the audience here is every circle member, regardless of role.

Circle membership and uploader display-name lookups are cached for 30 seconds (`LOOKUP_CACHE_TTL_MS`) — a bulk import calls this producer once per file, and without the cache that would be two extra reads per photo for values that essentially never change mid-import.

### 5.3 Enrichment failures: the hook is the settled event, not the terminal service directly

`EnrichmentFailureNotificationListener` subscribes to `ENRICHMENT_JOB_SETTLED_EVENT` with `outcome === 'failed'` — **not** a direct call from `EnrichmentTerminalService`. `EnrichmentTerminalService.emitSettled()` already fires exactly one settlement event per job, from precisely the two genuinely terminal branches (the rate-limit path only when `giveUp`, the normal-failure path only when `!shouldRetry`), and never on an intermediate retry or rate-limit deferral. Subscribing to that event gets terminal-only semantics for free, from the single chokepoint shared by the in-process worker *and* node-reported failures, with:

- no edit to `EnrichmentTerminalService`,
- no `NotificationsModule → EnrichmentModule` import (the event name is a plain string constant, not an injected provider), and
- no risk of re-deriving `giveUp`/`shouldRetry` at a second site that could drift from the original.

`lastError` is not carried on the event payload, so the listener re-reads the job row — safe, because the event fires *after* the terminal write, so the value read back is the final one. The listener also re-asserts `status === 'failed'` defensively: the event is only ever emitted from terminal branches, but a row an admin has since manually retried is no longer a permanent failure worth reporting.

Recipients are every active user holding the Admin system role (`userRoles.some(role.name === 'admin')` — the same predicate `DoctorService` uses for its admin-bootstrap check), cached for 60 seconds.

### 5.4 Workflow runs: the `on_media_enriched` suppression is opt-in, not hardcoded off

`on_media_enriched` "micro-runs" fire continuously during an import — roughly one rolling micro-run per workflow every 5 minutes, each terminating through the same `maybeFinalizeRun` path a manual run does. #247 shipped this suppressed unconditionally. #251 made it *re*-enableable per user via `user_settings.notifications.workflowMicroRuns` (absent ⇒ `false` — the one inverted default in the whole preferences namespace; see §8), without moving the suppression logic itself: the check still lives inside `WorkflowRunNotificationService`, evaluated *after* the run's recipient is resolved (the preference belongs to the person who would be notified, not to the run), and it is a **separate** gate from the `workflow_run_completed` type toggle that `NotificationsService.emit()` enforces on every call — both must pass for a micro-run to notify.

Recipient resolution has its own fallback ladder: a `scheduled` run's recipient is the workflow's `createdById` (falling back to `startedById`); every other trigger's recipient is `startedById` (falling back to `createdById`). A run with neither set is silently skipped — there is nobody to tell.

### 5.5 Expiring shares: keying the stamp on the expiry value, not a boolean

`ShareExpiringService.sweep()` runs daily and looks 7 days ahead, so the same share is a legitimate candidate on 7 consecutive days. The idempotency check (`alreadyNotified`) is a JSONB containment query for `{ shareId, notifiedFor }` where `notifiedFor` is the share's `expiresAt` **at the moment of that emit**, and — the detail that matters — it checks **dismissed rows, not only live ones**. If it only checked live rows, a user who dismisses today's warning would be notified again tomorrow about the exact same expiry, defeating the point of dismissing it. Keying on the expiry *value* rather than a plain boolean "already notified" flag is what makes a rescheduled share correct automatically: if the owner pushes `expiresAt` further out, the old stamp no longer matches the new value, and a fresh warning is (correctly) allowed — the later date really is new information the owner has not yet been told about.

## 6. The `countAtRead` Contract

The re-unread rule is the one piece of behavior split across two files that must agree exactly, so it is worth stating as a contract rather than as two independent descriptions.

**`NotificationsService.markRead()` / `markAllRead()`** (the read side): when a row's `data` contains a `count` key, marking it read snapshots the *current* count into `data.countAtRead` via `jsonb_set`. This snapshot is refreshed on every read, including a repeat read of an already-read row — an explicit "I've seen it" gesture should always record what is on screen *right now*, not what was on screen the first time.

**`ReviewQueueReconcileService.reconcileCircle()`** (the write side): on every tick, for every live STATE row it is about to refresh, it reads the *existing* row's `countAtRead` (if any) and carries it forward unmodified into the new `data` payload — `upsertState()` replaces `data` wholesale, so *not* carrying it forward would silently disable the re-unread rule for that row until its next read. Then, and only then, does it decide whether to re-mark the row unread:

```
re-unread  ⇔  row was previously read  AND  countAtRead is a number  AND  count > countAtRead
```

Every clause exists to rule out a specific wrong behavior:

- **strict `>`, never `>=`**: a queue that shrank or stayed exactly the same since the user last looked must never be re-flagged. Only genuine growth past what was acknowledged counts as new work.
- **a missing snapshot is treated as "already seen"**, not as "unknown, so re-flag defensively.** A legacy row (written before this contract existed) or a hand-written row has no `countAtRead` at all. Treating that absence as "growth, please re-flag" would re-nag every such row on *every single hourly tick forever* — the conservative reading is the only one that converges.
- **never on a row that has never been read**: the rule only fires for `existing.readAt !== null`. An unread row is already unread; there is nothing for the reconcile to escalate.

## 7. Retention

`NotificationPurgeHandler` (a global `notification_purge` enrichment job, enqueued nightly by `NotificationPurgeTask`, mirroring `JobHistoryPurgeTask`'s cadence, dedup guard, and 5,000-row batching) deletes two, and only two, categories of row:

```
(a) dismissed_at IS NOT NULL AND dismissed_at < now() - retentionDays
(b) read_at      IS NOT NULL AND read_at      < now() - retentionDays
    AND dismissed_at IS NULL   -- keeps the two passes strictly disjoint
```

**Unread rows are never deleted by age alone, under any circumstances.** This is the deliberate point of departure from `job_history_purge`, and it is worth being explicit that it is *not* an oversight to be "fixed" later by adding a `created_at` rule:

- `job_history_purge` deletes purely by `finishedAt` age because an `enrichment_jobs` row is a machine artifact nobody is waiting on — its only audience is an operator debugging something, and old rows are just noise past a certain point.
- A notification is the opposite kind of row. An *unread* one is, by definition, something the user has not yet dealt with. Silently deleting it on a timer would defeat the entire feature — the user would lose exactly the items the feature exists to hold onto for them.

So it is **read/dismissed state** — an action the user took — that makes a row eligible for eventual deletion, and age only decides how long *after* that action the row is kept around as history. A user who never opens the bell keeps their entire backlog indefinitely; that is accepted, not a bug, and it is bounded elsewhere: `upsertState()` caps STATE rows at one per `(user, circle, type)` and `upsertCountedEvent()` folds repeated EVENT occurrences into one growing row, so "never purged while unread" cannot become *unbounded* growth even for a user who ignores the bell forever — it can only ever be, at most, one row per notification type per circle they belong to.

The two passes run as separate range scans (one per index, `(dismissed_at, updated_at)` and `(read_at)` respectively) rather than one `OR`-combined predicate, so each stays a clean single-column scan. The `dismissedAt: null` clause on pass (b) also resolves the one case where the two rules could otherwise disagree: dismissal always implies read and backfills `read_at` when it was null, so `dismissed_at >= read_at` is always true for a dismissed row — and a row read long ago but dismissed only yesterday should be retained counting from its *dismissal* (the user's most recent interaction with it), not deleted on the strength of the older read. Excluding dismissed rows from pass (b) is therefore always the conservative reading of the two rules, never the looser one.

`notifications.purgeEnabled` (default `true`) and `notifications.retentionDays` (default 30) are plain system settings, checked both by the nightly task (to decide whether to enqueue at all) and by the handler itself (in case a manual retry from `/admin/settings/jobs` re-runs an already-queued row after the setting changed) — the same double-check `JobHistoryPurgeHandler` performs for `jobs.history.purgeEnabled`.

## 8. Preferences (#251)

Per-type preferences live in the existing `user_settings.value.notifications` JSONB namespace — no new table, no new endpoint, no new permission, no migration. `NotificationPreferencesService` is the sole server-side reader.

### 8.1 Absence means enabled — and why that has to hold structurally

An absent namespace, an absent `enabled`, or an absent per-type key inside `types` **all resolve to `true`**:

```ts
const enabled = value?.enabled !== false;          // not `=== true`
types[type] = enabled && stored[type] !== false;   // not `=== true`
```

The `!== false` framing (rather than `=== true`) is what makes this hold for a key the schema does not even know about yet. Two properties fall out of it:

- **The feature shipped with no migration.** Every existing `user_settings` row has no `notifications` namespace at all, and the absent-means-enabled rule means nobody was silently muted the moment this shipped.
- **A `NotificationType` added in a future release is opt-out, not opt-in, for existing users.** `resolveNotificationPreferences` enumerates `Object.values(NotificationType)` at call time, so a sixth enum value with no corresponding stored key defaults to enabled for every user who has never touched their preferences — exactly the same posture a brand-new user gets. Had the schema instead required an explicit `true`, every existing user would be silently opted OUT of any new notification type until they happened to visit the settings page.

### 8.2 The one inverted default

`workflowMicroRuns` is the single exception: absent means `false`. It has to be, because #247 shipped the `on_media_enriched` suppression unconditionally *before* #251 introduced the ability to turn it back on (§5.4) — the un-set state has to keep matching the behavior that already shipped, or every existing user would suddenly start getting micro-run spam the moment #251 deployed. This inversion is implemented in `resolveNotificationPreferences()`, deliberately **not** in the Zod schema — the schema keeps one uniform "every field optional, no default" rule, and the one place where "absent" does not mean "on" is documented and enforced in exactly one function.

### 8.3 Gated at all three write paths

The task description frames this as "three write paths, not two" deliberately — the preference gate must be present at `emit()`, `upsertState()`, **and** `upsertCountedEvent()`, and it is checked inside `NotificationsService`, not inside any producer:

- `emit()` / `upsertState()` check `isEnabled(userId, type)` before doing anything else.
- `upsertCountedEvent()` checks it **before opening the transaction**, specifically so a suppressed type never takes the advisory lock (§4.3) it would otherwise contend for — there is no reason to serialize on a key that is about to write nothing.
- A suppressed **STATE** type's gate has an extra consequence beyond "write nothing": `upsertState()` returning early means the reconcile's periodic refresh also writes nothing for that type, so the user's existing live rows of that type are never resurrected by the next hourly tick. That is exactly why dismiss-on-disable (§8.4) exists — without it, a STATE type turned off would leave its already-existing rows stuck forever, since the only process that would ever resolve them to zero (the reconcile) has itself stopped touching that type for that user.

Because the gate lives in the service and not in any producer, no producer — present or future — can forget to check it. A new producer written against `NotificationsService` inherits the gate automatically simply by calling one of the three primitives.

### 8.4 Dismiss-on-disable is transactional with the settings write

Turning a type off does more than stop future rows: `UserSettingsService.writeSettings()` computes the set of types the *resulting* preferences state suppresses (`disabledNotificationTypes(validated.notifications)` — types disabled **after** the write, not merely the ones newly disabled **by** it, which is a self-healing property: dismissing an already-off type is a no-op since the gate already means it has no live rows, so no "before" snapshot is ever needed) and, when that set is non-empty, opens a database transaction that does both the settings write and `NotificationsService.dismissTypesForUser(userId, disabled, tx)` atomically. If either half fails, both roll back — a settings save that succeeded but left the dismissal half-applied would leave the user with stale rows for a type they believe they turned off, which is exactly the inconsistency a shared transaction exists to prevent. The transaction is opened **only** when something is actually being suppressed, so the overwhelmingly common save (a theme change, a table layout) stays the single plain statement it always was.

The decided product behavior, stated in the code's own comment and worth restating here because it is easy to get backwards: turning a type off clears the notifications already on screen for it, not merely new ones going forward. The user's intent when flipping a toggle off is "stop showing me this" in the fullest sense, not "stop showing me this except for the eleven that are already there."

The preference cache is invalidated **after** the write returns (never inside the transaction, which may still roll back), so a re-enabled type starts producing notifications again on the very next write instead of waiting out the cache TTL.

### 8.5 The fail-open gate

Any read failure inside `NotificationPreferencesService.resolve()` — the database being unreachable, a malformed hand-edited JSONB blob — resolves to "everything enabled," with a logged warning, never to "everything suppressed." The stated reasoning: a preferences lookup must never be the reason a notification silently disappears. The failure mode of a gate like this has to be over-notifying, never under-notifying — an extra notification is an annoyance a user can dismiss; a missing one is information genuinely lost.

## 9. Frontend

### 9.1 One refcounted module-level store, not a context provider

`useNotifications()` (`apps/web/src/hooks/useNotifications.ts`) is backed by module-scope state, not `useState` + `useEffect` inside the hook itself. Three surfaces need the exact same unread count and item list — the AppBar bell (#249), the sidebar badge (#250), and the `/notifications` page's mutations (#250) — and if each surface ran its own `useState` + `setInterval`, they would each start an independent 60-second poller and drift out of sync with each other after any mutation (one surface's optimistic update would not be visible to the others until their own next poll).

A React Context provider would also solve the "one shared state" problem, but at a real cost the module store avoids: it would have to be threaded through `App.tsx` and every test wrapper, and a component that forgot to render inside the provider would crash the tree rather than degrading. The module store needs neither — `useNotifications()` is just a `useSyncExternalStore` subscriber against state that lives independently of any component tree, so nothing can forget to "wrap" anything.

The store is **reference-counted** (`enabledSubscribers`): the polling timer starts when the first subscriber that opts in (`enabled: true`, the default) mounts, and stops when the last one unmounts. This is what keeps the login screen, and any test that never renders the bell, from issuing a single background request. Polling additionally pauses outright — the interval is torn down, not merely skipped — while `document.visibilityState === 'hidden'`, and resumes with an immediate refetch on `visibilitychange`/`focus`.

The panel's item list is fetched on demand (`refreshList()`, called when the bell popover opens), never polled — a closed bell therefore costs exactly one small integer request per minute, not an item-list request too.

### 9.2 Circle-switch-before-navigate

Review-queue notification links (`/bursts`, `/duplicates`, `/location-suggestions`, `/enhancements`) are **circle-agnostic routes** — they render whichever circle is currently active, not a circle baked into the URL. Tapping a row for a circle that is not the active one would therefore land the user on the right *page* showing the *wrong circle's* data unless something switches the active circle first.

Both `NotificationPanel.handleOpenNotification` (#249) and `NotificationsPage.handleOpen` (#250) implement the identical fix: call `CircleContext.setActiveCircle(notification.circleId)` and `navigate(notification.link)` in the same event handler. `setActiveCircle` updates its React state synchronously before its first `await` (the settings PATCH that persists `activeCircleId` happens after), so both updates land in the same render batch and the destination route mounts already scoped to the new circle — there is no need to await the settings round-trip before navigating.

This switch is guarded by a **membership check**: `circles.length === 0 || circles.some((c) => c.id === notification.circleId)`. A notification can outlive the user's access to its circle (they were removed, or the circle was deleted), and blindly calling `setActiveCircle` with a stale id would persist an `activeCircleId` that resolves to no circle at all — leaving the whole app stuck in a "no active circle" state with no obvious way out. `circles.length === 0` is deliberately read as "the circle list has not finished loading yet," not "the user is a member of nothing" — every user always has at least their personal circle, so an empty list can only mean `CircleContext`'s own initialization is still in flight, and the switch is allowed to proceed optimistically in that case rather than being blocked by a load race.

### 9.3 The inbox page

`/notifications` (`NotificationsPage.tsx`) is the DataTable-based full inbox: three status tabs (Unread / All / Dismissed, mirrored to `?status=` in the URL for shareability), a circle filter via the DataTable's own filter bar, row actions (Open / Mark as read / Dismiss), and the two bulk operations. It deliberately runs **no timer of its own** — the unread count and every mutation still go through the shared `useNotifications` store (so the badge cannot drift from what the page just did), and the page's own rows are fetched on demand through the separate `useNotificationList` hook, which owns pagination/filtering but no polling. A user sitting on this page therefore still issues exactly one background request per minute total (the badge count), not two.

Both bulk actions (`Mark all as read`, `Dismiss all`) confirm above `BULK_CONFIRM_THRESHOLD` (25) affected rows, mirroring the gallery's own bulk-action convention. The count behind that confirmation is not guessed — the page issues a `pageSize: 1` list call under exactly the scope the bulk action will use and reads `meta.totalItems`, so the confirmation dialog states a real number and a genuinely empty scope is caught (and reported) before any write is attempted.

## 10. RBAC

Every notification route carries a bare `@Auth()` — authenticated, any role, **no new permission**. This is a deliberate application of the same least-privilege rationale as `GET /api/features`: a notification is inherently personal, and every route is already scoped to the caller's own `userId` (`@CurrentUser('id')`), so there is nothing an Admin-gated permission scope would be protecting that the `userId` scoping does not already protect.

The bare `@Auth()` decorator is **not optional** — this codebase has no global `APP_GUARD`, so routes are unauthenticated by default, and an undecorated handler in this controller would be publicly reachable.

**Every single-row route resolves a cross-user id to `404`, never `403`.** `markRead`, `dismiss`, and `remove` all scope their `WHERE` clause by both `id` **and** the JWT's `userId` in one query — a notification id that exists but belongs to a different user is therefore indistinguishable, from the response alone, from an id that does not exist at all. This is a deliberate enumeration-resistance choice, matching the public-share `404` policy documented elsewhere in this codebase: a `403` would confirm to a client that the id is *valid but not theirs*, leaking the existence of another user's row; a `404` reveals nothing.

## 11. Module Graph and the No-Imports Rule

`NotificationsModule` (`apps/api/src/notifications/notifications.module.ts`) **imports nothing** — not `PrismaModule` (which is `@Global` and therefore needs no import), and, more importantly, none of the modules that own producers. This is a hard architectural rule, not an incidental fact about the current codebase, and it is the reason the notifications feature is split across two NestJS modules rather than one:

- `NotificationsModule` is **imported by** producers — `MediaModule` (for `UploadNotificationService`), `WorkflowsModule` (for `WorkflowRunNotificationService`), and `SettingsModule` (`UserSettingsService` needs `NotificationsService` for dismiss-on-disable, §8.4) — so every producer edge points **into** it.
- If `NotificationsModule` ever imported anything that transitively reaches back to `MediaModule` or `WorkflowsModule`, that edge would close a cycle: `MediaModule → NotificationsModule → (something) → MediaModule`.

This is exactly why `ReviewQueueReconcileService` (#246), which genuinely needs `MediaService.computeReviewCounts`, lives in a **separate** module, `NotificationsReconcileModule`, rather than inside `NotificationsModule` itself. `NotificationsReconcileModule` is free to import `MediaModule`, `SettingsModule`, and `EnrichmentModule` because none of those modules import it back — the edges all point one way:

```
NotificationsReconcileModule ──▶ MediaModule ──▶ NotificationsModule
NotificationsReconcileModule ──▶ EnrichmentModule
                                  WorkflowsModule ──▶ NotificationsModule
```

`NotificationsReconcileModule` hosts every #246/#247/#248 piece that nobody else injects — the review-queue reconcile itself, the share-expiring sweep, the enrichment-failure event listener (which subscribes to a plain event-name string constant rather than injecting anything from `EnrichmentModule`, so it adds no import edge of its own), and the retention purge handler/task. It deliberately does **not** import `WorkflowsModule` — the workflow-run producer needs no extra module beyond `PrismaService` + `NotificationsService`, so it is hosted directly inside `NotificationsModule` alongside `UploadNotificationService`, the other #247 producer another module has to *inject* rather than merely trigger via a cron or an event.

`NotificationPreferencesService` reads the `notifications` namespace out of `user_settings` using `PrismaService` **directly**, rather than going through `SettingsModule`'s `UserSettingsService` — deliberately, because `SettingsModule` now imports `NotificationsModule` (for the dismiss-on-disable write, §8.4), so importing `SettingsModule` back from inside `NotificationsModule` would be precisely the cycle this whole section exists to prevent. The net edge is one direction only: `SettingsModule → NotificationsModule`.

A future contributor adding a sixth producer should read this section before reaching for an import: if the new producer needs a service from a module that is not already safely one-directional with `NotificationsModule`, the new code almost certainly belongs in `NotificationsReconcileModule` (or a further sibling module), not inside `NotificationsModule` itself.

## 12. API Endpoints

All routes are `authenticated, any role` (§10); none require a permission scope.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/notifications?status=&circleId=&page=&pageSize=` | Paginated list, newest first. `status` ∈ `unread`\|`read`\|`all`\|`dismissed` (default `all`); dismissed rows are excluded from every value except `dismissed` itself. |
| `GET` | `/api/notifications/unread-count` | `{ count }` — live, never-read rows across every circle. Server-cached ~2s per user. |
| `POST` | `/api/notifications/read-all` | Body `{ circleId? }` (fully optional, including a bodyless POST). Marks every live unread row read, optionally scoped to one circle. |
| `POST` | `/api/notifications/dismiss-all` | Body `{ circleId? }`. Dismisses every live row, optionally scoped to one circle. Dismissing implies read. |
| `POST` | `/api/notifications/:id/read` | Idempotent. Snapshots `data.countAtRead` when `data.count` exists (§6). |
| `POST` | `/api/notifications/:id/dismiss` | Idempotent; implies read. |
| `DELETE` | `/api/notifications/:id` | Hard-delete one row. |

Every `:id` route is `404`, not `403`, on a cross-user id (§10). `read-all`/`dismiss-all` are declared **before** the `:id` routes in the controller to avoid Nest treating `read-all`/`dismiss-all` as a `:id` value.

## 13. Known Gaps and Limitations

Stated honestly, because each of these is a real, currently-accepted tradeoff rather than an oversight nobody noticed:

- **A member demoted to `viewer` (or removed from the circle) keeps their existing review-queue row until they dismiss it or the retention purge reaps it.** §5.1's reconcile query scopes its live-row lookup by the *current* eligible membership (`userIds` for `role IN ('collaborator', 'circle_admin')`), so a user who drops out of that set is simply outside the query the reconcile runs next — their now-stale row is neither refreshed nor resolved by the sweep. It is not resurrected (the row just stops being touched at all), and it is not actively cleaned up either. This is an accepted consequence, documented at the point in the code where the decision is made, in exchange for the reconcile query staying a single `userId IN (...)` scan against the `(user_id, dismissed_at)` index rather than a per-row circle-membership re-check on every tick.
- **"A `viewer` never gets a review-queue row" is only provable as a property of the query shape, not exercised by an integration test that actually seeds a `viewer` and confirms no row appears.** The guarantee described in §5.1 is real and structural (a `viewer`'s `userId` is mechanically absent from the list `upsertState()` is fanned across), but nothing in the current test suite spins up a real circle with mixed roles against a live Postgres to assert it end-to-end — the property is verified by reading the `ELIGIBLE_ROLES` filter in `review-queue-reconcile.service.ts`, not by a passing test that would fail if a future edit accidentally widened it.
- **The advisory-lock serialization in `upsertCountedEvent()` (§4.3) is not exercised by any test that runs two genuinely concurrent transactions against a real Postgres instance.** `notifications.service.spec.ts` mocks `PrismaService` entirely, asserting the *shape* of the SQL (`pg_advisory_xact_lock(hashtext(...))`, the JSONB containment clause, the rolling-window clause) rather than its *effect* under real concurrency. The race this primitive exists to prevent — two uploads landing in the same 15-minute window at the same instant — is therefore currently a code-review-verified property, not a load-tested one.
- **The JSONB containment queries (`data @> ...::jsonb`, used by `upsertCountedEvent`'s lookup and `ShareExpiringService.alreadyNotified`) are likewise never run against a real Postgres in the test suite**, for the same reason — a mocked Prisma client cannot evaluate a raw SQL fragment's actual semantics, only record that it was asked to run one with a particular shape.

None of the above is a defect in the shipped behavior as far as manual verification and code review can establish; they are gaps in what the *automated test suite* can catch if a future change silently breaks one of these properties, and are recorded here so a future contributor does not mistake "no test failed" for "this is covered."

## 14. Implementation Notes: Where the Build Diverged From the Issues

The issues that scoped this epic described the shape of the feature; the shipped code made a handful of decisions that sharpen or extend what the issue text said. Recorded here so nobody re-derives them from scratch or "fixes" the code back toward the original text:

- **Preference enforcement covers three write paths, not two.** #251's own framing (and this document's task list) emphasizes "`emit()` and `upsertState()`," but the shipped gate is in fact present at all **three** primitives, including `upsertCountedEvent()` — checked before the advisory-lock transaction even opens (§8.3), specifically so a suppressed counted-event type never contends for a lock it has no reason to take.
- **The enrichment-failure hook point is `ENRICHMENT_JOB_SETTLED_EVENT`, not a direct call from `EnrichmentTerminalService`.** The natural first instinct for "notify on permanent failure" is to add a call inside the terminal service itself. The shipped design instead subscribes to the pre-existing settlement event (§5.3), which gets the correct terminal-only semantics for free from a chokepoint already shared by the in-process worker and node-reported failures, at the cost of one extra job-row re-read for `lastError` (which the event does not carry) — a deliberate trade of a cheap extra read against a much simpler, cycle-free module graph and zero risk of re-deriving retry logic at a second site.
- **`upsertCountedEvent()` is a genuinely distinct third primitive, not a variant of `upsertState()`.** The child issues describe "state" and "event" notifications as the two families; the code introduces a third *shape* within the event family specifically because `emit()`'s one-row-per-occurrence semantics are correct for `workflow_run_completed`/`share_expiring` but would be catastrophic for `upload_completed` (one row per file in a 4,000-file import) or `enrichment_failed` (one row per job in a 400-job poison-pill incident). This is documented in the code itself as "the third producer primitive," and this spec treats it as a first-class part of the design (§4.3) rather than a minor implementation detail.
- **The workflow micro-run suppression from #247 was not removed or replaced by #251 — it was made overridable in place.** #251's preferences layer adds the opt-in switch and its storage; the suppression logic itself (§5.4) still lives inside `WorkflowRunNotificationService`, unchanged in location, with the preference check added as an additional condition alongside it rather than as a replacement for it.

## 15. Future Work

| Capability | Notes |
|---|---|
| Integration coverage for the advisory-lock race and the JSONB containment queries against a real Postgres | Currently unit-tested only against a mocked Prisma client (§13); would need a live-database test harness the way, e.g., the pgvector-backed face-matching tests do |
| Resolve or surface a demoted/removed member's stale review-queue row proactively | Currently relies entirely on manual dismissal or the retention purge (§13); a targeted resolve on membership change (rather than waiting for the next reconcile or the purge) would close the gap without changing the reconcile's per-tick cost |
| Real-time delivery (WebSocket/SSE push) instead of 60-second polling | The current design deliberately does not attempt this — see the module-level store's own rationale (§9.1) for why polling with visibility-aware pause/resume was chosen for v1 |
| A dedicated admin settings panel for `notifications.retentionDays`/`notifications.purgeEnabled` | Currently editable only via the generic system-settings JSON write path, the same gap `reviewRuns.runHistoryRetentionDays` has (see [review-runs.md §10](review-runs.md#10-retention-and-stale-run-sweep)) |

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | August 2026 | AI Assistant | Initial specification, documenting the shipped epic #240 implementation across all eight child issues (#244–#251): the STATE/EVENT data model and its partial unique index, the three producer write primitives, all five producers and their differently-shaped volume guards, the `countAtRead` re-unread contract, the age-vs-state retention asymmetry with `job_history_purge`, the absent-means-enabled preferences model and dismiss-on-disable, the shared frontend polling store and circle-switch-before-navigate pattern, RBAC, the module-graph acyclicity constraint, and known test-coverage gaps |

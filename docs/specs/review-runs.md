# Shared Review-Run Model — Bursts, Duplicates, Location Suggestions

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [The Problem This Replaces](#2-the-problem-this-replaces)
3. [Data Model](#3-data-model)
4. [Duplicate-Group Confidence Becomes Persisted](#4-duplicate-group-confidence-becomes-persisted)
5. [Job Types](#5-job-types)
6. [Subject-Strategy Split](#6-subject-strategy-split)
7. [Run Lifecycle State Machine](#7-run-lifecycle-state-machine)
8. [Concurrency Guard](#8-concurrency-guard)
9. [Cancellation Semantics](#9-cancellation-semantics)
10. [Retention and Stale-Run Sweep](#10-retention-and-stale-run-sweep)
11. [Migration From `location_suggestion_runs`](#11-migration-from-location_suggestion_runs)
12. [API Endpoints](#12-api-endpoints)
13. [RBAC](#13-rbac)
14. [Frontend](#14-frontend)
15. [Implementation Notes and Gotchas](#15-implementation-notes-and-gotchas)
16. [Future Work](#16-future-work)

---

## 1. Overview and Goals

Three review-queue bulk actions already ran as **async runs** before this change (a run record → an `evaluate` job → chunked `execute_batch` jobs → progress polling → cancel): Media Workflow Automation (`workflow_runs`), Empty Trash at Scale (`trash_empty_runs`, [archive-trash.md §10](archive-trash.md#10-empty-trash-at-scale-async-run-model)), and Location Suggestion bulk accept/reject (`location_suggestion_runs`, [location-inference.md §9](location-inference.md#9-bulk-acceptreject-at-scale) as originally shipped). The Burst and Duplicate review queues' four `*-by-threshold` endpoints did not get this treatment — they ran **synchronously in the request**, capped at 500 groups (`MAX_THRESHOLD_RESOLVE`), with the web UI hiding the cap behind a client-side auto-loop (up to 100 sequential round-trips) whose only feedback was a self-overwriting Snackbar. No item counts, no progress bar, no cancel, nothing survived a reload.

Issue #190 rebuilds all of it on **one shared run model and one shared frontend progress component**:

1. **One `review_runs` / `review_run_items` table pair** backs all three review queues — bursts, duplicates, **and** location suggestions. The location-suggestion-specific `location_suggestion_runs` / `location_suggestion_run_items` tables and their three enums were migrated into it (run UUIDs preserved) and dropped.
2. **`duplicate_groups.confidence` becomes a persisted column** (§4), so the threshold filter for duplicates runs in SQL exactly like bursts already did, and the 500-group cap disappears entirely.
3. **One shared frontend run-progress component** (`RunProgressPanel`, §14), adopted by all four run pages (workflow, trash-empty, burst/duplicate/location-suggestion — now unified under one `ReviewRunPage`).

Outcome: every bulk review action across bursts, duplicates, and location suggestions is cancellable, uncapped, resumable across reloads, and reports live `matched`/`processed`/`succeeded`/`failed`/`skipped` counts through one API and one UI.

This document is the canonical reference for the shared model. Feature-specific behavior (what a resolve/dismiss/accept/reject actually *does* to a burst group, duplicate group, or location suggestion) stays documented in [burst-detection.md](burst-detection.md), [duplicate-detection.md](duplicate-detection.md), and [location-inference.md](location-inference.md) — each of those specs now points back here for the run architecture itself.

## 2. The Problem This Replaces

Burst and duplicate detection's four threshold endpoints (`bulk/resolve-by-threshold`, `bulk/dismiss-by-threshold` on both `/api/media/bursts` and `/api/media/duplicates`) executed entirely inside the HTTP request: load up to 500 pending groups, resolve or dismiss each one in its own transaction, return an aggregate count. Two concrete failure modes motivated the rebuild:

- **Opaque and capped.** A circle with more than 500 pending groups needed the button clicked repeatedly (or the web client's auto-loop, up to 100 iterations) to fully drain the queue, with no persistent progress indicator and no way to cancel mid-drain. A page reload lost all visibility into how far the operation had gotten.
- **Duplicate confidence made this worse.** `DuplicateService.computeGroupKind` computed confidence (`maxSim`, the tightest-pair CLIP cosine similarity) **at read time** via a `$queryRaw` scan — there was no persisted column to filter or order by. The threshold endpoints therefore had to load an unordered, unfiltered candidate set (capped at 500) and compute+filter `maxSim` in application code for each candidate. On a circle with more than 500 pending duplicate groups, the candidate query's lack of an `ORDER BY` and lack of a confidence predicate meant a caller could re-scan the same 500 below-threshold candidates on every call and never reach the eligible ones — a real correctness bug, not just a UX gap.

Both problems disappear once duplicate confidence is a persisted, indexed column (§4) and every threshold action runs through the same evaluate → chunked-execute → poll → cancel engine already proven by Workflows, Empty Trash, and the original Location Suggestion runs.

## 3. Data Model

New Prisma models, migration `20260726010000_review_runs`.

```prisma
enum ReviewRunSubject     { burst_group duplicate_group location_suggestion }
enum ReviewRunAction      { resolve_archive resolve_trash dismiss accept reject }
enum ReviewRunStatus      { evaluating running completed completed_with_errors failed cancelled }
enum ReviewRunItemStatus  { matched processing applied failed skipped }
```

### 3.1 `review_runs`

One row per bulk review action started against one queue in one circle.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `circle_id` | UUID | FK → `circles`, cascade delete |
| `subject_type` | `ReviewRunSubject` | Which review queue this run belongs to |
| `action` | `ReviewRunAction` | `resolve_archive` \| `resolve_trash` (bursts/duplicates) \| `dismiss` (bursts/duplicates) \| `accept` \| `reject` (location suggestions) |
| `threshold` | Int | 0–100 snapshot of the confidence floor used at evaluation time; later changes to the underlying admin-configured default never affect an already-created run |
| `status` | `ReviewRunStatus` | `evaluating` (default) → `running` → a terminal status |
| `matched_count` / `processed_count` / `succeeded_count` / `failed_count` / `skipped_count` | Int, default 0 | Progress counters, all populated/incremented by the two job handlers (§5) |
| `started_by_id` | UUID? | FK → `users`, `SetNull` |
| `last_error` | Text? | Set when the run transitions to `failed` |
| `created_at` / `updated_at` / `started_at` / `finished_at` | Timestamptz | |

`@@unique([id, subjectType])` exists purely as the FK target for `review_run_items`' composite type-agreement constraint (§3.3) — it is not a natural business key. Indexes: `(circle_id, subject_type, status)` (the per-queue concurrency guard, §8) and `(status, updated_at)` (retention + stale-run sweep, §10).

### 3.2 `review_run_items`

One row per subject (burst group / duplicate group / location suggestion) matched by a run.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `run_id` | UUID | FK → `review_runs`, cascade delete |
| `subject_type` | `ReviewRunSubject` | Denormalized from the parent run |
| `burst_group_id` | UUID? | FK → `burst_groups`, cascade delete |
| `duplicate_group_id` | UUID? | FK → `duplicate_groups`, cascade delete |
| `location_suggestion_id` | UUID? | FK → `location_suggestions`, cascade delete |
| `status` | `ReviewRunItemStatus` | `matched` (default) → `processing` → a terminal status |
| `error` | Text? | Set when `status = 'failed'` |
| `created_at` / `updated_at` | Timestamptz | |

Exactly one of the three nullable FK columns is populated per row — an **exclusive arc**, matching `subject_type`. This is the same pattern already shipped for `media_shares` (`targetType` enum + `mediaItemId`/`albumId` XOR CHECK, migration `20260628130000_add_media_shares`) — established in-repo precedent, not a new idea.

### 3.3 Exclusive-Arc Integrity Constraints

Prisma's schema DSL cannot express CHECK constraints, composite FKs, or partial unique indexes, so all of the following are hand-authored raw SQL in the migration (documented as intentional schema drift in `schema.prisma`'s `ReviewRunItem` comment, the same precedent as `media_items_gallery_idx` / `media_items_map_locations_idx`):

| Guarantee | Mechanism | Why it exists |
|---|---|---|
| No dangling subject reference | Three real FKs, each `ON DELETE CASCADE` → `burst_groups` / `duplicate_groups` / `location_suggestions` | A group or suggestion that vanishes mid-run (dismissed by hand and cleaned up, cascaded away with its media item, etc.) must not leave an orphaned item row with nothing to explain what it pointed at |
| Exactly one subject per row | `CHECK (num_nonnulls(burst_group_id, duplicate_group_id, location_suggestion_id) = 1)` | Enforces the exclusive arc at the database level — impossible to insert a row with zero or two populated subject columns |
| The populated column matches `subject_type` | `CHECK ((subject_type = 'burst_group') = (burst_group_id IS NOT NULL))`, repeated for the other two subjects | Prevents a row whose `subject_type` disagrees with which FK column is actually set — the generic handlers trust `subject_type` to pick the right column without re-deriving it from which column is non-null |
| An item can never belong to a run of a different subject type | Composite FK `(run_id, subject_type) REFERENCES review_runs(id, subject_type) ON DELETE CASCADE`, on top of the plain `run_id` FK | Closes a class of bug where a strategy bug (or a hand-crafted insert) could attach a duplicate-group item to a burst run |
| Idempotency anchor per subject | Three **partial** unique indexes: `UNIQUE (run_id, burst_group_id) WHERE burst_group_id IS NOT NULL`, and the equivalent for the other two columns | Postgres treats NULLs as distinct in a unique index, so each partial index only constrains rows of its own subject type. This is what makes `createMany({ skipDuplicates: true })` in the evaluate handler (§5) safe to retry — a re-materialization attempt after a crash can never double-insert the same subject into the same run |
| Items die with their run | The `run_id` cascade above; `review_runs.circle_id` cascades from `circles` | Deleting a circle or a run cleans up every item row automatically |

**Execution order in the migration is deliberate:** (1) create the enums and bare tables (PKs only, no FKs/CHECKs); (2) copy `location_suggestion_runs`/`location_suggestion_run_items` forward (§11); (3) *then* add the full FK/CHECK/index constraint set, so the copied data is validated by the real constraints with no `NOT VALID` escape hatch; (4) drop the two superseded tables and their enums.

### 3.4 Cascade-vs-Counters Consequence

**When a subject is deleted mid-run, its item row disappears rather than lingering.** A `DuplicateGroup` dropping below the two-member floor via `recomputeGroupMeta`, a `LocationSuggestion` cascading away with its media item, a burst group cleaned up by an unrelated process — any of these takes the matching `review_run_items` row with it via the cascade FKs in §3.3.

This is deliberate, and it has a consequence worth internalizing: **`processedCount` may legitimately end up below `matchedCount`.** The execute-batch handler's finalize check (§7) keys off *"no rows remain in `matched` or `processing`"* — never on `processedCount === matchedCount` — so a vanished subject simply shrinks the work set and the run still reaches a clean terminal status. This exactly mirrors how `trash_empty_run_items` behaves when a purge cascades its own row away (see [archive-trash.md §10.2](archive-trash.md#102-data-model)).

The frontend's shared `RunProgressPanel` (§14) clamps `processedCount / matchedCount` to 100% and treats a terminal run with `processedCount < matchedCount` as a normal success outcome, not a stall — do not add an alert or a "stuck" indicator keyed on that inequality.

A subject that still *exists* but is no longer *eligible* by the time its batch runs (already resolved by hand, no longer `pending`) is a different, unrelated case — it lands in `skipped`, not a cascaded-away gap.

### 3.5 Data-Model Alternatives Considered

- **Polymorphic `subject_id UUID` with no FK** *(rejected — the first draft)*. One column, trivially extensible to a fourth subject type. But it has no referential integrity at all: nothing rejects a nonexistent or wrong-type subject id, and a subject deleted during or after a run leaves an item row orphaned forever with no join available to even explain what it pointed at. That is strictly worse than the cascade `location_suggestion_run_items` already had, so consolidating onto a polymorphic column would have been a regression.
- **Three typed item tables** (`review_run_burst_items` / `review_run_duplicate_items` / `review_run_suggestion_items`) under one shared `review_runs` parent — class-table inheritance. Marginally stricter than the exclusive arc (`NOT NULL` FK columns, no CHECK constraints needed), and a fourth subject would be a new table rather than an `ALTER TABLE`. Rejected because the generic evaluate/execute-batch handlers would have to dispatch to a different Prisma delegate for every claim, count, and finalize query — pushing per-type branching into the exact code this consolidation exists to make generic — for an integrity gain the CHECK constraints already deliver.
- **Exclusive arc** *(chosen)*. One item table, so the two generic handlers stay entirely subject-agnostic; integrity fully enforced by FKs + CHECKs + a composite FK. Its honest cost: a fourth review queue later needs a migration that adds a nullable FK column and edits three CHECK constraints, rather than just writing a new `subject_type` enum value. Acceptable — new review queues are rare, and the alternative trades a schema change for permanent orphan risk.

## 4. Duplicate-Group Confidence Becomes Persisted

Migration `20260726000000_duplicate_group_confidence` adds `duplicate_groups.confidence DOUBLE PRECISION` (nullable) plus index `(circle_id, status, confidence)`, mirroring `burst_groups.confidence Float?`.

- **Write path:** `DuplicateDetectionService.recomputeGroupMeta` — already called on every membership mutation (initial grouping, `evictFromDuplicateGroups`, `evictExistingBurstOverlaps`, resolve, dismiss) — is now the **single writer** of `confidence`. It computes the tightest-pair CLIP cosine similarity (`computeGroupConfidence`) and persists it in the same update that sets `mediaCount`/`capturedAt`, so the column cannot silently drift out of sync with membership.
- **Read-time self-heal:** `DuplicateService.listDuplicateGroups` / `getDuplicateGroup` already opportunistically wrote `suggestedBestItemId` back as a fire-and-forget side effect (`persistGroupSelfHeal`, `.catch(() => undefined)`); the same call now also persists `confidence`. This is a backstop for rows written before this column existed — `recomputeGroupMeta` is authoritative going forward.
- **Backfill:** a new global, server-only job type, `duplicate_confidence_backfill` (`mediaItemId: null`, `circleId: null`, priority 100), keyset-paginates (`PAGE_SIZE = 500`, ordered by `id asc`) pending groups with `confidence IS NULL` and fills them in one pass, closing the historical gap for rows nobody happens to read. Triggered by `POST /api/admin/duplicates/confidence/backfill` (Admin + `system_settings:write`, body `{ limit? }`, returns `{ data: { jobId, status } }`), following the same shape as the other admin backfill endpoints. It is **not** gated on `features.duplicateDetection` — it repairs data that already exists regardless of whether the feature is currently toggled on.
- **`computeGroupKind`** (the `exact_variant`/`edited`/`similar` classification) is unchanged and still runs at read time — only `confidence` moved to being persisted. Response payloads are unchanged; `confidence` was already exposed on `GET /api/media/duplicates` and `GET /api/media/duplicates/:id`.

**Staleness invariant:** membership is the only input to `maxSim`, and every membership mutation already funnels through `recomputeGroupMeta`, so the persisted value cannot silently drift once this ships. A group whose `maxSim` is genuinely uncomputable (fewer than two members carry a `media_visual_embedding` row) keeps `confidence = NULL` and — matching the pre-existing read-time behavior — is excluded from threshold matching in **both** directions (§6).

See [duplicate-detection.md §3.5](duplicate-detection.md#35-confidence-score) for the full write-up of what this fixed on the reader-facing side (the `remaining`/`hasMore` field this obsoleted, and the latent below-500-cap re-scan bug it closes).

## 5. Job Types

Four new `enrichment_jobs` types, all **server-only by omission** — none implements the `nodeResultSchema`/`persistNodeResult` node-result pair, so `EnrichmentHandlerRegistry.serverOnlyTypes()` auto-classifies each as server-only and `systemModeEligibleTypes()` auto-includes it in `ENRICHMENT_WORKER_MODE=system`'s claim set with no `enrichment-job.worker.ts` edit. None is added to the CLI's `NODE_JOB_TYPES`.

| Type | Scope | Priority | Payload | Purpose |
|---|---|---|---|---|
| `review_run_evaluate` | `circleId` set, `mediaItemId: null` | 20 | `{ runId }` | Materializes a run's matched set into `review_run_items` via constant-memory keyset pagination (§7) |
| `review_run_execute_batch` | `circleId` set, `mediaItemId: null`, `skipDedup: true` | 100 | `{ runId, subjectIds[] }` | Applies the run's action to one 200-subject chunk (`BATCH_SIZE = 200`) |
| `review_run_history_purge` | global (`mediaItemId: null`, `circleId: null`) | 100 | — | Nightly stale-run sweep + terminal-run retention purge, covering **both** `review_runs` and `trash_empty_runs` (§10) |
| `duplicate_confidence_backfill` | global (`mediaItemId: null`, `circleId: null`) | 100 | `{ limit? }` | One-pass backfill of `duplicate_groups.confidence` for pre-existing `NULL` rows (§4) |

`review_run_evaluate` and `review_run_execute_batch` both wrap their work in an OTEL span (`review_run.evaluate` / `review_run.execute_batch`, tracer `review-run`) with `review_run.run_id`/`circle_id`/`subject_type`/`action` span attributes, matching the tracing convention every other evaluate/execute-batch pair in the codebase (workflow, trash-empty, the original location-suggestion pair) already follows.

## 6. Subject-Strategy Split

`ReviewRunService` and the two generic handlers own the entire run lifecycle — the concurrency guard, authorization, keyset-paged materialization, the `matched → processing → terminal` claim, atomic counters, and the race-safe finalize (§7). Neither handler ever branches on `subjectType`; everything that differs per review queue lives behind one interface, implemented by three strategies registered in `ReviewRunSubjectRegistry` (a fixed, constructor-injected map — not the self-registering `EnrichmentHandlerRegistry` pattern, since the set of subjects is closed by the `ReviewRunSubject` enum).

```ts
interface ReviewRunSubjectStrategy {
  readonly subject: ReviewRunSubject;
  readonly subjectColumn: 'burstGroupId' | 'duplicateGroupId' | 'locationSuggestionId';
  readonly supportedActions: readonly ReviewRunAction[];

  evaluatePage(run, cursor, pageSize): Promise<{ subjectIds: string[]; nextCursor: object | null }>;
  executeItem(run, subjectId, ctx): Promise<'applied' | 'skipped'>; // throws on genuine failure
  deferredEffects?(run, ctx): Promise<void>;                        // fired once per batch, after commit
  hydrateItems(subjectIds): Promise<Map<string, ReviewRunSubjectPreview>>; // for listRunItems thumbnails
}
```

All three strategies **wrap the existing per-subject primitives** rather than reimplementing them, so a single-group resolve/dismiss and a bulk run can never drift apart in behavior:

| Strategy | Subject column | Actions | Wraps | Eligibility filter (per page) |
|---|---|---|---|---|
| `BurstGroupReviewStrategy` | `burstGroupId` | `resolve_archive`, `resolve_trash`, `dismiss` | `BurstService.resolveOneBurstGroup` / `dismissOneBurstGroup` (both now public, extracted from what was route-handler-only logic) | `status = pending` AND `confidence` `not null` `gte`/`lt` `threshold/100` (`gte` for resolve, `lt` for dismiss); keyset on `(capturedAt DESC NULLS LAST, id DESC)` |
| `DuplicateGroupReviewStrategy` | `duplicateGroupId` | `resolve_archive`, `resolve_trash`, `dismiss` | `DuplicateService.resolveOneDuplicateGroup` / `dismissOneDuplicateGroup` (both now public) | Same shape as bursts, now a real SQL predicate over the persisted `confidence` column (§4) — this is what removes the old 500-group cap |
| `LocationSuggestionReviewStrategy` | `locationSuggestionId` | `accept`, `reject` | The accept/reject transaction body carried forward unchanged from the old `LocationSuggestionRunExecuteBatchHandler` | `status = pending` AND `confidence` `gte`/`lt` `threshold/100` (`gte` for accept, `lt` for reject); `LocationSuggestion.confidence` is **non-nullable**, so — unlike the two group strategies — there is no null-exclusion branch here; keyset on `(createdAt DESC, id DESC)` |

Two behavioral details worth calling out:

- **Deferred, batched follow-up effects.** `executeItem` never enqueues a follow-up job directly. It pushes into a per-attempt `ReviewRunExecutionContext` accumulator (`{ geocode: [], reenqueueDuplicateDetection: [] }`), and the strategy's optional `deferredEffects(run, ctx)` drains it **once per batch, after every per-item transaction in that batch has committed** — never inside an item's own transaction. This is why a rolled-back mutation can never leave an orphaned enrichment job behind, and why a burst-resolve batch fires one deduplicated `duplicate_detection` re-enqueue call per batch rather than one per group, and an accept-batch fires one `geocode` enqueue per accepted item (still deduplicated at the queue level via the default dedup key) rather than a synchronous per-item reverse-geocode.
- **`executeItem` never returns `'failed'`.** A subject that's gone or no longer eligible (already resolved by hand since evaluation, lost its `suggestedBestItemId`, etc.) returns `'skipped'` — the strategies treat "someone else already handled this" as a normal outcome, not an error. Throwing is reserved for genuine failures, which the execute-batch handler records as `failed` on that item.

`ReviewRunsModule` imports `BurstModule` and `DedupModule` via `forwardRef` — the dependency is genuinely mutual, since the strategies wrap `BurstService`/`DuplicateService` primitives while those services' own threshold-endpoint methods call `ReviewRunService.createRun`. `LocationSuggestionReviewStrategy` deliberately does **not** depend on a location-inference module — it owns the accept/reject transaction outright, so nothing on that side needs a `forwardRef` back into `ReviewRunsModule`.

## 7. Run Lifecycle State Machine

```
createRun()
   │  ReviewRunStatus.evaluating, enqueue review_run_evaluate (priority 20)
   ▼
review_run_evaluate handler
   │  keyset-pages strategy.evaluatePage() at PAGE_SIZE=1000, writes
   │  review_run_items via createMany({ skipDuplicates: true })
   │
   ├── matchedCount === 0 ──────────────────► ReviewRunStatus.completed (finishedAt set)
   │
   └── matchedCount > 0
          │  status → running, startedAt set
          │  enqueueExecuteBatches(): chunk matched items at BATCH_SIZE=200,
          │  enqueue one review_run_execute_batch per chunk (priority 100)
          ▼
   review_run_execute_batch handler (one per chunk, may run concurrently)
      │  1. bail out if run.status === 'cancelled' (cooperative cancellation, §9)
      │  2. claim: updateMany still-'matched' items in this chunk → 'processing'
      │  3. read back every 'processing' row for this chunk (includes rows a
      │     PRIOR crashed attempt already claimed but never finished)
      │  4. per row: strategy.executeItem() → 'applied' | 'skipped', or throws → 'failed'
      │  5. strategy.deferredEffects(ctx) once, after every item's transaction committed
      │  6. atomic counter increments (processedCount/succeededCount/skippedCount/failedCount)
      │  7. maybeFinalizeRun(): if no rows remain 'matched' or 'processing' for the run,
      │     conditional updateMany on status='running' →
      │        failedCount > 0 ? completed_with_errors : completed
      ▼
terminal: completed | completed_with_errors | failed | cancelled
```

`review_run_evaluate`'s own failure handling: if the strategy's `evaluatePage` throws, the run is left at `evaluating` and the job retries through the normal enrichment backoff path — `createMany({ skipDuplicates: true })` makes re-materializing already-written rows idempotent on retry. Only once the job has exhausted its attempts (`job.attempts >= ENRICHMENT_MAX_ATTEMPTS`) does the handler mark the run terminally `failed` (with `lastError` set) before rethrowing so the job itself also fails.

**Finalize is race-safe by construction.** `maybeFinalizeRun` computes the target terminal status and applies it via a conditional `updateMany({ where: { id: runId, status: 'running' } })` — only the one batch job that happens to drain the last remaining `matched`/`processing` row wins the transition; every other concurrently-finishing batch's `updateMany` is a no-op (`count: 0`). See §3.4 for why "no rows remain matched/processing" — not counter equality — is the finalize condition.

## 8. Concurrency Guard

`createRun` counts existing `review_runs` for `(circleId, subjectType)` in `evaluating` or `running` status; a second request for the **same queue** in the **same circle** is rejected with `409 Conflict` ("A {subjectType} review run is already in progress for this circle"), served by the `(circle_id, subject_type, status)` index.

The guard is per `(circleId, subjectType)`, deliberately **not** per circle: a burst-resolve run and a location-suggestion accept run for the same circle may be in flight simultaneously (they touch entirely disjoint tables), but two burst runs for the same circle may not — that would risk both racing to claim the same pending groups. This matches the location-suggestion runs' pre-existing behavior, where accept and reject shared one guard because both act on the same `LocationSuggestion` rows; here, each of the three subject types gets its own independent guard slot.

## 9. Cancellation Semantics

`POST /api/review-runs/:id/cancel` sets `status = 'cancelled'` (with `finishedAt`) immediately, and is rejected with `400` if the run is already terminal. Cancellation is **cooperative**, identical in spirit to every other run type in the codebase (Workflows, Empty Trash, the original Location Suggestion runs):

- Any `review_run_execute_batch` job **not yet started** checks `run.status === 'cancelled'` as its very first step and returns immediately without claiming any items.
- A batch **already mid-flight** when the cancel lands is not interrupted — it finishes the chunk it already claimed. Items it had already applied stay applied.
- Items not yet claimed by any batch simply stay at `matched` forever (the run is now terminal, so nothing will ever claim them) — this is deliberate; a cancelled run's un-touched items are not "cleaned up" or reset, they just remain visible as `matched` in `listRunItems` for the historical record.

## 10. Retention and Stale-Run Sweep

Neither `trash_empty_runs` nor the pre-#190 `location_suggestion_runs` had any purge — both accumulated until their circle was deleted. `review_run_history_purge` (§5) closes this gap for both `review_runs` **and** `trash_empty_runs` in one nightly pass, mirroring `workflow_history_purge`/`job_history_purge`'s cadence and dedup guard (`ReviewRunHistoryPurgeTask`, `@Cron(EVERY_DAY_AT_MIDNIGHT)`, skips enqueueing if a `review_run_history_purge` job is already `pending`/`running`).

Each run of the job does two things, in order:

1. **Stale-run sweep (runs first, deliberately).** A run stuck non-terminal (`evaluating`/`running`) whose `updated_at` has not moved for more than a fixed **24 hours** is marked `failed` with an explanatory `lastError`. This is not cosmetic housekeeping: the per-`(circle, subjectType)` concurrency guard (§8) rejects a new run with `409` while an active one exists, so a run whose every job has permanently died (e.g. every attempt crashed the whole process) would otherwise **lock that circle's queue forever** with no user-facing way out. The 24-hour stale threshold is a fixed constant, independent of the `reviewRuns.runHistoryRetentionDays` setting below — running the stale sweep first means a run it just failed can become eligible for retention deletion in the very same pass, once old enough. Served by the `(status, updated_at)` index both `review_runs` and `trash_empty_runs` carry.
2. **Retention purge.** Terminal runs (`completed`, `completed_with_errors`, `failed`, `cancelled`) whose `finished_at` — falling back to `updated_at` when null — is older than `reviewRuns.runHistoryRetentionDays` are hard-deleted in 5,000-row batches (mirroring `JobHistoryPurgeHandler`'s batching, so each `DELETE` stays short and never holds locks long enough to stall the worker's row claims). Run **items** are never deleted directly — they cascade away with their parent run's FK. Non-terminal runs are never deleted at any age.

**System setting:** `reviewRuns.runHistoryRetentionDays` — integer, 1–365, default **30**. Validated by the same Zod schema every other system-settings write path uses (`apps/api/src/settings/dto/update-system-settings.dto.ts`), round-tripped through `PATCH`/`PUT /api/system-settings`. As of this writing there is no dedicated admin settings page panel for this value (unlike, say, `workflows.runHistoryRetentionDays` on `/admin/settings/workflows`) — it is editable only via the generic system-settings JSON write path.

## 11. Migration From `location_suggestion_runs`

The same migration that creates `review_runs`/`review_run_items` also performs a **lossless data migration** of the pre-existing location-suggestion run tables, in this order: copy `location_suggestion_runs` → `review_runs` (`subjectType = 'location_suggestion'`, `action`/`status` enum values cast text-to-text since the value sets are textually identical), copy `location_suggestion_run_items` → `review_run_items` (`location_suggestion_id = suggestion_id`) via an `INNER JOIN location_suggestions` so any suggestion row that had already vanished between the old table's last write and this migration is silently excluded rather than becoming an orphan the new FK would reject — then add the constraint set (§3.3), then drop `location_suggestion_run_items`, `location_suggestion_runs`, and their three now-unused enums (`LocationSuggestionRunAction`, `LocationSuggestionRunStatus`, `LocationSuggestionRunItemStatus`).

**Run UUIDs are preserved**, so every previously-issued `/api/location-suggestion-runs/:id` link (in a browser tab, a bookmark, or an in-flight job payload referencing a run id) continues to resolve correctly.

### Backward-compatible surface kept for one release

- **`GET /api/location-suggestion-runs/:id`**, **`GET /api/location-suggestion-runs/:id/items`**, **`POST /api/location-suggestion-runs/:id/cancel`** — kept as a deprecated alias controller (`location-suggestion-runs.controller.ts`) that delegates every call straight into `ReviewRunService`. No behavior difference from calling the equivalent `/api/review-runs/*` route directly.
- **`location_suggestion_run_evaluate`** / **`location_suggestion_run_execute_batch`** job-type handler classes still exist as thin deprecated shims — `process(job)` on the evaluate shim delegates directly to the new `ReviewRunEvaluateHandler.process(job)`; the execute-batch shim remaps the legacy payload field `suggestionIds` to the generic `subjectIds` before delegating to `ReviewRunExecuteBatchHandler.executeBatch(...)`. These exist purely so any job already enqueued under the old type at the moment of deploy still executes correctly rather than stranding; they are candidates for removal one release after this ships.
- The old `location-suggestion-run.service.ts` itself is fully deleted — its logic lives in `ReviewRunService` now.

### Frontend redirect

`LocationSuggestionRunPage.tsx` is deleted. The route `/location-suggestion-runs/:runId` now renders `LocationSuggestionRunRedirect`, which immediately `<Navigate replace>`s to `/review-runs/:runId` — the single shared `ReviewRunPage` (§14) — falling back to `/location-suggestions` if `runId` is somehow missing.

## 12. API Endpoints

Runs are **started** by the per-queue threshold endpoints (unchanged paths, unchanged RBAC decorators and request DTOs — only the response body and internal implementation changed) and **inspected/cancelled** through one shared controller.

### 12.1 Starting a run

| Endpoint | `subjectType` | `action` |
|---|---|---|
| `POST /api/media/bursts/bulk/resolve-by-threshold` | `burst_group` | `resolve_archive` \| `resolve_trash` |
| `POST /api/media/bursts/bulk/dismiss-by-threshold` | `burst_group` | `dismiss` |
| `POST /api/media/duplicates/bulk/resolve-by-threshold` | `duplicate_group` | `resolve_archive` \| `resolve_trash` |
| `POST /api/media/duplicates/bulk/dismiss-by-threshold` | `duplicate_group` | `dismiss` |
| `POST /api/media/location-suggestions/bulk-accept` | `location_suggestion` | `accept` |
| `POST /api/media/location-suggestions/bulk-reject` | `location_suggestion` | `reject` |

Each accepts the same request body it always did (`{ circleId, threshold, action? }`, `action` only on the burst/duplicate pair) and now returns, on success:

```json
{ "data": { "runId": "uuid", "status": "evaluating", "matchedCount": 0 } }
```

`matchedCount` is always `0` at creation — it is filled in once `review_run_evaluate` finishes paginating; poll `GET /api/review-runs/:id` for the real total. Returns `409 Conflict` if a run for that same queue+circle is already active (§8). The old `MAX_THRESHOLD_RESOLVE` cap and the `remaining` (bursts) / `hasMore` (duplicates) response fields are gone entirely — there is nothing left to loop on client-side.

### 12.2 Inspecting and cancelling a run

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/review-runs/:id` | `media:read` + viewer | Run detail: all counters plus `itemStatusCounts` (a live `groupBy` tally of `review_run_items.status`) |
| `GET` | `/api/review-runs/:id/items` | `media:read` + viewer | `?status=&page=&pageSize=` — paginated run items with batched signed thumbnails |
| `POST` | `/api/review-runs/:id/cancel` | `media:write` + collaborator | Cancel a non-terminal run (§9); `400` if already terminal |

`GET /api/review-runs/:id` response (unwrapped, no `data` envelope — matching the pre-existing location-suggestion-runs shape):

```json
{
  "id": "uuid", "circleId": "uuid", "subjectType": "duplicate_group",
  "action": "resolve_archive", "threshold": 80, "status": "running",
  "matchedCount": 812, "processedCount": 400, "succeededCount": 395,
  "failedCount": 2, "skippedCount": 3,
  "startedById": "uuid", "createdAt": "...", "updatedAt": "...",
  "startedAt": "...", "finishedAt": null, "lastError": null,
  "itemStatusCounts": { "processing": 12, "applied": 395, "failed": 2, "skipped": 3, "matched": 400 }
}
```

`GET /api/review-runs/:id/items` flattens the exclusive arc into one client-facing field — clients never branch on which of the three FK columns is populated:

```json
{
  "items": [
    {
      "id": "uuid", "subjectId": "uuid", "subjectType": "duplicate_group",
      "status": "applied", "error": null, "updatedAt": "...",
      "media": { "type": "photo", "capturedAt": "...", "filename": "...", "width": 4032, "height": 3024 },
      "thumbnailUrl": "https://..."
    }
  ],
  "meta": { "page": 1, "pageSize": 50, "totalItems": 812, "totalPages": 17 }
}
```

`media`/`thumbnailUrl` come from the strategy's `hydrateItems` (§6) — for burst/duplicate groups this is the group's `suggestedBestItem`, falling back to the earliest live member; for location suggestions it is the suggestion's own `mediaItem`. Thumbnails are batch-signed once per page via `MediaThumbnailService.signThumbsBatched`, not per row.

### 12.3 Deprecated alias

`GET /api/location-suggestion-runs/:id`, `GET /api/location-suggestion-runs/:id/items`, `POST /api/location-suggestion-runs/:id/cancel` — identical behavior to the `/api/review-runs/*` equivalents above (§11). New integrations should use `/api/review-runs/*` directly.

### 12.4 Related: duplicate confidence backfill

`POST /api/admin/duplicates/confidence/backfill` (Admin + `system_settings:write`, body `{ limit? }`) — not a review-run endpoint itself, but shipped in the same change; see §4.

## 13. RBAC

No new permission scopes were introduced. Every review-run endpoint reuses `media:read` / `media:write` / `media:delete`, exactly like the per-queue endpoints it replaces.

| Operation | System permission | Min per-circle role |
|---|---|---|
| Start a run (any of the six threshold endpoints, §12.1) | `media:write` | `collaborator` |
| Start a run with `action = resolve_trash` (bursts/duplicates only) | `media:write` **+** `media:delete` | `collaborator` |
| `GET /api/review-runs/:id` | `media:read` | `viewer` |
| `GET /api/review-runs/:id/items` | `media:read` | `viewer` |
| `POST /api/review-runs/:id/cancel` | `media:write` | `collaborator` |

Authorization for the whole run lifecycle lives **only** in `ReviewRunService` — the queue handlers (`review_run_evaluate`, `review_run_execute_batch`) never re-authorize; they execute under the authority snapshotted into the run at creation time (`startedById`, `subjectType`, `action`). The `media:delete` check for `resolve_trash` mirrors the same gate the single-group resolve endpoints already apply — trashing media is a strictly higher-authority action than archiving or dismissing, but it is still gated by an additional *system* permission, not a higher *circle* role; `collaborator` remains the floor for every review-run operation, including cancel (unlike Empty Trash at Scale, which requires `circle_admin` to start or cancel a run because permanently deleting media is a categorically higher-stakes action than archiving/dismissing a review-queue group).

Admins holding `circles:manage_any` bypass the per-circle role check as usual and can start/cancel/inspect a run in any circle.

## 14. Frontend

New shared pieces under `apps/web/src`, adopted by all four run surfaces (workflow, trash-empty, and the now-unified burst/duplicate/location-suggestion review-run page):

- **`types/runs.ts`** — the run shape common to every backend (`id`, `circleId`, `status`, the five counters, `startedById`, timestamps, `lastError`, `itemStatusCounts`) plus a `RunStatus` union superset. `types/reviewRuns.ts` narrows this into the review-run-specific `ReviewRun`/`ReviewRunDetail`/`ReviewRunSubject`/`ReviewRunAction` types and the `CreateReviewRunResponse` shape the six threshold endpoints now return.
- **`utils/runFormat.ts`** — `runStatusLabel` / `runStatusColor` / `isTerminalRunStatus` / `runProgressPercent` / `formatCount`, generalized off the pre-existing `workflowFormat.ts` (which now re-exports from here for backward compatibility with the workflow pages).
- **`hooks/useRunPolling.ts`** — the shared 2-second, non-terminal-status poll loop, extracted from what used to be three separately-duplicated `pollRef`/`setInterval` effects.
- **`components/runs/RunProgressPanel.tsx`** — the shared presentational panel: hero `matchedCount`, an indeterminate progress bar while `evaluating` and a determinate bar (`processedCount / matchedCount`, clamped to 100% — see §3.4) while `running`, the five-count tile row with per-host-page-configurable labels ("Deleted" vs. "Applied" vs. "Resolved"), a terminal summary alert, and a `Cancel run` slot the host page gates on its own RBAC. Owns no polling, fetching, or authorization itself — purely presentational.
- **`services/reviewRuns.ts`** + **`hooks/useReviewRun.ts`** / **`useReviewRunItems.ts`** — the thin fetch layer for the three `/api/review-runs/*` endpoints.
- **`pages/Reviews/ReviewRunPage.tsx`**, routed at **`/review-runs/:runId`** — the one page used by all three review queues. It reads `subjectType` off the run to label the counts appropriately and to link failed items back to `/bursts/:id`, `/duplicates/:id`, or the location suggestions page.

Rewired existing pages:

- **`pages/Bursts/BurstsPage.tsx`** and **`pages/Duplicates/DuplicatesPage.tsx`** — the old `MAX_THRESHOLD_ITERATIONS` auto-loop is gone from both. On confirming a threshold action, the page starts the run and navigates to `/review-runs/:runId`, exactly as the location-suggestions page already did before this change.
- **`WorkflowRunPage.tsx`**, **`TrashEmptyRunPage.tsx`** — now built on the shared `useRunPolling` + `RunProgressPanel` for their progress/counters section; each keeps its own feature-specific chrome local (Workflows keeps its `awaiting_approval` block, exclusion grid, and hard-delete confirmation).
- **`LocationSuggestionRunPage.tsx`** — deleted outright in favor of the `LocationSuggestionRunRedirect` → `ReviewRunPage` path (§11).

`RunProgressPanel` was built with issue #189's confidence-sort controls for the duplicate/burst review queues as its intended next home — see §16.

## 15. Implementation Notes and Gotchas

- **`subjectIdOf(row, column)` is the one place that reads the exclusive arc.** Both handlers and the service's `listRunItems` go through this single helper (`review-run.service.ts`) to pull the populated subject id off a `review_run_items` row via the strategy's `subjectColumn` — nowhere else in the codebase branches on which of the three FK columns is set.
- **`executeItem` throwing is genuinely rare and intentional.** The strategies are written so that "the group/suggestion is gone or already handled" resolves to `'skipped'`, not a thrown error — a batch full of skips still finalizes as `completed`, not `completed_with_errors`. Only a real exception (a DB error, an unexpected constraint violation) should ever produce a `failed` item.
- **`review_run_history_purge` deliberately purges two unrelated tables in one handler.** It is registered inside `ReviewRunsModule`, not a generic "purge everything" module, but its scope explicitly includes `trash_empty_runs` — see §10 for why. It does **not** touch `workflow_runs` (that stays on `workflow_history_purge`).
- **The four job types are enumerated in `job-type-labels.ts`** (`Review run evaluate` / `Review run execute batch` / `Review run history purge` / `Duplicate confidence backfill`) so they render with human-readable names in the `/admin/settings/jobs` dashboard, and in `server-only-types.spec.ts`'s `DOCUMENTED_SERVER_ONLY_TYPES` drift guard (which also gates `ALL_HANDLER_CLASSES`) — that spec fails by design if a job type's server-only classification and its documentation (this file, `CLAUDE.md`, and [distributed-nodes.md §8.3](distributed-nodes.md#83-server-only-never-node-eligible)) fall out of sync.
- **No node-claimable path exists or is planned for any of these four types.** `review_run_evaluate`/`review_run_execute_batch` operate purely against `review_runs`/`review_run_items` rows with no per-item media bytes a node would need to touch (the actual archive/trash/geocode mutations they trigger already run through each domain's existing server-side service methods); `review_run_history_purge` and `duplicate_confidence_backfill` are pure DB sweeps. See [distributed-nodes.md §8.3](distributed-nodes.md#83-server-only-never-node-eligible).

## 16. Future Work

| Capability | Notes |
|---|---|
| Confidence-sort controls on the review queues (issue #189) | `RunProgressPanel` (§14) was explicitly built as the intended home for this; not yet implemented |
| Admin settings page for `reviewRuns.runHistoryRetentionDays` | Currently editable only via the generic system-settings JSON write path (§10) — no dedicated panel like `workflows.runHistoryRetentionDays` has on `/admin/settings/workflows` |
| Remove the deprecated `location-suggestion-runs` alias controller and job-type shims | Safe to delete one release after this ships, once no in-flight job can reference the old `location_suggestion_run_*` types (§11) |
| A fourth review queue | Would require a new nullable FK column plus edits to the three CHECK constraints on `review_run_items` (§3.5) — a deliberate, acceptable cost of the exclusive-arc design |

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | July 2026 | AI Assistant | Initial specification, documenting the shipped issue #190 implementation: the shared `review_runs`/`review_run_items` exclusive-arc data model absorbing `location_suggestion_runs`, the persisted `duplicate_groups.confidence` column, the four new server-only job types, the subject-strategy split, the run lifecycle/cancellation/retention model, the API, RBAC, and the shared `RunProgressPanel` frontend |

# Media Workflow Automation — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Specification (Phases 1–6 shipped) |
| **Epic** | [#138](https://github.com/marinoscar/MemoriaHub/issues/138) — Phases [#139](https://github.com/marinoscar/MemoriaHub/issues/139)–[#144](https://github.com/marinoscar/MemoriaHub/issues/144) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [The Subject · Trigger · If · Then Model](#2-the-subject--trigger--if--then-model)
3. [The Per-Subject Registry and the Forward-Compat Contract](#3-the-per-subject-registry-and-the-forward-compat-contract)
4. [Definition Schema](#4-definition-schema)
5. [Media Item Condition Catalog and Compiler Contract](#5-media-item-condition-catalog-and-compiler-contract)
6. [Media Item Action Library](#6-media-item-action-library)
7. [Run Lifecycle](#7-run-lifecycle)
8. [Scale Strategy](#8-scale-strategy)
9. [Trigger Semantics](#9-trigger-semantics)
10. [Safety Model](#10-safety-model)
11. [Node Execution (Compute/Persist Split)](#11-node-execution-computepersist-split)
12. [Data Model](#12-data-model)
13. [API Endpoints](#13-api-endpoints)
14. [RBAC](#14-rbac)
15. [Settings Reference](#15-settings-reference)
16. [Admin UI, Doctor, and Observability](#16-admin-ui-doctor-and-observability)
17. [CLI](#17-cli)
18. [Testing Notes](#18-testing-notes)
19. [Future Work](#19-future-work)

---

## 1. Overview and Goals

### The problem it solves

> "I have thousands of screenshots polluting my library. I want a rule: **IF** the filename contains `screenshot`, **OR** it's a PNG with no camera EXIF and no capture date, **THEN** move it to Trash — let me preview exactly what matches, approve it, and let the queue chew through it in the background."

That is the v1 acceptance test the epic (#138) was scoped around. Workflows is a rule-based automation engine — trigger → condition → action — built to organize media **at scale**, on a circle's **entire existing library**, not just events going forward.

### Why a batch/query engine, not just forward-only event automation

The obvious "automation" shape is: watch for an event (a new photo lands), check a condition, run an action. That model is familiar (every consumer smart-rule tool works this way) but it only ever reacts to **new** things. MemoriaHub's actual pain point is a **backlog** — thousands of screenshots, WhatsApp re-shares, and social-media re-uploads already sitting in the library. An event-only design can never clean those up; the user would have to build a one-off bulk-operation UI for every such cleanup, which is exactly what the existing burst/duplicate/location review queues, `PATCH /api/media/bulk`, and `POST /api/media/albums/:id/items/by-filter` already are — one bespoke bulk tool per use case.

Workflows generalizes those one-off tools into a single **query + action engine**: a workflow's conditions compile to the same kind of `Prisma.MediaItemWhereInput` the deterministic search endpoint (`docs/specs/semantic-search.md`'s sibling, `POST /api/search`) already produces, and a workflow's actions reuse the same bulk-operation service methods (`MediaService.bulkArchive`, `bulkTags`, `bulkUpdateMedia`, `BurstService.resolveBurstGroup`, …) documented throughout `CLAUDE.md`. **Manual** and **Scheduled** triggers run this query+action engine over the *whole matching set* every time they fire; **On new media** is the one place the classic forward-only event trigger appears, and it reuses the identical execution path once a single new item is found to match. One feature, two run modes, sharing one action library.

### Goals

- Let a circle collaborator define a rule in a form-based builder ("On Media Items, when new media is enriched, if the filename contains 'screenshot', then move it to Trash"), preview exactly what it matches before committing, and either run it once or let it run automatically.
- Reuse every existing bulk-mutation code path rather than re-implementing archive/trash/tag/album/person/location/burst-resolve/duplicate-resolve/location-suggestion logic a second time.
- Scale to a production library of **~30k media items today, ~150k expected** — no unbounded `COUNT(*)`, no full in-memory ID arrays, background-priority execution that never starves upload enrichment.
- Run identically whether the deployment is a single VPS or a `ENRICHMENT_WORKER_MODE=system` fleet backed by CLI worker nodes.
- Ship full power — including permanent deletion — behind guardrails strict enough that an admin can leave the feature on without fear of an accidental library wipe.

### Non-Goals (v1)

- **Additional Subjects** (Duplicate Group, Burst Group, Location Suggestion, Unassigned Face/Person) as first-class entities. Their operations are available in v1 as **Media Item** conditions/actions (§5, §6) — see §3 for the extension path.
- A visual node/canvas editor. The definition format is versioned specifically so one can be layered on later without a migration.
- **Field interpolation** (`{{field}}` inside an action's params, e.g. tag = `{{cameraModel}}`) — a documented post-v1 stretch, not implemented.
- `semanticQuery` conditions — deferred; would need embedding coverage and a similarity-threshold UX.
- File-content conditions requiring byte downloads (e.g. OCR-based rules).

---

## 2. The Subject · Trigger · If · Then Model

A workflow reads as one sentence: **On this [Subject], when [Trigger], if [Conditions], then [Actions].**

- **Subject** — the entity type the workflow evaluates and acts on. It is what scopes everything else: the available conditions are that entity's fields, and the available actions are the operations valid for it. v1 ships exactly one Subject, `media_item` (`WorkflowSubject` enum in `apps/api/prisma/schema.prisma`).
- **Trigger** — how a run starts. Three options, the `WorkflowTrigger` enum: `manual` (run now, from the UI or `POST /api/workflows/:id/run`), `scheduled` (cron, minimum interval `workflows.scheduleMinIntervalMinutes`), `on_media_enriched` (evaluate each newly-uploaded item once its relevant enrichment has settled). See §9 for full unattended-trigger mechanics.
- **Conditions (IF)** — a typed filter over the Subject's fields, combined with `match: 'all'` (AND) or `'any'` (OR), plus exactly one level of nested groups so `A OR (B AND C)` is expressible. See §4–§5.
- **Actions (THEN)** — an ordered list, each valid for the chosen Subject, executed in definition order per matched item. See §6.

Everything below §3 documents the **Media Item** Subject's registry entry — the only one v1 ships.

---

## 3. The Per-Subject Registry and the Forward-Compat Contract

### 3.1 Why a registry, not a hard-coded engine

The engine (compiler, validator, action executor, run lifecycle) never hard-codes "media item" logic. It resolves everything — field catalog, operator vocabulary, action catalog, valid triggers — through a **per-Subject registry** (`apps/api/src/workflows/registry/subject-registry.ts`):

```ts
const REGISTRY: Record<string, SubjectRegistryEntry> = {
  [WorkflowSubject.media_item]: {
    subject: WorkflowSubject.media_item,
    label: 'Media Item',
    triggers: ['manual', 'on_media_enriched', 'scheduled'],
    fields: MEDIA_ITEM_FIELDS,
    actions: MEDIA_ITEM_ACTIONS,
  },
};
```

`getField`, `getActionDescriptor`, `isRegisteredAction`, `isRegisteredSubject`, and `getFullRegistry` are the only entry points the validator (`WorkflowDefinitionValidator`), the compiler (`WorkflowConditionCompiler`), and the `GET /api/workflows/subjects` endpoint use. A future Subject — the epic's roadmap table lists `duplicate_group`, `burst_group`, `location_suggestion`, `unassigned_face`/`person` as candidates — slots in by adding one more entry to `REGISTRY` with its own field catalog, action catalog, and trigger list. No compiler, validator, executor, or run-lifecycle code changes.

### 3.2 Why the review-queue operations live on Media Item today

The burst/duplicate/location-suggestion resolve-dismiss-accept-reject actions (§6.2) conceptually belong to a future `duplicate_group`/`burst_group`/`location_suggestion` Subject — "resolve the group this item is in" is an indirection that a native Subject would remove. In v1 they are Media Item conditions (`inPendingBurstGroup`, `burstGroupConfidence`, …) and Media Item actions (`resolve_burst_group`, …) that act on the **group the matched item belongs to**, deduplicated per-group within a run (`ctx.handledGroups`, §6.2). The underlying service calls (`BurstService.resolveBurstGroup`, `DuplicateService.dismissDuplicateGroup`, `LocationSuggestionService.acceptSuggestion`, …) are reused verbatim — no new resolution logic was written, only workflow orchestration around the existing review-queue services.

### 3.3 The one schema generalization a future Subject will need

`workflow_run_items.media_item_id` is a `String @db.Uuid` FK straight to `media_items(id)` (`@@unique([runId, mediaItemId])` is the batch-retry idempotency anchor — see §7). This is sound for v1 because there is exactly one Subject. A second Subject would need this column generalized to a **subject id/type pair** (e.g. `subjectType` + `subjectId`, with the FK becoming a polymorphic/denormalized reference the way `location_suggestions.anchor_before_id` already is elsewhere in this schema — no DB-level FK, just an id + a type discriminator). **This is documented here as the forward-compat contract; it was never built in v1.** `workflow_run_items` ships with only the media-item shape because Phase 1 (#139) intentionally deferred the generalization until a second Subject actually exists, to avoid designing an abstraction against a single data point.

---

## 4. Definition Schema

A workflow's `definition` column (JSONB on `workflows`) is a versioned, Subject-tagged document, structurally validated by a Zod schema (`apps/api/src/workflows/definition/workflow-definition.schema.ts`) and then registry-validated (`WorkflowDefinitionValidator`):

```jsonc
{
  "version": 1,
  "subject": "media_item",
  "match": "all",                          // "all" (AND) | "any" (OR)
  "conditions": [
    { "field": "filename", "op": "contains", "value": "screenshot" },
    { "match": "all", "conditions": [       // exactly ONE nesting level
      { "field": "mimeType", "op": "equals", "value": "image/png" },
      { "field": "missingCamera", "op": "is", "value": true },
      { "field": "missingCapturedAt", "op": "is", "value": true }
    ]}
  ],
  "actions": [ { "type": "move_to_trash" } ],
  "options": { "maxItems": 5000, "requirePreview": true }
}
```

- `version: z.literal(1)` and `subject: z.string().min(1)` are mandatory — any future breaking schema change bumps this literal.
- `conditions` is an array of either a **leaf** (`{ field, op, value? }`) or a **group** (`{ match, conditions: leaf[] }`). A group's `conditions` array accepts leaves only — the Zod schema's `groupConditionSchema` is defined in terms of `leafConditionSchema`, so a group cannot itself contain another group. This is what caps nesting at exactly one level. An **empty `conditions` array is legal** and matches every non-deleted item in the circle — a deliberate "apply to all" workflow shape.
- `actions` is `{ type, ...params }` (Zod `.passthrough()` at the structural layer — the schema only requires `type`; per-action `params` shapes are validated by each action's own Zod schema in `action-params.schema.ts`, resolved through the registry).
- `options.maxItems` (optional per-workflow cap, see §8) and `options.requirePreview` (optional per-workflow override, see §7.2) are both optional; `WorkflowRunService.shouldBypassApproval` reads them together with the system settings.

Two validation layers:
1. **Structural** (`workflowDefinitionSchema.safeParse`) — shape only; a Zod schema has no idea what fields/actions exist for a Subject.
2. **Registry-aware** (`WorkflowDefinitionValidator.validate`) — rejects a `subject` not in the registry, any `field`/`op`/action `type` not registered for that Subject, and operator/value-type mismatches (e.g. `gt` on a non-numeric value, `has_person` without a well-formed `{ ids: string[] }`). An unknown or cross-Subject combination can therefore never be saved — see the exhaustive per-operator switch in `WorkflowDefinitionValidator.validateOperand`.

`WorkflowRun.definitionSnapshot` freezes a copy of `Workflow.definition` at `POST /api/workflows/:id/run` time (or at unattended-run start). Every later phase of that run — evaluation, approval, execution — compiles the **snapshot**, never the live `Workflow` row, so editing a workflow mid-run (or after) never changes what an in-flight or historical run does.

---

## 5. Media Item Condition Catalog and Compiler Contract

### 5.1 Field catalog

`apps/api/src/workflows/registry/media-item-fields.ts` (`MEDIA_ITEM_FIELDS`) defines every condition available on the Media Item Subject, grouped for the builder UI into **File, Media, Dates, Location, Organization, Tags, People, Review**:

| Group | Fields |
|---|---|
| File | `filename` (contains/starts_with/ends_with/equals, case-insensitive ILIKE), `mimeType` (equals), `fileSize` (gt/lt, bytes) |
| Media | `mediaType` (photo/video), `width`/`height` (gt/lt px), `megapixels` (gt/lt — **read-time refined**, §5.3), `orientationShape` (portrait/landscape/square — **read-time refined**), `socialMediaSource` (is_set/equals platform) |
| Dates | `capturedAt`/`uploadedAt` (between/before/after/older_than_days/within_last_days), `missingCapturedAt` (is) |
| Location | `hasGps`/`noGps` (is), `country`/`region`/`locality` (equals), `near` (map-radius `{lat,lng,radiusKm}`), `coordSource` (is `exif`\|`manual`\|`inferred`) |
| Organization | `cameraMake`/`cameraModel` (equals/contains), `missingCamera` (is), `favorite` (is), `archived` (is), `album` (in_album/not_in_album by albumId) |
| Tags | `tags` (has_any/has_all/has_none by name), `untagged` (is) |
| People | `people` (has_person/not_has_person, `{ids, mode:'any'\|'all'}`), `noFaces` (is), `hasUnassignedFaces` (is) |
| Review | `inPendingBurstGroup` (is), `burstGroupConfidence` (gte), `inPendingDuplicateGroup` (is), `duplicateGroupConfidence` (gte — **read-time bounded, not exact**, §5.3), `hasPendingLocationSuggestion` (is), `locationSuggestionConfidence` (gte), `locationSuggestionMethod` (equals `interpolated`\|`nearest`) |

Every field reuses an existing deterministic-search `where`-builder helper where one exists (`whereType`, `whereFavorite`, `whereDateRange`, `whereAlbum`, `whereCountry`/`whereRegion`/`whereLocality`, `whereNear`, `whereMissingCapturedAt`, `whereMissingCamera`, `whereNoFaces`, `whereMissingGeo`, `wherePeople`, all imported from `apps/api/src/search/media-where.builder`) — the workflow condition catalog is not a parallel reimplementation of the search filter set, it is largely the same set through a different door. `filename`'s `contains`/`starts_with`/`ends_with` compile to Prisma `mode: 'insensitive'` `ILIKE` — **never** a user-supplied regex.

### 5.2 Condition compiler

`WorkflowConditionCompiler.compile(circleId, definition)` (`apps/api/src/workflows/compiler/workflow-condition.compiler.ts`) turns a validated definition into:

```ts
interface CompiledWorkflow {
  where: Prisma.MediaItemWhereInput;       // { circleId, deletedAt: null, AND/OR: [...] }
  dependencies: Set<WorkflowDependency>;   // which enrichment outputs the conditions read
  refinements: CompiledRefinement[];       // read-time-only predicates (§5.3)
}
```

Composition follows the **same shared-array rule** the deterministic search engine already uses (`docs/audits/search-audit.md`): every condition contributes its own element of a top-level `AND`/`OR` array — fragments are never merged into one object — so two descriptors that each emit an internal `OR`/`AND` never collide. A group's leaves compile with the group's own `match`; the group as a whole becomes one element of the root array.

The compiler also derives a **dependency set** — `metadata` | `tags` | `faces` | `bursts` | `duplicates` | `locationSuggestions` — the union of every condition's `dependency` field. This is what Phase 4's `on_media_enriched` trigger uses to decide *when* a freshly-uploaded item is evaluable (§9.1); it is exposed standalone via `deriveDependencies()` (cheaper, value-agnostic, used to populate `dependencies` in the workflow serialization returned from `GET /api/workflows/:id`).

### 5.3 Read-time refinements — the columns Prisma's typed `where` cannot express

A small number of fields cannot compile to a pure indexed Prisma predicate:

- **`megapixels`** and **`orientationShape`** require comparing `width` to `height` (or their product to a threshold) — Postgres column-to-column comparison, which Prisma's typed `where` DSL has no syntax for. Each descriptor's `buildWhere` returns only a **bounding predicate** (`{ width: { not: null }, height: { not: null } }`) and declares `readTimeRefinement: true` with a `refinementPredicate` factory that the compiler applies to each fetched row in-process.
- **`duplicateGroupConfidence`** is worse: duplicate-group `confidence` (tightest-pair CLIP cosine similarity) is computed **at read time**, never persisted (see `CLAUDE.md`'s duplicate-detection paragraph and `docs/specs/duplicate-detection.md`). The field's `buildWhere` bounds to `{ duplicateGroup: { is: { status: 'pending' } } }` and is marked `readTimeRefinement: true` but has **no `refinementPredicate`** — evaluating the true CLIP-similarity comparison is a heavier compute pass than a pure in-process predicate over already-fetched columns, so as-shipped this comparison is not applied at evaluation/preview time at all; a workflow using `duplicateGroupConfidence` will match every item in *any* pending duplicate group and rely on `resolve_duplicate_group`'s own group-level logic downstream. This is a documented, intentional v1 gap, not an oversight — see the inline comment in `media-item-fields.ts`.

A refinement is only collected when the compiler determines it sits on an **all-AND path from the definition root** (`pureAndPath` threading through `compileLeaf`) — sound to apply as a top-level AND post-filter. On any OR-nested path the field contributes only its bounding predicate (an upper bound on the matched set), and no refinement is emitted; this deliberately trades a slightly-too-broad match for correctness (never silently drops a true match by over-filtering inside an OR).

Refinements are re-applied at three call sites that all share the same contract:
1. **Preview** (`WorkflowsService.preview`) — filters the count probe and sample rows.
2. **Evaluation** (`WorkflowEvaluateHandler`) — filters each keyset page before `createMany`-ing matched rows.
3. **Per-item drift re-validation** (`revalidateItemMatches`, §7.3) — re-applies the same predicates to a single freshly-fetched row before an action executes.

---

## 6. Media Item Action Library

`apps/api/src/workflows/registry/media-item-fields.ts` (`MEDIA_ITEM_ACTIONS`) is the Media Item Subject's **Then** catalog. Every action descriptor (`WorkflowActionDescriptor`, `apps/api/src/workflows/registry/field-descriptor.interface.ts`) carries a Zod `paramsSchema` (`apps/api/src/workflows/actions/action-params.schema.ts`), a typed `permission` (`WorkflowActionPermission`), a `triggerCompatibility` (`'manual_only'` or `'all'`), and advisory `reversible`/`highImpact` flags surfaced to the builder UI. `WorkflowActionExecutor` (`apps/api/src/workflows/actions/workflow-action.executor.ts`) is the single place every action is actually applied — one item, one action, one `ActionOutcome` (`{ status: 'applied'|'skipped'|'failed', reason?, detail?, terminal? }`).

### 6.1 Item-level actions

| Action | Params | Permission | Reused service call | Notes |
|---|---|---|---|---|
| `move_to_trash` | — | base | `MediaService.bulkDelete` | soft-delete, recoverable per `storage.trash.retentionDays` |
| `hard_delete` | — | base + `media:delete` + `workflows.allowHardDelete` gate | `MediaService.purgeMediaItems` | **manual trigger only**; `terminal: true` on success — later actions on that item are skipped because the row (and its `workflow_run_item`) is gone |
| `archive` / `unarchive` | — | base | `MediaService.bulkArchive`/`bulkUnarchive` | |
| `add_to_album` | `albumId` XOR `createAlbumNamed` | base | `MediaService.addAlbumItems`, `createAlbum` | a `createAlbumNamed` album is created **once per run** and cached in `WorkflowActionExecutor.albumNameCache` (keyed by `runId`), released via `clearRunCache()` when the run finalizes |
| `remove_from_album` | `albumId` | base | `MediaService.removeAlbumItem` | 404 → `skipped: not_in_album` |
| `add_tags` | `names[]` | base | `MediaService.bulkTags` with `addSource: MediaTagSource.system` | applied as `source='system'`, never overwrites `source='manual'` rows |
| `remove_tags` | `names[]`, `sources?` (default `['ai','system']`) | base | `MediaService.bulkTags` with `removeSources` | default excludes `manual` — a cleanup workflow never strips a user's own tags unless `sources` explicitly includes `'manual'` |
| `set_favorite` | `value: boolean` | base | `MediaService.bulkUpdateMedia` | |
| `set_captured_at` | `{ mode: 'set'\|'shift'\|'clear', value?, shiftMinutes? }` | base | `MediaService.bulkUpdateMedia` | `set` requires `value` (ISO datetime), forbids `shiftMinutes`; `shift` requires `shiftMinutes` (int, ±), forbids `value`, reads the item's *current* `capturedAt` and offsets it — items with a null `capturedAt` are `skipped: null_captured_at`; `clear` forbids both. Zod `superRefine` enforces the exclusivity |
| `assign_person` / `remove_person` | `personId` | base | `PeopleService.addPersonToMedia`/`removePersonFromMedia` | manual association only (`providerKey='manual'` Face row) |
| `set_location` | `{ lat, lng }` | base | `MediaService.bulkUpdateMedia` (`set.location`) | routes through the shared `applyLocation()` helper — coords + `coordSource='manual'` + synchronous reverse-geocode |
| `clear_location` | — | base | `MediaService.bulkUpdateMedia` (`set.location: null`) | routes through `GEO_CLEAR_COLUMNS` (also nulls `coordSource`) |
| `move_to_circle` | `{ targetCircleId }` | base + both-circle collaborator | hand-rolled (§6.3) | the **one** action with a cross-circle cascade |
| `rerun_enrichment` | `kinds[]` ⊆ `tagging,faces,metadata,thumbnail,duplicates` | base | `EnrichmentJobService.enqueue` at **priority 100** | `faces` routes on the item's media type (`face_detection` for photos, `video_face_detection` for videos) |

"base" = `BASE_ACTION_PERMISSION` = circle `collaborator` role + system `media:write` permission.

### 6.2 Review-queue actions

These act on the **group** (burst/duplicate) or **suggestion** (location inference) the matched item belongs to, not the item in isolation:

| Action | Params | Permission | Reused service call |
|---|---|---|---|
| `resolve_burst_group` | `{ action: 'archive'\|'trash' }` | base (`trash` also `media:delete`) | `BurstService.resolveBurstGroup` |
| `dismiss_burst_group` | — | base | `BurstService.dismissBurstGroup` |
| `resolve_duplicate_group` | `{ action: 'archive'\|'trash' }` | base (`trash` also `media:delete`) | `DuplicateService.resolveDuplicateGroup` |
| `dismiss_duplicate_group` | — | base | `DuplicateService.dismissDuplicateGroup` |
| `accept_location_suggestion` | — | base | `LocationSuggestionService.acceptSuggestion` |
| `reject_location_suggestion` | — | base | `LocationSuggestionService.rejectSuggestion` |

Shared semantics, enforced in the executor:

- **Group dedup within a run.** `ctx.handledGroups: Set<string>` (per-batch, populated fresh by `WorkflowExecuteBatchHandler.executeBatch` for every `workflow_execute_batch` job) means the *first* matched item in a group resolves it and every other matched member of the same group in that batch is `skipped: same_group`. Across separate batches of the same run, the group's status has already flipped off `pending` by the time a later batch reaches it, so the executor's own pending-status check naturally skips it (`no_pending_target`) — no cross-batch persistence of the Set is needed.
- **Only-if-pending.** A group already `resolved`/`dismissed`, or a suggestion that is not `pending`, is `skipped: no_pending_target` — never re-resolved by a workflow.
- **No suggested best.** `resolve_burst_group`/`resolve_duplicate_group` keep the group's `suggestedBestItemId` and archive/trash the rest, mirroring the manual bulk-resolve endpoints exactly; a group with no `suggestedBestItemId` is `skipped: no_suggested_best`.
- **Reversible → allowed on every trigger.** Trash is recoverable, archive is reversible — these actions pass the same trigger-policy bar as `move_to_trash` (§10). The caveat: on `on_media_enriched`, a burst/duplicate group may not have formed yet when a single new item settles (group formation is a separate, later enrichment step), so these actions are most useful paired with `scheduled`/`manual` triggers.

### 6.3 `move_to_circle` — the one cross-circle cascade

`WorkflowActionExecutor.moveToCircle` is the only hand-rolled (non-service-reuse) action, because no existing bulk endpoint moves an item between circles. It:

1. Re-verifies collaborator access on **both** the source (`ctx.circleId`) and the target circle at execute time via `CircleMembershipService.assertCircleAccess` (honors the super-admin bypass) — this is in addition to the same check already performed at run-create and at approval (§10.2).
2. Loads the item; `skipped: not_found` if it's gone or trashed.
3. **Dedup guard**: if an active item with the same `contentHash` already exists in the target circle, `skipped: dedup_conflict` rather than colliding with the target's `(circle_id, content_hash)` unique constraint.
4. In one transaction: deletes the item's `album_items`, `faces`, `media_tags`, and `location_suggestion` rows (all circle-scoped associations), nulls `burstGroupId`/`duplicateGroupId`, and updates `circleId` to the target.
5. Re-fires enrichment in the **target** circle via `MediaEnrichmentService.enqueueUploadEnrichment` — the same canonical, feature-gated entry point every fresh upload uses — so the item re-detects faces, re-tags, and re-groups into its new home's burst/duplicate pools.

Because it fans out a full re-enrichment cycle per moved item, a large `move_to_circle` run should be treated like a backfill for throughput planning — the action is `highImpact: true` even though it is `reversible: true` (moving it back is always possible).

---

## 7. Run Lifecycle

### 7.1 State machine

```
POST /api/workflows/:id/run
   │ enforces workflows.maxConcurrentRuns (409 if exceeded)
   │ creates workflow_runs row: status=evaluating, definitionSnapshot frozen
   │ enqueues workflow_evaluate (priority 20)
   ▼
evaluating ──(0 matches)────────────────────────────► completed
   │
   │ (bypass-eligible — §7.2)
   ├──────────────────────────────────► running ──► completed | completed_with_errors
   │
   └──(else)──► awaiting_approval
                    │  POST /api/workflow-runs/:id/approve
                    ▼
                 running ──(workflow_execute_batch jobs drain)──► completed | completed_with_errors

Other transitions: any non-terminal status ──(cancel)──► cancelled
                    awaiting_approval ──(TTL elapsed, purge sweep)──► expired
                    evaluating ──(exhausted retries)──► failed
```

`WorkflowRunStatus` enum: `evaluating`, `awaiting_approval`, `running`, `completed`, `completed_with_errors`, `failed`, `cancelled`, `expired`.

### 7.2 Approval-bypass rule

`WorkflowRunService.shouldBypassApproval(definition, settings, triggerType)`:

- **Any non-manual trigger** (`scheduled`, `on_media_enriched`) always bypasses `awaiting_approval` — there is no human in the loop for an unattended run, so a stop there would strand the run until it expires. The only refusal check retained is a defensive re-assertion that no action is `triggerCompatibility: 'manual_only'` (unreachable in practice — definition validation already rejects that combination at save time, §10.1).
- **Manual trigger** bypasses only when **all** of: the per-workflow `definition.options.requirePreview === false`, the system `workflows.requirePreview` setting is `false`, and **no** action in the definition is "gated" (`isGatedAction`: has a feature-flag `gates` entry, `bothCircles`, a trash-variant `extraPermForTrashVariant`, is `destructive`, or is `manual_only`). Any gated action forces the approval stop regardless of the two boolean settings.

### 7.3 `workflow_evaluate` — materialization

Server-only job (`WorkflowEvaluateHandler`), one per run. Compiles the run's **snapshot** definition, then streams matching item IDs via **keyset pagination** — 1,000-row pages ordered `(capturedAt DESC NULLS LAST, id DESC)`, the same ordering the gallery keyset endpoint uses — `createMany`-ing accepted rows into `workflow_run_items` (`skipDuplicates: true`) as it goes. Never a `findMany` of all rows, never a full ID array in memory.

- **Cap** = `Math.min(workflows.maxItemsPerRun, runBody.maxItems ?? ∞, definition.options.maxItems ?? ∞)` — the request-time override wins if smaller than the per-workflow option, which in turn is bounded by the system ceiling. On hitting the cap the handler trims the final page and sets `truncated: true`; if the cap lands exactly on a page boundary it does one bounded lookahead page (`hasMoreMatching`) purely to decide the `truncated` flag correctly.
- **0 matches** → `completed` immediately (no approval stop, nothing to run).
- **Failure handling**: an evaluation error only marks the run `failed` once the job has exhausted `ENRICHMENT_MAX_ATTEMPTS` (checked via `job.attempts`); earlier attempts leave the run at `evaluating` and simply retry — safe because `createMany({ skipDuplicates: true })` makes re-materialization idempotent.

### 7.4 `workflow_execute_batch` — execution

One job per `workflows.batchSize` (default 200) matched item IDs, `payload: { runId, itemIds }`, priority **100** (background — never competes with upload-time enrichment at priority 5–10), `skipDedup: true` (many concurrent batches share the same `type` but must not collapse into one job). Node-eligible — see §11.

Per item, `WorkflowExecuteBatchHandler.processItem`:

1. **Idempotency claim** — `updateMany({ where: { runId, mediaItemId, status: 'matched' }, data: { updatedAt: now } })`. A retried batch's already-terminal (or `excluded`) items claim zero rows and return `already_terminal` — not re-counted, since the original attempt already counted them.
2. **Drift re-validation** — `revalidateItemMatches` re-runs the compiled `where` (+ refinements) against a fresh single-row fetch. Hours can pass between materialization and a batch actually running; an item that no longer matches (tag removed, archived, edited) is `skipped` **without any action running**.
3. **Ordered action execution** — each action in `definition.actions` runs via `WorkflowActionExecutor.execute`; execution stops early only when an outcome carries `terminal: true` (a successful `hard_delete`).
4. **Per-item terminal status**: all applied → `applied`; some applied then one failed → `partially_applied` (`action_results` records every per-action outcome, `error` the first failure's detail); the *first* action failed with nothing applied → `failed`; every action skipped → `skipped`.
5. Counters (`processedCount`, `succeededCount`, `failedCount`, `skippedCount`) increment on `workflow_runs` per terminal item. `partially_applied` increments **both** `succeededCount` and `failedCount` — it counts as genuine progress *and* an error, which is what forces the run's final status to `completed_with_errors` instead of `completed`.
6. **Cancellation check** every 25 items (`CANCEL_CHECK_INTERVAL`) — a `cancelled` run bails out of the remaining items in that batch without processing them.
7. **Finalization** (`maybeFinalizeRun`) — once zero `workflow_run_items` remain `matched` for a run, a race-safe conditional `updateMany({ where: { status: 'running' } })` lets only the batch that drained the queue win and set the terminal status: `failed`/`partially_applied` present anywhere → `completed_with_errors`, else `completed`.

A successful `hard_delete` cascade-deletes the `MediaItem`, which cascade-deletes its `workflow_run_item` row (`onDelete: Cascade`); the conditional `finalizeItem` write then affects zero rows (harmless — the item is still counted via the function's return value, not the row it just deleted).

### 7.5 Approval and cancellation

- `POST /api/workflow-runs/:id/approve` (`WorkflowRunService.approveRun`): flips up to 500 `excludedItemIds` from `matched` → `excluded`; if the definition contains `hard_delete`, requires `body.confirmation === "DELETE {matchedCount}"` (the exact matched count shown at preview time — a typo-proofed, count-bound confirmation, not a generic "yes"); re-runs `checkGatedActionPermissions` (feature flags + system perms + both-circle checks) at approval time, not just at create time, since time may have passed and permissions may have changed; then transitions `running` and calls `enqueueExecuteBatches`.
- `POST /api/workflow-runs/:id/cancel` (circle collaborator) / `POST /api/admin/workflow-runs/:id/cancel` (Admin, app-wide, no circle-membership check) both set `status: cancelled, finishedAt: now()` on any non-terminal run; in-flight `workflow_execute_batch` jobs detect this at their next periodic check (§7.4 step 6) and stop.

### 7.6 Retention (`workflow_history_purge`)

`WorkflowHistoryPurgeTask` (`@Cron` nightly at midnight, mirrors `JobHistoryPurgeTask`) enqueues a global `workflow_history_purge` job when none is already pending/running. `WorkflowHistoryPurgeHandler` does two things every run:

1. **Expires stale approvals** — `awaiting_approval` runs whose `updatedAt` is older than `workflows.previewTtlHours` become `expired`.
2. **Deletes terminal runs** older than `workflows.runHistoryRetentionDays`, batched at 5,000 rows per delete (`workflow_run_items` cascade via FK) — the same lock-safe batching pattern as `job_history_purge`.

---

## 8. Scale Strategy

Production today is **~30k media items, ~25k faces, 200 GB**, expected to grow 4–5× (≈150k items, ~1 TB). A single workflow may legitimately match 100k–200k items. The concrete mechanisms that hold under that load:

- **No unbounded `COUNT(*)`.** `WorkflowsService.preview` never counts — it probes `LIMIT (cap + 1)` and reports `capped: true` ("10,000+") when the probe fills, exactly mirroring `GET /api/media`'s keyset-mode no-`COUNT(*)` rule (`CLAUDE.md`'s Media List/Gallery section).
- **Streamed, keyset-paginated evaluation** (§7.3) — 1,000-row pages, never a `findMany` of the full matched set, never a 150k-element ID array held in memory.
- **A hard per-run cap** (`workflows.maxItemsPerRun`, default 10,000, admin-tunable 100–500,000) plus a per-workflow `options.maxItems` override that can only make the effective cap *tighter*, never looser. Hitting the cap sets `truncated: true` — the UI surfaces "matched more than the cap, run again for the remainder"; because a workflow's actions mutate items out of the matched set (or the item stays matched but the *next* evaluation re-materializes only items not already `applied`/`excluded` in this workflow's history within the retention window — see the scheduled-trigger note in §9.2), re-running naturally makes progress on the remainder.
- **Background execution.** `workflow_execute_batch` runs at priority **100** — strictly lower priority than every upload-time enrichment job type (priority 0–10) — so a 150k-item workflow run never starves new uploads' face/tag/burst/dup enrichment.
- **`workflows.maxConcurrentRuns`** (default 2) bounds simultaneous non-terminal runs **app-wide**, not per-circle — checked at manual run-create (409 on exceed) and at every scheduled-trigger tick (skip + roll `nextRunAt` forward rather than queue a backlog).
- **Per-item idempotency** (§7.4 step 1) — an OOM, a redeploy, or a stuck-job reset mid-run resumes cleanly: a re-claimed batch skips every item already terminal and only processes what's left, under the exact same claim-time-`attempts`/stuck-job machinery every other `enrichment_jobs` type uses.
- **Retention** (§7.6) bounds the unbounded growth of `workflow_runs`/`workflow_run_items` over time, mirroring `job_history_purge`.

---

## 9. Trigger Semantics

### 9.1 `manual`

`POST /api/workflows/:id/run` — synchronous 409 on the concurrency gate, otherwise `evaluating` immediately. See §7.

### 9.2 `scheduled`

`workflow.cronExpression` is a validated 5-field cron (`isValidCron`, `apps/api/src/workflows/util/cron.util.ts`) with a **minimum fire interval** enforced at save time — `cronMinIntervalMinutes(expr)` samples the next ~20 fires and rejects a cron denser than `workflows.scheduleMinIntervalMinutes` (default 60 minutes; a `*/5 * * * *` or a comma-burst schedule is caught, not just an obviously-dense `* * * * *`).

`WorkflowScheduleTask` (`@Cron(EVERY_MINUTE)`) scans `workflows` where `trigger='scheduled' AND enabled=true AND nextRunAt <= now` (served by the `(trigger, enabled, nextRunAt)` index), capped at 100 due workflows per tick. For each due workflow it applies, in order:

1. **Overlap guard** — a run for the same workflow already `evaluating`/`awaiting_approval`/`running` → skip and roll `nextRunAt` forward. Never a second concurrent run of one workflow.
2. **Concurrency guard** — starting this run would exceed `workflows.maxConcurrentRuns` app-wide → skip and roll forward. The scheduler never backlogs a missed tick; a skipped fire is simply gone, not queued.
3. Otherwise: `WorkflowRunService.startUnattendedRun(workflow, 'scheduled')` — straight past `awaiting_approval` per §7.2 — then roll `nextRunAt` forward regardless of outcome (including on a caught per-workflow error, so one poison workflow can never wedge the tick for the other 99).

`startUnattendedRun` authorizes using **the workflow's creator's** current effective permissions (loaded fresh via `UserRole` → `RolePermission` at trigger time, not cached from creation) — a creator who has since lost `media:delete` will silently skip a `hard_delete`-gated run rather than crash the scheduler (logged as a warning). A workflow with no `createdById` (creator account deleted, `SetNull` FK) can never be triggered unattended — logged and skipped.

**Cheap on an unchanged library.** A nightly scheduled run against a stable 150k-item library re-evaluates the same conditions but the items it would re-match were already `applied` (or `excluded`) by a prior run of the *same workflow* — see §9.1's re-run note. There is no additional dedup index specific to this; it falls naturally out of the `@@unique([runId, mediaItemId])` constraint plus each new evaluation being a fresh `workflowRunItem.createMany` against a fresh `runId` — an item that already satisfies the conditions but was already actioned by a prior run of this workflow is not automatically excluded from re-matching by the compiler (the compiler has no "already handled" awareness); in practice this means an idempotent action (e.g. `add_tags` on a tag the item already has) simply no-ops (`skipped: noop`) rather than erroring, so a nightly sweep over a stable library costs real evaluation work but zero actual mutation.

### 9.3 `on_media_enriched`

Goal: evaluate each newly-uploaded item **exactly once**, as soon as the enrichment its specific conditions depend on is available — not before (a face-based condition evaluated before face detection ran would silently under-match) and not forever-stalled (a failed or empty enrichment must not strand the item).

**Dependency-aware settlement.** `WorkflowTriggerListener` reacts to two upstream signals:
- `OBJECT_PROCESSED_EVENT` — the metadata-settled signal, fired once per upload's storage-processing pipeline.
- `ENRICHMENT_JOB_SETTLED_EVENT` — a per-producer signal, filtered to `reason === 'upload'` only (loop protection, below) and mapped `auto_tagging→tags`, `face_detection`/`video_face_detection→faces`, `burst_detection→bursts`, `duplicate_detection→duplicates`, `location_inference→locationSuggestions`.

For a settled dependency, `WorkflowTriggerListener.evaluateSettlement` runs **one cheap indexed query** — `workflows WHERE circleId=? AND enabled=true AND trigger='on_media_enriched'` (served by the `(circleId, enabled)` index) — and returns immediately if the circle has none (the common bulk-import case). For each candidate workflow it derives the workflow's dependency set (`WorkflowConditionCompiler.deriveDependencies`), builds the item's current per-dependency `DependencyState` snapshot, and only proceeds when **both**: the just-settled dependency is one this workflow actually reads (otherwise a metadata-only workflow would fire redundantly on every subsequent tag/face/burst/dup/location settlement — up to ~6× redundant enqueues per item during a bulk import), **and** `isFullySettled(deps, state)` — every dependency the workflow reads has reached a terminal outcome.

"Terminal" is defined generously so nothing strands forever: `tags` is settled once `media_tag_status` is `processed` **or** `failed` (or the feature is off); `faces` similarly includes `no_faces` and the social-media-flagged-video case where face detection was never even queued; `bursts`/`duplicates`/`locationSuggestions` are settled once their respective group/suggestion exists **or** no producer job is currently `pending`/`running` for that item (i.e. it ran and produced nothing). A workflow with **zero** conditions (an "apply to everything" rule) is keyed to `metadata` alone, so it still fires exactly once per upload.

**Mechanics.** A settled, matching workflow gets a `workflow_evaluate_item` job (priority 50, `payload: { workflowId, mediaItemId }`, `skipDedup: true` — dedup by `(type, mediaItemId)` would collapse a second candidate workflow's job for the same item, so idempotency instead comes from the evaluate-once guard below plus `@@unique([runId, mediaItemId])`). `WorkflowEvaluateItemHandler.process`:

1. Re-checks the feature/trigger toggles and the workflow's live `enabled`/`trigger` state.
2. **Evaluate-once guard** — if this `mediaItemId` already has a `workflow_run_item` on **any** run of this workflow, skip. This is both the "don't double-evaluate" rule and the loop-protection backstop (below).
3. Single-item indexed condition check against the workflow's **current** (not snapshotted — no run exists yet) definition.
4. On a match, atomically **append to** (or **open**) a rolling **micro-run** for the workflow.

**Rolling micro-runs.** Rather than one `workflow_run` per matched item (which would turn a 10,000-photo bulk import into 10,000 run-history rows), matches within a 5-minute collection window (`MICRO_RUN_WINDOW_MINUTES`, a code constant, not a system setting) are collected into one open `workflow_run` (`triggerType='on_media_enriched', status='running'`). `startedAt` marks window-open; `approvedAt` is repurposed as the **dispatch marker** (null = still collecting, set = execute-batches enqueued). Open-or-append is serialized per workflow via `SELECT ... FOR UPDATE` on the `workflows` row, guaranteeing at most one open micro-run per workflow at any time. `WorkflowMicroRunFinalizeTask` (`@Cron(EVERY_MINUTE)`) finds micro-runs whose window has elapsed, race-safely claims dispatch (a conditional `updateMany` stamping `approvedAt`), and calls the same `enqueueExecuteBatches` every other run path uses — after which the ordinary `workflow_execute_batch` drain-and-finalize (§7.4) takes over. A crash mid-window simply leaves the micro-run `running` with `approvedAt IS NULL`; the finalize task's next tick picks it up. A micro-run that somehow opens with zero matched items (shouldn't happen — one only ever opens on a match) finalizes straight to `completed`.

**Loop protection — how a first-upload settlement is distinguished from a workflow's own mutations.** Three independent layers:
1. `ENRICHMENT_JOB_SETTLED_EVENT` only re-settles workflows for `reason === 'upload'`. Every workflow-applied re-enqueue uses `reason: 'rerun'` (`assign_person`'s auto-tagging refresh, `rerun_enrichment`, `move_to_circle`'s target-circle re-enrichment uses `reason: 'upload'` in the **target** circle — a deliberate, legitimate exception documented below).
2. `OBJECT_PROCESSED_EVENT` is emitted only by the original upload/processing pipeline; a metadata rerun (`POST /api/media/:id/metadata/rerun`) deliberately never emits it.
3. The evaluate-once guard (step 2 above) is the backstop: even if a mutation somehow re-fired a settlement signal for an item, that item already has a `workflow_run_item` on this workflow and is skipped. This closes both a workflow→enrichment→workflow self-loop and a mutual-trigger loop between two different `on_media_enriched` workflows.

`move_to_circle`'s target-circle re-enrichment is the one case that **legitimately** re-triggers `on_media_enriched` workflows — the moved item is now, correctly, a fresh upload in a new circle, and any `on_media_enriched` workflow *in that target circle* should get a first look at it. This is a real fresh-enrichment cycle, not a loop, because it happens in a different circle than where the moving workflow ran.

---

## 10. Safety Model

### 10.1 `hard_delete`

Off by default (`workflows.allowHardDelete: false`). Even fully unlocked, `hard_delete` requires **all** of:
- `workflows.allowHardDelete = true` (system setting).
- Actor holds `media:delete` in addition to `media:write` (`HARD_DELETE_PERMISSION`).
- **`triggerCompatibility: 'manual_only'`** — rejected at definition-validation time (`WorkflowsService.assertActionsAllowedForTrigger`) for `scheduled`/`on_media_enriched` triggers. This is enforced *both* on create and update, so a workflow cannot be authored manual-with-hard-delete and then silently retargeted to `scheduled`.
- A reviewed preview + a **typed confirmation** at approval matching `"DELETE {matchedCount}"` exactly (§7.5) — not a generic checkbox, the exact count the user was shown at preview time.

A `hard_delete` action's outcome is `terminal: true` — remaining actions on that item never run, since the row (and its storage blob) is gone.

### 10.2 `move_to_circle`

Both-circle collaborator + `media:write` is checked **three times** across the lifecycle: at run-create (`checkGatedActionPermissions`), again at approval (time may have passed, permissions may have changed), and a third time inside the executor itself at actual execute time (§6.3 step 1) — the only action re-verified this defensively, because it is the only one whose effect (moving data out of the actor's visibility) cannot be trivially undone by a subsequent permission check on the *original* circle alone.

### 10.3 Trash-variant of review-queue resolves

`resolve_burst_group`/`resolve_duplicate_group` with `{ action: 'trash' }` additionally require `media:delete` (`extraPermForTrashVariant`), checked identically at create and approval; the `archive` variant only needs base `media:write`.

### 10.4 Unattended-trigger restriction

Per §7.2 and §10.1: `hard_delete` is unconditionally rejected on `scheduled`/`on_media_enriched` at definition-save time — there is no admin override that re-enables it for an automatic trigger. Every other action (including trash, archive, and all review-queue resolutions) is allowed on every trigger because each is reversible or recoverable.

### 10.5 Preview-first (manual runs)

`workflows.requirePreview` (default `true`) plus the per-workflow `options.requirePreview` together gate whether a **manual** run stops at `awaiting_approval` (§7.2). This is the mechanism that lets a user watch the live match count and a 12-item thumbnail sample (`POST /api/workflows/preview`) move as they refine conditions in the builder, then see the *exact same* materialized set again before committing — the single clearest way to confirm a rule does what the user means, and the reason this feature is a batch/query engine with a review step rather than a blind bulk-action button.

---

## 11. Node Execution (Compute/Persist Split)

### 11.1 Why `workflow_execute_batch` is node-eligible but the other three types are not

`workflow_evaluate`, `workflow_evaluate_item`, and `workflow_history_purge` are pure SQL sweeps over the whole media table (or a single-row lookup against live definitions) with no per-item unit of work a node could meaningfully claim — the same precedent as the `location_inference` sweep and `thumbnail_repair`. They stay **server-only**: no `nodeResultSchema`/`persistNodeResult` pair, absent from the CLI's `NODE_JOB_TYPES`.

`workflow_execute_batch` **is** node-eligible (`WorkflowExecuteBatchHandler.nodeResultSchema = workflowExecuteBatchResultSchema`, imported from `@memoriahub/enrichment-compute/dto`), but the compute/persist split here is unusually thin, and the spec is explicit that this is about **posture completeness, not CPU offload**: a workflow batch is entirely DB-bound (no media bytes — `inputUrl` is `null`, like every other global job with no `mediaItemId`; no CPU-heavy model inference). The node's compute module (`apps/cli/src/node/compute/workflow-execute-batch.ts`) does the absolute minimum: it reads the frozen per-item `itemIds` and the frozen action-type list from the claim's `params`, and returns a **declared-intent-only** result — `{ runId, items: [{ mediaItemId, actionResults: [{ type, status: 'pending' }] }] }` — without ever touching a database or mutating anything.

`WorkflowExecuteBatchHandler.persistNodeResult` **deliberately ignores** the submitted `result` as a source of truth. It re-runs the exact same `executeBatch` pipeline `process()` runs, from the **trusted `job.payload`** (`runId`, `itemIds`) — the full per-item idempotent claim, drift re-validation, ordered action execution, `move_to_circle`'s cross-circle dedup + both-circle permission re-check, counters, and run finalization. A stale or malicious node result can therefore never bypass any guard; the node's declared intent is advisory only, purely for interface-parity with every other node-eligible handler's compute/persist shape. Late submissions after lease expiry are already 409-rejected by the shared job-scoped guard (`NodesService.assertJobHeldByNode`) shared with every other job-scoped node endpoint, so no additional staleness check is needed in this handler.

### 11.2 Why the type is *also* server-claimable in `system` mode

`workflow_execute_batch` needs no models and no native dependencies — `JOB_TYPE_REQUIREMENTS['workflow_execute_batch'] = []` in `apps/cli/src/node/capabilities.ts` — so a lean CLI install (no `optionalDependencies` resolved at all) can still advertise it. But the type is **also** kept in `systemModeEligibleTypes()`'s claim set (`apps/api/src/enrichment/enrichment-job.worker.ts`), alongside the genuinely server-only types and `thumbnail_repair`. The rationale: an `ENRICHMENT_WORKER_MODE=off` fleet-only deployment must still execute workflows even with zero nodes registered, and a `system`-mode deployment (server runs sweeps, fleet runs per-item media compute) should keep working out of the box rather than silently stalling every workflow run until an operator registers a node. Both the server's in-process worker and any node can claim `workflow_execute_batch` jobs; `FOR UPDATE SKIP LOCKED` (the same atomic claim primitive `EnrichmentClaimService` and `POST /api/nodes/:id/claim` already share) makes that dual-eligibility race-safe.

### 11.3 CLI eligibility

`workflow_execute_batch` is listed in `NODE_JOB_TYPES` (`apps/cli/src/node/capabilities.ts`) and in `ComputeDispatcher`'s routing table, lazy-loading `node/compute/workflow-execute-batch.js`. `node doctor` and the models manifest report it as **always ready** — no capability requirements, no manifest entries — so it is eligible on the leanest possible worker install.

---

## 12. Data Model

Three tables ship entirely in Phase 1 (#139) — nothing structural was added in Phases 2–6, which reuse `enrichment_jobs` for job types and `system_settings` for configuration.

### `workflows`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `circle_id` | uuid, FK → `circles`, CASCADE | circle-scoped |
| `name` / `description` | text / text? | display only |
| `subject_type` | `WorkflowSubject` enum | v1: `media_item` only |
| `enabled` | boolean, default true | disabled workflows never trigger; manual run is also blocked when checked at the UI layer (the API itself does not currently 400 a manual run of a disabled workflow — see the API.md gap note) |
| `trigger` | `WorkflowTrigger` enum (`manual`\|`on_media_enriched`\|`scheduled`) | |
| `cron_expression` | text? | required iff `trigger='scheduled'`; validated 5-field cron with a min-interval floor |
| `next_run_at` | timestamptz? | maintained by `WorkflowScheduleTask` |
| `definition` | JSONB | versioned, Subject-tagged document (§4) |
| `created_by_id` | uuid?, FK → `users`, SetNull | authorizes unattended runs (§9.2) |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(circle_id, enabled)` (serves the on-enrichment listener's backpressure query, §9.3), `(trigger, enabled, next_run_at)` (serves the scheduler scan, §9.2).

### `workflow_runs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workflow_id` | uuid, FK → `workflows`, CASCADE | |
| `circle_id` | uuid, FK → `circles`, CASCADE | denormalized from the parent workflow |
| `status` | `WorkflowRunStatus` enum | §7.1 |
| `trigger_type` | `WorkflowTrigger` enum | how *this run* started |
| `definition_snapshot` | JSONB | frozen copy of `definition` at run-start (§4) |
| `matched_count` | int, default 0 | |
| `truncated` | boolean, default false | matched more than the effective cap (§7.3, §8) |
| `processed_count` / `succeeded_count` / `failed_count` / `skipped_count` | int, default 0 | §7.4 |
| `started_by_id` / `approved_by_id` | uuid?, FK → `users`, SetNull | `approved_at` is repurposed as the micro-run dispatch marker for `on_media_enriched` runs (§9.3) |
| `created_at` / `approved_at` / `started_at` / `finished_at` | timestamptz? | |
| `last_error` | text? | |

Indexes: `(workflow_id, created_at)` (run history), `(circle_id, status)`, `(status, updated_at)` (the app-wide concurrency-gate count and the retention/stuck-run sweeps).

### `workflow_run_items`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `run_id` | uuid, FK → `workflow_runs`, CASCADE | |
| `media_item_id` | uuid, FK → `media_items`, CASCADE | **see §3.3 for the forward-compat generalization this column will need** |
| `status` | `WorkflowRunItemStatus` enum (`matched`\|`excluded`\|`applied`\|`partially_applied`\|`failed`\|`skipped`) | |
| `action_results` | JSONB? | per-action outcome array, §7.4 |
| `error` | text? | first-failure detail |
| `updated_at` | timestamptz | |

`@@unique([runId, mediaItemId])` is the idempotency anchor for batch retries — the same pattern as `storage_migration_items`' `@@unique([runId, objectId])`. Index `(run_id, status)`.

---

## 13. API Endpoints

All routes are circle-scoped (except the Admin plane) and feature-gated by `features.workflows` + `WORKFLOWS_ENABLED` (404 when off, via `assertFeatureEnabled()` in every service). No new RBAC permission was introduced — the feature reuses `media:read`/`media:write`/`media:delete` plus per-circle `viewer`/`collaborator` roles, exactly mirroring the bulk-media-ops permission model; the Admin plane reuses `system_settings:*`/`jobs:*`.

### Workflow CRUD, preview, and subjects (`WorkflowsController`)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/workflows` | `media:write` + collaborator | Validates the definition (registry-aware); enforces `workflows.maxWorkflowsPerCircle`; rejects `hard_delete` on a non-manual trigger; audits `workflow:created` |
| `GET /api/workflows?circleId=&page=&pageSize=` | `media:read` + viewer | Paginated list, each item includes derived `dependencies[]` |
| `GET /api/workflows/subjects` | `media:read` | Returns the full per-Subject registry — fields (with operators/valueType/enumValues/dependency), actions (type/label/destructive), and valid triggers, per Subject. Drives the builder's dynamic form. **Declared before `:id` in the controller so it is never captured as a workflow id** |
| `POST /api/workflows/preview` | `media:read` + viewer | body `{ circleId, definition }` — **stateless**: `{ matchedCount, capped, sample: [≤12 items w/ signed thumbnailUrl] }`. Count is bounded by `LIMIT (cap+1)`, never a full `COUNT(*)` (§8) |
| `GET /api/workflows/:id` | `media:read` + viewer | |
| `PATCH /api/workflows/:id` | `media:write` + collaborator | Partial update; re-validates trigger/action compatibility against the *resulting* (post-patch) definition+trigger, since either side may have changed; recomputes/clears `nextRunAt` as appropriate; audits `workflow:updated` |
| `DELETE /api/workflows/:id` | `media:write` + collaborator | Cascades runs + items; audits `workflow:deleted`; 204 |

### Runs (`WorkflowsController` for start/list-by-workflow, `WorkflowRunsController` for detail/items/approve/cancel)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/workflows/:id/run` body `{ maxItems? }` | `media:write` + collaborator | `{ runId, status }`; 409 if `workflows.maxConcurrentRuns` exceeded; enforces gated-action authorization (feature flags, both-circle perms) at create time; audits `workflow_run:started` |
| `GET /api/workflows/:id/runs?page=&pageSize=` | `media:read` + viewer | Run history for one workflow |
| `GET /api/workflow-runs/:id` | `media:read` + viewer | Run detail: counts, `itemStatusCounts` (per-status tally via `groupBy`), and a bounded (5,000-row-scanned) best-effort per-action-type `actionSummary` |
| `GET /api/workflow-runs/:id/items?status=&page=&pageSize=` | `media:read` + viewer | Paginated items with batched signed thumbnails (`MediaThumbnailService.attachThumbnailUrls`) |
| `POST /api/workflow-runs/:id/approve` body `{ excludedItemIds?≤500, confirmation? }` | `media:write` + collaborator | `hard_delete` present → `confirmation` must equal `"DELETE {matchedCount}"`; re-checks gated-action authorization; audits `workflow_run:approved` (+ `workflow_run:hard_delete_approved` with count when applicable) |
| `POST /api/workflow-runs/:id/cancel` | `media:write` + collaborator | Any non-terminal run; audits `workflow_run:cancelled` |

### Admin plane (`WorkflowsAdminController`) — cross-circle oversight

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/admin/workflows/stats` | Admin + `system_settings:read` | KPI strip: `{ windowDays: 7, runsLast7Days, itemsActioned, failures, currentlyRunning }` |
| `GET /api/admin/workflows?page=&pageSize=&circleId=&trigger=&enabled=` | Admin + `system_settings:read` | Every workflow across every circle, with circle/creator, last-run summary, and lifetime `totals: { runs, matched, actioned }` (bounded, indexed aggregates — no unbounded scan of `workflow_run_items`) |
| `GET /api/admin/workflow-runs?status=&page=&pageSize=&circleId=&workflowId=` | Admin + `jobs:read` | Every run across every circle |
| `POST /api/admin/workflows/:id/disable` | Admin + `system_settings:write` | Force-disables a workflow regardless of circle membership (an admin override, independent of the owning circle's own toggle); audits `workflow:admin_disabled` |
| `POST /api/admin/workflow-runs/:id/cancel` | Admin + `jobs:write` | Stops a runaway run app-wide, no circle-membership check; delegates to the same `WorkflowRunService.adminCancelRun` path; audits `workflow_run:admin_cancelled` |

Audit events emitted across the feature: `workflow:created` / `workflow:updated` / `workflow:deleted` / `workflow:admin_disabled`, `workflow_run:started` / `workflow_run:approved` / `workflow_run:cancelled` / `workflow_run:completed` / `workflow_run:admin_cancelled` / `workflow_run:hard_delete_approved`.

---

## 14. RBAC

No new permission strings were introduced. Every action's authorization resolves through its `WorkflowActionPermission` descriptor (§6, `apps/api/src/workflows/registry/field-descriptor.interface.ts`):

- `circleRole: 'collaborator'` — always, for every action, in v1.
- `systemPerms: string[]` — `media:write` for the base case, `media:write` + `media:delete` for `hard_delete`.
- `gates?: string[]` — a system-settings feature-flag path that must be truthy (`workflows.allowHardDelete` for `hard_delete`).
- `bothCircles?: boolean` — `move_to_circle` only; requires collaborator + `media:write` on **both** the source and target circle.
- `extraPermForTrashVariant?: 'media:delete'` — the `{action:'trash'}` variant of the two review-queue resolve actions.

`WorkflowRunService.checkGatedActionPermissions` walks every action in a definition and asserts all of the above at **both** run-create and run-approval time (§10.2). Viewers can read workflows/runs but never create, edit, run, or approve. The Admin plane's endpoints are entirely separate and reuse the existing `system_settings:read`/`system_settings:write`/`jobs:read`/`jobs:write` permission pairs already documented for the Job Queue and Doctor features.

---

## 15. Settings Reference

The entire `workflows.*` schema and its defaults shipped in Phase 1 (#139) so every later phase reads through the one cached `SystemSettingsService.getSettings()` call (5 s TTL) with no further schema change. See `apps/api/src/common/types/settings.types.ts`.

| Setting | Type / Range | Default | Enforced In |
|---|---|---|---|
| `features.workflows` | boolean | **false** | Global on/off; env kill-switch `WORKFLOWS_ENABLED=false` overrides it everywhere (`isWorkflowsEnabled()`) |
| `workflows.maxItemsPerRun` | int, 100–500,000 | 10,000 | Hard cap on items materialized per run (§7.3, §8) |
| `workflows.batchSize` | int, 50–1,000 | 200 | Items per `workflow_execute_batch` job (§7.4) |
| `workflows.maxConcurrentRuns` | int, 1–10 | 2 | App-wide simultaneous non-terminal runs (§8, §9.2) |
| `workflows.requirePreview` | boolean | true | Manual-run approval gate (§7.2, §10.5); does not apply to unattended runs |
| `workflows.allowHardDelete` | boolean | **false** | Unlocks `hard_delete` app-wide (§10.1); still needs `media:delete` + manual trigger + typed confirmation |
| `workflows.maxWorkflowsPerCircle` | int, 1–100 | 20 | Enforced at `POST /api/workflows` |
| `workflows.previewTtlHours` | int, 1–168 | 24 | `awaiting_approval` runs older than this expire (§7.6) |
| `workflows.runHistoryRetentionDays` | int, 1–365 | 30 | Terminal run/item retention (§7.6) |
| `workflows.triggers.onEnrichment` | boolean | true | Master switch for `on_media_enriched` (§9.3) |
| `workflows.triggers.scheduled` | boolean | true | Master switch for `scheduled` (§9.2) |
| `workflows.scheduleMinIntervalMinutes` | int, 60–10,080 | 60 | Tightest allowed cron cadence (§9.2) |

**Env kill-switch:** `WORKFLOWS_ENABLED` — set to `false` to disable regardless of `features.workflows`; the runtime toggle is the system setting, this env var is a hard CI/test override (same convention as every other `*_ENABLED` kill-switch in `CLAUDE.md`).

**Not a system setting:** `MICRO_RUN_WINDOW_MINUTES = 5` — the rolling micro-run collection window (§9.3) is a code constant in `workflow-evaluate-item.handler.ts`, deliberately not admin-tunable in v1.

---

## 16. Admin UI, Doctor, and Observability

### 16.1 `/admin/settings/workflows`

A sub-page in the Settings hub's Operations group, mirroring the bursts/duplicates settings-page pattern: feature + per-trigger toggles, every numeric limit above with inline scale-rationale help text, a visually-separated **danger card** for the hard-delete unlock (`WorkflowsDangerCard.tsx`), a KPI strip (`GET /api/admin/workflows/stats`), and the cross-circle oversight table (`WorkflowsOversightTable.tsx`, `GET /api/admin/workflows`) with per-row disable + view-runs actions.

### 16.2 Doctor check

`workflows.state`, in its own `workflows` Doctor section (`apps/api/src/doctor/doctor.service.ts`):

- **`skipped`** when `features.workflows` is off.
- **`warning`** when any of: the `WORKFLOWS_ENABLED` env kill-switch overrides an enabled feature flag; any `evaluating`/`running` run has gone without a counter-progress update (`updatedAt`) past the stuck threshold; any `awaiting_approval` run is past its `previewTtlHours` TTL but has not been expired (signals the purge cron may not be running); or enabled `scheduled` workflows exist while `workflows.triggers.scheduled` is off (they will never fire). Each surfaces its own `actionItem`.
- **`ok`** otherwise. Standard 10 s per-check timeout, pure DB reads, no live provider calls.

### 16.3 Job queue integration

All four workflow job types appear automatically in `/admin/settings/jobs`'s by-type stats, filters, and `/admin/settings/jobs/insights` duration/ETA breakdowns, with friendly labels (`apps/api/src/enrichment/job-type-labels.ts`): `workflow_evaluate` → "Workflow evaluate", `workflow_evaluate_item` → "Workflow evaluate (item)", `workflow_execute_batch` → "Workflow execute batch", `workflow_history_purge` → "Workflow history purge".

### 16.4 Tracing and logging

`WorkflowEvaluateHandler` and `WorkflowExecuteBatchHandler` wrap their work in OTEL spans (`workflow.evaluate`, `workflow.execute_batch`, and `workflow.execute_batch.persist_node_result` for the node-result path) tagged with `workflow.run_id`/`workflow.id`/`workflow.circle_id`/`workflow.batch_size`. Every run-state transition emits a structured Pino log line (`event: 'workflow_run.<transition>'`) tagged with `runId`/`workflowId`/`circleId`/`triggerType`, across `WorkflowRunService`, `WorkflowEvaluateHandler`, and `WorkflowExecuteBatchHandler`.

---

## 17. CLI

`apps/cli` gains a thin, PAT-authed, circle-scoped `memoriahub workflow` command group (`apps/cli/src/commands/workflow.ts`) for headless operation — the **web UI remains the primary authoring surface**; these three subcommands cover only the most useful headless actions:

- `memoriahub workflow list [--circle <id>]` — table of workflows in the active (or explicit) circle: id, name, subject, trigger, enabled.
- `memoriahub workflow run <id> [--max-items <n>]` — start a run; prints the new `runId` and its initial status.
- `memoriahub workflow runs <id>` — table of recent runs for a workflow: id, status, trigger, matched/succeeded/failed/skipped counts, created time.

All three require `requireConfig()` (an existing login). See §11.3 for the CLI's `workflow_execute_batch` worker-node compute eligibility — a separate concern from these authoring/oversight subcommands.

---

## 18. Testing Notes

Representative coverage that shipped alongside each phase (see the corresponding `*.spec.ts` next to each source file listed throughout this doc):

- **Definition validation** — subject-registered check, unknown/cross-Subject field or action rejection, exactly-one-level nesting enforcement, every operator/value-type mismatch case in `WorkflowDefinitionValidator.validateOperand`.
- **Compiler** — per-condition-type `where` fragment output (including the review-state descriptors and the documented `duplicateGroupConfidence` bounding-only behavior), all/any/group AND/OR composition never colliding on a shared key, dependency-set derivation, refinement collection only on a pure-AND path.
- **Run lifecycle** — every state transition including `partially_applied`/`completed_with_errors`, the concurrency-gate 409, `maxItems` precedence (run-body > per-workflow option > system ceiling), per-item idempotency across a simulated batch retry, the drift re-validation skip path, cancellation mid-batch, the approval-bypass matrix (manual vs. unattended, gated vs. ungated), the hard-delete typed-confirmation gate (missing/wrong confirmation → 400).
- **Actions** — each action's params-schema edge cases (`set_captured_at`'s three-mode exclusivity, null-`capturedAt` skip under `shift`), `move_to_circle`'s dedup-conflict skip and both-circle permission enforcement, the review-queue actions' `same_group`/`no_pending_target`/`no_suggested_best` skip reasons, the trash-variant `media:delete` gating.
- **Triggers** — dependency-set settlement across every condition-mix combination (including failed/empty-enrichment terminal states and review-queue deps), the evaluate-once + loop-protection guard (a workflow-applied mutation does not re-fire evaluation), micro-run open/append/finalize race-safety, cron validation + the minimum-interval floor, `nextRunAt` advancement, the scheduler's overlap and concurrency guards.
- **Admin plane** — non-admin 403 on every admin endpoint, an admin cancel of a running run, settings changes taking effect within the cached-settings TTL window, each Doctor-check state.
- **Node execution (#144)** — `nodeResultSchema` validation shape, `persistNodeResult`'s re-derivation-from-`job.payload` behavior (a node's declared `result` is provably never trusted), a full claim → compute → submit → `persistNodeResult` integration path against a registered test node, a lease-expiry reap → server re-claim → no-double-apply scenario, and a parity assertion that server-executed and node-executed batches produce identical `workflow_run_items` outcomes (`server-only-types.spec.ts`'s drift guard covers the claim-set derivation itself).

---

## 19. Future Work

- **Additional Subjects** (`duplicate_group`, `burst_group`, `location_suggestion`, `unassigned_face`/`person`) as first-class entities, per §3 — the registry and the `workflow_run_items` generalization (§3.3) are the two pieces this needs; neither is built yet.
- **Field interpolation** (`{{field}}` inside action params, e.g. tag = `{{cameraModel}}`, album name = `{{captureYear}}`) — noted in the epic as a deliberate post-v1 stretch, not core.
- **`semanticQuery` conditions** — needs embedding coverage and a similarity-threshold UX; deferred from Phase 1.
- **`duplicateGroupConfidence`'s exact comparison** (§5.3) — currently a bounding-only predicate; a true per-candidate CLIP-similarity compute pass at evaluation/preview time was explicitly deferred.
- **"Retry failed items"** on a terminal run (re-run scoped to just the failed subset) — called out as a stretch goal in the Phase 3 UI spec that may slip to a follow-up; not shipped.
- **A visual node/canvas editor** — the versioned, Subject-tagged JSON definition format exists specifically to allow this later without a schema migration.

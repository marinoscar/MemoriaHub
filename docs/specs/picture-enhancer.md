# AI Picture Enhancer — Feature Spec

| Field | Value |
|-------|-------|
| **Version** | 1.3 (Implemented) |
| **Last Updated** | August 2026 |
| **Status** | Implemented (v1.3) — see [Implementation status (v1)](#implementation-status-v1) below for scope shipped vs. deferred |
| **Owner** | oscar@marin.cr |
| **Scope** | Photos only. Single-item and bulk (batched), human-reviewed, non-destructive by default. |

> This document was originally written to double as the body of a GitHub feature issue (#98) **and** as the eventual `docs/specs/` spec. Sections still marked **⟐ Decision for review** below are preserved for historical context; each is now resolved per the [Implementation status (v1)](#implementation-status-v1) note and the updated [§14 Open Decisions Summary](#14-open-decisions-summary).

### Implementation status (v1)

GitHub issue #98 shipped in two passes. The first pass landed DB migration, backend (endpoints, enrichment job handler, purge cron, OpenAI provider method), and frontend (gallery/lightbox triggers, compare-and-decide drawer, Admin AI settings). A follow-up pass (phase G, same issue) closed two "shipped but unreachable/broken" gaps and added presets, EXIF carryover, and a drawer rebuild. What follows is "what v1 actually does" as of the follow-up pass:

- **The feature was unreachable for non-admins — fixed.** The web gate read `features.pictureEnhancement` off `GET /api/system-settings`, which requires the Admin-only `system_settings:read` permission; every non-admin circle member got a 403 and the AI Enhance button never rendered, and neither did the `/admin/settings/enhancer` toggle exist to turn the feature on in the first place (of the app's eight feature flags, `features.pictureEnhancement` was the only one with no UI toggle anywhere — the sole enable path was a hand-crafted `PATCH /api/system-settings`). Both are now fixed: a new least-privilege `GET /api/features` endpoint (§8.8) is readable by any authenticated user and backs the client gate, and a new `/admin/settings/enhancer` admin page (§9.6) provides the master toggle, a readiness panel, and all seven `pictureEnhancement.*` knobs.
- **EXIF writer SHIPPED — no longer deferred.** §5.1 originally listed three options and v1 shipped option (C) (in-app marker only). The follow-up pass adds **option (A)**: a new `ExifCarryoverService` (`apps/api/src/enhancement/exif-carryover.service.ts`), backed by `exiftool-vendored` (added to `apps/api`; `perl` added to the API Dockerfile base stage, mirroring `apps/cli`), copies the original's EXIF/GPS/IPTC/XMP/ICC onto the enhanced JPEG and stamps an AI marker. See the rewritten §5.1/§5.4 for the exact tag list. `pictureEnhancement.stampExif` now **defaults to `true`**, matching the original §7.1 draft.
- **Rate-limit handling FIXED — no longer a known limitation.** `OpenAiProvider.enhanceImage` now preserves the provider's HTTP `status` (plus `code` and any `Retry-After` hint) on the rethrown error, so a genuine OpenAI 429/529 is correctly classified by `classifyRateLimit` and routed through the rate-limit-deferral path instead of ordinary retry/backoff. A second, more severe bug fixed in the same pass: the handler previously marked the `media_enhancements` row `failed` on **any** error before rethrowing, but `process()` early-returns unless the row is `pending`/`processing` — so every queue-driven retry (and every rate-limit deferral) was a silent no-op that burned the job's attempt budget without re-running the work. The handler's catch is now a state machine that mirrors what `EnrichmentTerminalService` will do to the job: a retryable failure with attempts remaining rolls the row back to `pending` and rethrows; a rate-limited failure rolls back to `pending` and throws a normalized `RateLimitError`; only the last attempt tombstones the row `failed`. `ENRICHMENT_RATELIMIT_MAX_HITS` is now exported from `enrichment-terminal.service.ts` (alongside `ENRICHMENT_MAX_ATTEMPTS`) so handlers that mirror job state into a domain row can predict which outcome the queue is about to apply.
- **Presets added** (§4.1): `preset` param — `restore_old_photo` \| `low_light` \| `colorize_bw` \| `portrait_polish` — orthogonal to `intent`, plus a per-run `quality` override of `pictureEnhancement.defaultQuality`.
- **keep_both now inherits the source item's metadata**, not just the AI breadcrumb (§5.2) — a follow-up fix within the same pass.
- **Enhanced dimensions are read from the actual returned bytes**, not the requested canvas (§4.2) — `gpt-image-1` does not always honor the requested size, and the previous behavior could record wrong dims for the downscale warning and the keep_both item.
- **Drawer rebuilt** (§9.3) around the new presets, a distinguished queued-vs-enhancing progress state with elapsed time, a draggable before/after slider with side-by-side toggle and full-screen zoom, and client-side replace-policy gating.
- **§8.6 endpoints shipped as designed**: `PUT /api/ai/features/enhance` and `GET /api/ai/models?provider=openai&capability=image` (curated `['gpt-image-1']` list) both landed unchanged from the original draft.
- Two decisions from the original draft remain genuinely unshipped and are still open: the two-tier analyze-then-edit flag (`pictureEnhancement.analyzeFirst`, §4.3/§14 #4) and the first-class `aiEnhancedAt` column (§5.3/§14 #6). Everything else in this document (data model, endpoints, RBAC, config keys, Doctor check, retention cron) matches what was built; see [§14](#14-open-decisions-summary) for the resolved-decisions summary.
- **A second follow-up — issue #201 PR1, "the AI Enhancements hub" — landed after phase G** and shipped a cross-item landing spot for the feature, which until now was reachable only per-item (gallery selection bar / lightbox). New: a `GET /api/media/enhancements` endpoint (§8.9) listing every enhancement in a circle regardless of which media item it belongs to; a `/enhancements` hub page (§9.7) with three tabs — **Pending review is live** (list, expiry countdown, review/keep-both/discard actions), **Enhanced photos** and **History** are placeholders, both deferred to PR3; a new "AI Enhancements" entry in the sidebar's Utilities section carrying the app's first sidebar nav-badge; a `pendingEnhancements` count on `GET /api/media/dashboard`, landed in the same commit as a fix for a pre-existing contract drift (`pendingBurstGroups`/`pendingDuplicateGroups`/`pendingLocationSuggestions` were returned top-level while the web client read them under `counts.*`, leaving those three Home review-queue banners permanently dead); and `pictureEnhancement.retentionHours`'s default raised **72h → 168h (7 days)**, since a hub users work through over time — rather than a use-immediately dialog — was being undercut by a retention window that reaped unreviewed, already-billed enhancements before anyone got to them. Bulk actions on the hub (multi-select, threshold-based bulk resolve) are explicitly **not** part of PR1 — see §15.
- **Epic #420 shipped batch enhancement (§16)** — starting an enhancement for many photos at once, closing the gap the previous paragraph left open. `POST /api/media/bulk/enhance` (issue #421, an explicit id selection, gallery multi-select) and `POST /api/media/bulk/enhance/by-filter` (issue #424, a server-resolved filter match, e.g. "enhance this whole album") both queue ordinary `picture_enhancement` jobs — the same handler, same retry/rate-limit/timeout machinery as the single-item path — grouped under a new `media_enhancement_batches` row whose progress is entirely derived, never stored. A batch progress page (issue #423) reuses the shared `BaseRun` run-progress UI with no new component. This is a **batching layer, not a second execution engine**: contrast with the "Bulk enhancement" row that used to sit in §15 promising the shared `review_runs` evaluate/execute-batch engine — that plan was superseded once it became clear the per-item unit of work (the `picture_enhancement` job) already existed, so an evaluate/execute-batch pair would only re-implement OpenAI orchestration a second time. Bulk **review** (multi-select inside the `/enhancements` hub, acting on already-`ready` results) remains unshipped — see the corrected §15 row.

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [The Hard Constraint: OpenAI Has No "Enhancer"](#2-the-hard-constraint-openai-has-no-enhancer)
3. [End-to-End Flow](#3-end-to-end-flow)
4. [Enhancement Parameters](#4-enhancement-parameters)
5. [Metadata Copy & "AI Improved" Marking](#5-metadata-copy--ai-improved-marking)
6. [Data Model](#6-data-model)
7. [Configuration](#7-configuration)
8. [API Endpoints](#8-api-endpoints)
9. [Frontend / UI](#9-frontend--ui)
10. [RBAC](#10-rbac)
11. [Doctor Integration](#11-doctor-integration)
12. [Cost, Safety & Limitations](#12-cost-safety--limitations)
13. [Testing Notes](#13-testing-notes)
14. [Open Decisions Summary](#14-open-decisions-summary)
15. [Future Work](#15-future-work)
16. [Batch Enhancement](#16-batch-enhancement)

---

## 1. Overview and Goals

### The problem

A large fraction of a family library is casual phone/point-and-shoot photography: dim indoor shots, muddy colors, soft focus, crooked horizons, heavy noise. Users want a one-click "make this look better" that applies good photographic judgement — white balance, exposure/tone, color, sharpness, denoise, straightening — without them having to learn an editor. We already have the AI-provider plumbing (OpenAI credentials, per-feature model selection) and a destructive photo-edit precedent (orientation edit), so an **AI Picture Enhancer** is a natural addition.

The original request (v1): when **exactly one photo** is selected, a button in the selection top bar (and, mirroring the orientation editor, in the full-screen viewer) triggers an OpenAI image model to produce an enhanced version. The user then **reviews original vs. enhanced side-by-side** and chooses to **keep both** (enhanced saved as a new item) or **replace** the original. On replace, the enhanced file must carry over **all of the original's metadata** and be **marked as AI-improved** both in-app and, where possible, in the file's EXIF/XMP. *(Epic #420 — §16 — later extended this to a second, bulk entry point that queues the same per-item flow across many photos at once; the single-photo path described here is unchanged and still exists for a selection of exactly one.)*

### Goals

- **Photo-only.** Every enhance path — single-item and bulk (§16) alike — is gated by the same two-part photo guard: `MediaItem.type === photo` **and** `StorageObject.mimeType` starts with `image/`, matching the guard already used by orientation edit (`media-orientation-edit.service.ts:96`). *(Originally scoped as "the trigger appears only when exactly one selected item is a photo" — true for v1's single-item trigger, but epic #420 added a second, bulk trigger for a multi-photo selection; see §9.1/§16 for the current trigger split and §16.2's per-item eligibility partitioning rather than an all-or-nothing guard.)*
- **Non-destructive by default, human-in-the-loop.** The AI output is never auto-applied. It lands in a **staging preview** that the user must explicitly accept (keep both / replace) or discard. This is a safety requirement, not a nicety — see §2.
- **Reuse the AI feature pattern.** Model selection via a new `ai.features.enhance` config (provider + model), configured in Admin Settings → AI exactly like search/tagging/embedding.
- **Reuse the enrichment queue.** Enhancement is a slow external call (10–60 s), so it runs as an async `picture_enhancement` enrichment job, polled by the UI — not a synchronous request like orientation edit.
- **Reuse the destructive-edit precedent for "replace".** The replace path clones `MediaOrientationEditService`'s structure: download → transform → overwrite same storage key → update columns → `reprocessObjectNow` → re-enqueue face detection.
- **Global feature toggle** (`features.pictureEnhancement`, default `false`) + env kill-switch (`PICTURE_ENHANCEMENT_ENABLED`, default `true`), consistent with face recognition, auto-tagging, burst/duplicate detection, location inference, social-media detection.
- **Portable + queryable AI-improved marking.** A DB/tag marker inside the app (searchable) **and** a best-effort EXIF/XMP stamp in the file bytes.

### Non-Goals (v1)

- **No auto-enhance.** Enhancement is always explicitly requested by a human — never triggered on upload, never a background sweep. *(Bulk **starting** an enhancement for many photos at once shipped in epic #420 — see §16 — so "single selection only" is no longer accurate; what remains a non-goal is any path that starts an enhancement without an explicit human action.)*
- **No bulk review.** §16's batches queue work in bulk, but every result is still reviewed and decided on one photo at a time in the `/enhancements` hub — there is no multi-select "approve these 20 results" action. See the corrected §15 row.
- **No video.**
- **No non-OpenAI providers.** OpenAI-only in v1 (the model registry can add others later).
- **Not a super-resolution / upscaler.** The AI output is frequently *lower* resolution than the original (see §2); enhancement is about tone/color/clarity judgement, not adding pixels.
- **No C2PA content credentials** (cryptographic provenance) in v1 — a lightweight EXIF/XMP marker instead. C2PA is listed in Future Work.

---

## 2. The Hard Constraint: OpenAI Has No "Enhancer"

This shapes the entire design and must be understood before implementation.

OpenAI does **not** offer a traditional photo-enhancement endpoint (nothing like Lightroom auto-tone, a denoiser, or a super-resolution model). The only relevant capability is **generative image editing** via `client.images.edit` with the **`gpt-image-1`** model (the current image model; DALL·E is legacy). Today the codebase calls **no** image-generation/editing endpoint — `chat`, `analyzeImage` (vision), and `embedText` are the only OpenAI methods wired (`apps/api/src/ai/providers/openai.provider.ts`), and the chat model list *deliberately excludes* image models. So this endpoint is net-new.

Three consequences the spec has to design around:

1. **It regenerates, it doesn't retouch.** `gpt-image-1` re-paints the image guided by the prompt. It can subtly alter faces, garble fine text, and hallucinate details. **This is exactly why the human review gate (keep both / replace / discard) is mandatory and why nothing is ever auto-applied.** Mitigation: pass **`input_fidelity: 'high'`** (the gpt-image-1 parameter that maximally preserves the input image — critical for faces/detail) and a prompt that hard-forbids changing composition, identities, or adding/removing objects or text.
2. **Fixed, capped output resolution.** `gpt-image-1` returns one of `1024×1024`, `1024×1536`, `1536×1024`. A 12 MP phone photo comes back **downscaled**. The UI must surface the resolution delta prominently, and **replace** must warn (and optionally be blocked) when the enhanced image is smaller than the original. **⟐ Decision for review:** on downscale, do we (a) warn-and-allow replace, (b) block replace and only allow keep-both, or (c) `sharp`-upscale the AI output back toward the original's long edge (Lanczos) before storing so "replace" preserves dimensions at the cost of interpolated (not real) detail? *Recommended default: (a) warn-and-allow, never upscale — honest pixels, user decides.*
3. **"Fix orientation / straighten" is deterministic and free.** Don't spend an AI call on it. A `sharp` pre-pass auto-orients (bakes EXIF orientation upright, as `applyOrientationTransform` already does) before the AI step. True auto-*straighten* (rotating a crooked horizon by a few degrees) is not something `sharp` does automatically; in v1 we leave micro-straighten to the AI prompt and only guarantee EXIF-orientation normalization deterministically. **⟐ Decision for review:** include auto-straighten in the prompt scope, or defer? *Recommended: include as an optional prompt toggle, off by default.*

**Design stance:** a **hybrid pipeline** — deterministic pre-pass (`sharp` auto-orient) → generative AI pass (`gpt-image-1` edit with fidelity-preserving prompt) → deterministic post-pass (metadata copy + EXIF stamp) → human review gate.

---

## 3. End-to-End Flow

```
User selects 1 photo ─► clicks "AI Enhance" (top bar or lightbox)
        │
        ▼
POST /api/media/:id/enhance { params }
        │  creates MediaEnhancement row (status=pending)
        │  enqueues `picture_enhancement` job (priority 0)
        ▼
[enrichment worker]  picture_enhancement handler:
   1. load MediaItem + StorageObject, photo-only guard
   2. download original bytes (streamToBuffer)
   3. sharp pre-pass: auto-orient upright  (deterministic)
   4. build prompt from params (§4)
   5. openai.images.edit(model, image, prompt, size≈closest AR,
        quality (request override or defaultQuality), input_fidelity:'high',
        n:1)   ◄── the slow call
   6. receive enhanced bytes (JPEG); read ACTUAL pixel dims via sharp
        (the model does not always honor the requested canvas — the
        requested size is only a fallback if dims can't be read)
   6.5 EXIF carryover (§5.1/§5.4, gated on pictureEnhancement.stampExif,
        default true): copy the original's EXIF/GPS/IPTC/XMP/ICC onto the
        staged bytes and stamp the AI marker — ONCE, here, on the staged
        object; both keep_both and replace inherit it below. Re-read dims
        off the final (possibly stamped) bytes. Strictly best-effort —
        any failure keeps the unstamped bytes and never fails the job.
   7. upload to STAGING key: enhancements/<enhancementId>/result.jpg
        (NOT the original key — original untouched)
   8. record enhanced width/height/size; status=ready
      (on error → classify like EnrichmentTerminalService will and either
       roll the row back to pending + rethrow [retryable / rate-limited],
       or mark it failed on the terminal attempt — see Implementation
       status (v1) above)
        │
        ▼
UI polls GET /api/media/:id/enhance/:enhancementId  (2s interval)
        │  status=ready → { originalUrl, enhancedUrl, dims/size deltas }
        ▼
User reviews side-by-side, then ONE of:
        │
   ├─ POST …/apply { decision:'keep_both' }
   │     ► create NEW MediaItem in same circle from staging bytes
   │       (already EXIF-stamped from step 6.5), copy source metadata JSON
   │       (§5.2) + breadcrumb, new contentHash, enqueue upload enrichment.
   │       Original untouched. Staging object is promoted to the new
   │       item's StorageObject.
   │
   ├─ POST …/apply { decision:'replace' }   (destructive, like orientation edit)
   │     ► overwrite original storageKey with the already-stamped staged bytes
   │       NULL contentHash (force recompute), update width/height/size
   │       reprocessObjectNow(storageObject)  → thumbnails re-derive
   │       re-enqueue face_detection (best-effort, never fails request)
   │       mark MediaItem AI-enhanced (§5); delete staging object
   │
   └─ POST …/discard  ► delete staging object, row → discarded
```

**Why async (job) and not synchronous like orientation edit:** the OpenAI image call routinely takes 10–60 s and can be rate-limited; a synchronous request would risk gateway timeouts and hold a worker thread. The enrichment queue already gives us retry, rate-limit deferral (429/529), timeouts, and admin visibility in `/admin/jobs`. The UI polls a status endpoint exactly like `useMediaMetadata` does.

**Why a staging object and not overwrite-then-review:** the review gate must sit *before* any mutation of the original. The enhanced bytes live at a dedicated staging key until the user decides. Unreviewed/discarded stagings are swept by a retention cron (§7) so they don't accumulate.

**contentHash handling (the gotcha from the orientation precedent):** `MediaMetadataSyncService` refuses to overwrite a non-null `contentHash`. Orientation edit sidesteps this by never touching the hash (stale hash persists). For enhancement the bytes genuinely change, so:
- **keep_both:** the new item starts with `contentHash = null` and the reprocess pipeline computes it fresh — normal new-upload path.
- **replace:** explicitly set `MediaItem.contentHash = null` before `reprocessObjectNow` so the sync recomputes it. Handle the `(circle_id, content_hash)` partial-unique `P2002` path already caught in `media-metadata-sync.service.ts:293` (retry update without hash + log). **⟐ Decision for review:** confirm we want replace to rotate the hash (recommended — otherwise dedup/restore logic sees stale identity).

---

## 4. Enhancement Parameters

These are the knobs the user asked for help defining. They serve two purposes: (1) the request body of `POST …/enhance`, and (2) they compile into the prompt sent to `gpt-image-1`. Sensible defaults mean the common case is a single click with no configuration.

### 4.1 Request parameters

| Param | Type | Default | Effect |
|-------|------|---------|--------|
| `intent` | enum `auto` \| `custom` | `auto` | `auto` = "use good photographic judgement to improve this photo." `custom` = drive the prompt from the toggles + `instructions` below. |
| `preset` | enum `restore_old_photo` \| `low_light` \| `colorize_bw` \| `portrait_polish` | — (none) | Optional task-specific clause inserted between the opening sentence and the adjustment sentence. **Orthogonal to `intent`** — a preset steers *what kind* of photo problem is being solved, while `intent`/`adjustments`/`instructions` still steer the individual corrections; a preset stays fully tweakable. See the clause text and the `colorize_bw` relaxations below. |
| `adjustments.color` | boolean | `true` | Correct white balance and color cast; natural, non-oversaturated color. **Forced off when `preset=colorize_bw`** — colorizing a black-and-white photo *is* a color change, so the generic white-balance clause would fight the preset. |
| `adjustments.tone` | boolean | `true` | Balance exposure, recover shadows/highlights, improve contrast. |
| `adjustments.sharpness` | boolean | `true` | Increase clarity/acuity without haloing. |
| `adjustments.denoise` | boolean | `true` | Reduce luminance/color noise (esp. low-light). |
| `adjustments.dehaze` | boolean | `false` | Cut atmospheric haze / lift flat contrast. |
| `adjustments.straighten` | boolean | `false` | Correct a slightly crooked horizon (AI-driven; see §2 note 3). |
| `strength` | enum `subtle` \| `balanced` \| `strong` | `balanced` | How aggressive the corrections are; maps to prompt wording **and** to `input_fidelity` (subtle → highest fidelity, strong → more latitude). |
| `quality` | enum `low` \| `medium` \| `high` | server config | Optional per-run override of `pictureEnhancement.defaultQuality`. Passed straight through to the `images.edit` `quality` param (§4.2). |
| `preserveFaces` | boolean | `true` | Hard prompt constraint: do not alter facial features, identities, skin tone, or count of people. Also raises effective fidelity. |
| `instructions` | string (≤ 500 chars) | — | Advanced free-text appended to the prompt (`intent=custom`). |
| `model` | string | server config | Optional per-call override of `ai.features.enhance.model`. Defaults to the admin-configured model. |

**Preset clauses** (`apps/api/src/enhancement/enhance-prompt.builder.ts`, `PRESET_CLAUSE`), inserted verbatim:

| Preset | Clause |
|--------|--------|
| `restore_old_photo` | "This is an old or damaged photograph. Repair scratches, dust, creases, tears, stains, and faded areas, and recover lost contrast and detail. Keep the photo's period character — do not modernize it or colorize it unless asked." |
| `low_light` | "This photo was taken in low light. Brighten the exposure naturally, recover shadow detail, reduce heavy noise, and correct color casts from artificial lighting, while keeping the night-time or indoor atmosphere believable — do not make it look like daytime." |
| `colorize_bw` | "Colorize this black-and-white photograph with realistic, historically plausible colors: natural skin tones and a restrained, period-appropriate palette. Preserve the original luminance, contrast, and grain character." |
| `portrait_polish` | "This is a portrait. Gently even out skin tone and reduce temporary blemishes while keeping natural skin texture (no plastic smoothing), subtly brighten the eyes, and balance the lighting on the face. Do not reshape facial features, slim the body, or change apparent age." |

**`colorize_bw`'s two relaxations** (everything else — composition, identity, no added text — is unchanged for every preset, including this one): the `adjustments.color` toggle is forced off (see table above), and the final hard-constraint sentence swaps from "The output must look like a cleaned-up version of the same photo, not a new image." to "The output must look like a faithfully colorized version of the same photo, not a new image." — the generic "cleaned-up version" framing reads as a self-contradiction when the whole point of the preset is to change color. The preset-less prompt (no `preset` param) is byte-identical to the pre-preset template.

### 4.2 OpenAI call parameters (server-derived, not user-facing)

| `images.edit` param | Value |
|---------------------|-------|
| `model` | `ai.features.enhance.model` (e.g. `gpt-image-1`) |
| `image` | the auto-oriented original bytes |
| `prompt` | compiled from §4.1 (see template below) |
| `size` | closest supported aspect ratio to the original (`1024×1024` / `1024×1536` / `1536×1024`), chosen from original W:H |
| `quality` | request `quality` param if present, else `pictureEnhancement.defaultQuality` (default `high`) |
| `input_fidelity` | `high` when `preserveFaces` or `strength≠strong`; else `low` |
| `n` | `1` |
| `output_format` | `jpeg` (photographic; smaller than PNG) |
| `output_compression` | `90` |

### 4.3 Default prompt template (`intent=auto`)

> "Enhance this photograph to make it look its best while remaining true to the original scene. Improve exposure and tonal balance, correct white balance and color, increase clarity and sharpness, and reduce noise. Keep the result natural and photorealistic — **do not** change the composition or crop, **do not** add, remove, or move any people or objects, **do not** alter anyone's face, identity, or expression, and **do not** add any text, watermark, borders, or artistic filters. The output must look like a cleaned-up version of the same photo, not a new image."

The toggles in §4.1 add/remove clauses (e.g. `dehaze` adds "reduce atmospheric haze"; `straighten` adds "level a slightly crooked horizon"); `strength` swaps "subtly / noticeably / strongly"; `instructions` is appended verbatim under a "Additional guidance:" line.

**⟐ Decision for review:** two-tier "analysis-then-edit" option. We *could* first call the vision model (`analyzeImage`) to diagnose the photo's specific problems ("underexposed, cool white balance, slight motion blur") and feed that diagnosis into the edit prompt — better targeting at the cost of a second call and higher latency/cost. *Recommended: ship v1 single-call; add two-tier behind a `pictureEnhancement.analyzeFirst` flag as a fast follow.*

---

## 5. Metadata Copy & "AI Improved" Marking

The AI output comes back with **no EXIF** (OpenAI strips it). The requirement is: carry over the original's metadata and mark the result as AI-improved. There are two marking surfaces — **in-app (queryable)** and **in-file (portable)**.

### 5.1 File-level EXIF carryover (shipped — option A)

Neither `sharp` (as used elsewhere in the pipeline) nor any other `apps/api` dependency can **write** EXIF into a buffer — `sharp` strips all EXIF on re-encode and its `withMetadata()` cannot add arbitrary/custom tags. The gap is closed the same way `apps/cli/src/date-inference/exif-writer.ts` already closes it for the CLI: **`exiftool-vendored`**, now added to `apps/api` as well (pinned to the exact version `apps/cli` uses, so both executors stamp with the identical ExifTool build), with `perl` added to the API Dockerfile base stage (POSIX ships the ExifTool perl script, not a compiled binary — mirroring the existing `apps/cli/Dockerfile` addition).

`ExifCarryoverService` (`apps/api/src/enhancement/exif-carryover.service.ts`) is invoked once, from `PictureEnhancementHandler`, on the staged bytes before the staging upload (§3 step 6.5) — so both the `keep_both` and `replace` apply paths inherit an already-stamped file instead of each stamping separately. It writes the original and enhanced bytes to `memoriaHub-enhance-{src,out}-<uuid>` temp files (the `memoriaHub-` prefix is required so `TempFileJanitorTask` sweeps orphans left behind by a SIGKILLed job) and shells out to ExifTool with a single write call:

- **Copied wholesale from the original** (`-TagsFromFile ORIGINAL <groups>`): `-EXIF:all`, `-GPS:all`, `-IPTC:all`, `-XMP:all`, `-ICC_Profile`.
- **Overrides applied AFTER the copy** (ExifTool applies arguments left-to-right; an assignment after `-TagsFromFile` wins over the copied value):
  - `-EXIF:Orientation#=1` — the pipeline hands OpenAI an already-upright image (sharp auto-orient pre-pass, §2 note 3), so the enhanced pixels are upright too; carrying the original's orientation flag would make viewers rotate an already-rotated image. **The `#` suffix is load-bearing, not stylistic**: it disables ExifTool's `PrintConv`, so the raw value `1` is stored. Written as plain `-EXIF:Orientation=1`, ExifTool instead matches `"1"` against the PrintConv *labels* and lands on `3` ("Rotate 180") — silently upside-downing every enhanced photo. Verified against ExifTool 13.59; do not "clean up" the `#`.
  - `-EXIF:ExifImageWidth#=<w>` / `-EXIF:ExifImageHeight#=<h>` / `-XMP-exif:ExifImageWidth#=<w>` / `-XMP-exif:ExifImageHeight#=<h>` — stamped with the **actual** output pixel dimensions (read via `sharp(...).metadata()`, §4.2's revised dims handling), so the dimensions copied off the original don't lie about the new file. `EXIF:ExifImageWidth/Height` are the ExifIFD `PixelXDimension`/`PixelYDimension` tags; ExifTool exposes both the EXIF and XMP copies under the same names.
  - `-ThumbnailImage=` / `-PreviewImage=` — embedded previews/thumbnails copied wholesale from the original would still show the **pre-enhancement** image in any thumbnail-reading viewer, so they're explicitly dropped.
  - **AI marker**: `-EXIF:Software=<software>`, `-XMP-xmp:CreatorTool=<software>` (both `"MemoriaHub AI Enhance (<model>)"`), and `-XMP-iptcExt:DigitalSourceType=<AI_DIGITAL_SOURCE_TYPE>` where `AI_DIGITAL_SOURCE_TYPE` is the IPTC "digital source type" NewsCode for compositing real content with trained-algorithmic output: `http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia` — the standard, machine-readable marker for AI-modified media, honest to any conformant viewer.

**Strictly best-effort.** Every failure path — the package or `perl` missing, an unwritable tmpdir, a corrupt input, an empty output file — logs a warning and returns the **enhanced buffer unchanged**; nothing in the service may throw. A metadata stamp must never fail an enhancement job that otherwise produced good pixels. `ExifCarryoverService` keeps one long-lived ExifTool child process alive across calls (the `exiftool-vendored` model) and shuts it down via `onModuleDestroy` so the API exits cleanly.

Gated on `pictureEnhancement.stampExif`, which now **defaults to `true`** (§7.1) since there is finally a writer behind it.

### 5.2 What "copy all metadata from the original" means

The **DB columns** are always preserved/copied so the app behaves correctly, in addition to the file-level carryover above:
- **keep_both** (new MediaItem): copy `capturedAt`, `capturedAtOffset`, `cameraMake`, `cameraModel`, `orientation` (→ 1, bytes are upright), geo columns (`takenLat/Lng/Altitude`, `geoCountry…geocodedAt`, `coordSource`), `originalFilename` (suffixed, e.g. `IMG_1234 (enhanced).jpg`), and the source item's own `metadata` JSON, merged **underneath** the breadcrumb (existing keys first, breadcrumb last, so the breadcrumb always wins) — same merge order `replace` already used. The merge is filtered by `inheritableMetadata()`, which drops two families rather than inheriting the source's `metadata` verbatim:
  1. Any key beginning with `_` — the repo-wide marker for internal processing state (`_processing`, `_processingRetryCount`, `_thumbnailRepairAttempts`, `_thumbnailRepairExhausted`, `_processedAt`, and any prior `_aiEnhanced` breadcrumb). The new item runs its own processing pipeline, so inheriting the source's retry counters or exhaustion flags would mis-report or suppress its recovery; dropping a *prior* `_aiEnhanced` breadcrumb is intentional too — the fresh one layered on top records this item's immediate ancestor, which is the accurate provenance.
  2. `thumbnailObjectId` / `thumbnailStorageKey` — not underscore-prefixed, but equally derived. Inherited, the enhanced copy would render the *original's* thumbnail, and because `ThumbnailRepairTask` selects on `metadata->>'thumbnailStorageKey' IS NULL`, a copied pointer would also hide the new item from repair if its own metadata sync ever failed (a reachable path, since that sync is deliberately non-fatal). The reprocess + `syncFromStorageObject` that runs right after creation repopulates both from the new item's own bytes.

  `width/height/size/contentHash` come from the enhanced bytes via reprocess. Album membership/tags are **not** copied (it's a distinct item); a breadcrumb `metadata._enhancedFrom = <originalId>` links them.
- **replace** (same MediaItem): columns already hold the original's metadata; only `width/height`, `StorageObject.size/mimeType`, and `contentHash` change. The staged bytes are already EXIF-stamped (§5.1, applied once before staging) — `replace` overwrites the storage key with them directly, it does not re-run the carryover.

### 5.3 In-app "AI improved" marker (always applied)

Because file EXIF isn't guaranteed portable across our own thumbnail re-encodes, the authoritative in-app marker is:
- **`MediaItem.metadata._aiEnhanced`** = `{ model, at, enhancementId, fromId? }` (JSON breadcrumb). *(No new column needed; reuses the existing `metadata Json?`.)* **⟐ Decision for review:** promote to a first-class boolean column `aiEnhancedAt DateTime?` if we want an index/filter — recommended if we add an "AI Enhanced" search facet.
- **A system tag "AI Enhanced"** applied via `MediaTagSource.system` (same mechanism social-media detection uses), so users can find enhanced photos via `?tag=AI+Enhanced` and it survives AI-tag reruns (system tags are protected).
- Surfaced as a small badge/chip in `MediaDetailDrawer` and on the gallery tile.

### 5.4 File-level EXIF marker (best-effort, shipped)

As implemented (§5.1), the file-level marker is `EXIF:Software` + `XMP-xmp:CreatorTool` (both `"MemoriaHub AI Enhance (<model>)"`) plus `XMP-iptcExt:DigitalSourceType` set to the IPTC `compositeWithTrainedAlgorithmicMedia` NewsCode — a standard, machine-readable "AI-composited" marker rather than a custom `XMP-MemoriaHub:*` namespace (the original draft's proposal). All original EXIF/GPS/IPTC/XMP/ICC tags are copied via `-TagsFromFile`, embedded thumbnails/previews are dropped, `Orientation` is normalized to `1` (written with the `#` PrintConv-bypass suffix — see §5.1 for why this is load-bearing), and `ExifImageWidth`/`ExifImageHeight` are stamped with the actual output dimensions. Applied once to the staged bytes before upload (§3 step 6.5); both `keep_both` and `replace` inherit the same stamped file. Strictly best-effort — see §5.1 for the failure contract.

---

## 6. Data Model

### 6.1 New table: `media_enhancements`

One row per enhancement attempt on a media item. Mirrors the shape of status tables like `media_metadata_status`, but carries the staging pointer and decision.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `media_item_id` | uuid FK → `media_items` | the original; cascade delete |
| `circle_id` | uuid FK → `circles` | cascade delete |
| `status` | enum `pending` \| `processing` \| `ready` \| `failed` \| `applied` \| `discarded` \| `expired` | lifecycle |
| `decision` | enum `keep_both` \| `replace` \| null | set on apply |
| `params` | jsonb | the §4.1 request params (audit of what was asked) |
| `provider` | text | `openai` |
| `model` | text | resolved model id |
| `prompt` | text | the compiled prompt actually sent (audit/repro) |
| `staging_storage_key` | text? | key of the enhanced preview bytes (null after apply/discard) |
| `staging_thumbnail_key` | text? | key of the preview's thumbnail derivative (issue #203; same provider/bucket; null when never generated or after apply/discard) |
| `staging_provider` / `staging_bucket` | text? | where the preview lives |
| `original_width` / `original_height` | int? | snapshot for the compare UI |
| `enhanced_width` / `enhanced_height` | int? | Actual pixel dims of the final (possibly EXIF-stamped) staged bytes, read via `sharp(...).metadata()` — not the requested canvas, since `gpt-image-1` does not always honor it (falls back to the requested size only if dims can't be read); drives the downscale warning |
| `enhanced_size` | bigint? | bytes |
| `result_media_item_id` | uuid? FK → `media_items` (SetNull) | the new item created on `keep_both` |
| `last_error` | text? | failure detail |
| `created_by_id` | uuid FK → `users` (SetNull) | |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `@@index([mediaItemId, status])`, `@@index([circleId, status])`, `@@index([status, updatedAt])` (for the retention sweep).

> **⟐ Decision for review:** allow only one live (`pending`/`processing`/`ready`) enhancement per media item (upsert/replace semantics), or allow several? *Recommended: one live at a time — a new request supersedes/replaces an unapplied one and discards its staging bytes.*

### 6.2 New enum value on `enrichment_jobs` job type

`picture_enhancement` — a per-item async job (`media_item_id` set), priority 0, reason `rerun`. Handler `PictureEnhancementHandler` (`apps/api/src/enhancement/picture-enhancement.handler.ts`). Server-only in v1 (no `nodeResultSchema` / `persistNodeResult`, and absent from the CLI `NODE_JOB_TYPES`) — it needs the OpenAI key and writes to a staging object, mirroring the `location_inference`/`face_auto_archive_sweep` server-only precedent. The distinct execution-timeout budget may need raising via `ENRICHMENT_JOB_TIMEOUT_MS` awareness since image gen is slow (default 10 min is comfortably enough for one image).

### 6.3 `MediaItem` marking

No new column required in v1 (uses `metadata._aiEnhanced` + system tag, §5.3). Optional first-class `aiEnhancedAt DateTime?` column is the §5.3 decision.

### 6.4 Retention cron

`PictureEnhancementPurgeTask` (hourly `@Cron`) enqueues a global `picture_enhancement_purge` job (`mediaItemId: null`) that deletes staging objects + marks rows `expired` for `ready`/`failed` enhancements older than `pictureEnhancement.retentionHours`, mirroring `TrashPurgeTask`. Keeps orphaned previews from accumulating in storage.

### 6.5 Staging thumbnail derivative *(issue #203)*

Right after staging the enhanced bytes, `PictureEnhancementHandler` renders a thumbnail of them and uploads it to `enhancements/<enhancementId>/thumb.jpg`, recording the key in `staging_thumbnail_key`. Four properties are deliberate:

- **Same renderer as every other thumbnail.** `renderThumbnailBuffer` (`apps/api/src/storage/processing/thumbnail-render.util.ts`) was extracted from `ThumbnailProcessor` for this, so sizing (`THUMBNAIL_MAX_DIM`, default 800px, fit-inside, no enlargement), format (JPEG at `THUMBNAIL_QUALITY`), the HEIC transcode fallback, and `Cache-Control: public, max-age=31536000, immutable` are shared rather than forked. `ThumbnailProcessor` now calls the same function, so the two cannot drift.
- **No `StorageObject` row.** Unlike a normal thumbnail, the staged derivative gets no row: it is neither an upload nor a `thumbnails/`-prefixed derivative of one, and a row would show up in storage insights and the reprocess/repair sweeps as a phantom object. The consequence is that it cannot be signed via `signThumbsBatched` (which resolves providers *from* those rows) — it is signed through the list endpoint's existing per-`provider|bucket` cache instead (§8.9 point 5), which needs no query at all.
- **No new provider columns.** It is uploaded to the same active provider, in the same handler run, as `staging_storage_key`, so the existing `staging_provider` / `staging_bucket` describe both objects.
- **Best-effort.** A render or upload failure logs a warning and leaves `staging_thumbnail_key` null; the enhancement still reaches `ready`. A thumbnail is a display optimization and must never discard an expensive `gpt-image-1` result that already succeeded.

Cleanup follows the full-resolution object exactly: `MediaEnhancementService.deleteStaging` (apply / discard / supersede) and `PictureEnhancementPurgeHandler` (§6.4) delete both keys and null both columns, so retention never leaks an orphaned thumbnail. Each delete is independent, so a failure on one still attempts the other.

---

## 7. Configuration

### 7.1 System Settings (Admin-editable)

Validated via the shared Zod schema (`apps/api/src/settings/dto/update-system-settings.dto.ts`), round-tripping through `PATCH`/`PUT /api/system-settings`.

| Setting key | Type | Range | Default | Description |
|-------------|------|-------|---------|-------------|
| `features.pictureEnhancement` | boolean | — | `false` | Global on/off. Gates the trigger, endpoints, and enqueue. |
| `ai.features.enhance` | object | — | `null` | Active `{ provider, model }` for enhancement (set via `PUT /api/ai/features/enhance`). |
| `pictureEnhancement.defaultQuality` | enum | low\|medium\|high | `high` | `gpt-image-1` quality. |
| `pictureEnhancement.defaultStrength` | enum | subtle\|balanced\|strong | `balanced` | Default correction aggressiveness. |
| `pictureEnhancement.stampExif` | boolean | — | `true` | Whether `ExifCarryoverService` copies the original's EXIF/GPS/IPTC/XMP/ICC onto the enhanced file and stamps the AI marker (§5.1/§5.4). Shipped and honored — previously a dead setting with no writer behind it; see [Implementation status (v1)](#implementation-status-v1). |
| `pictureEnhancement.allowReplace` | boolean | — | `true` | If `false`, only "keep both" is offered (never overwrite originals). |
| `pictureEnhancement.blockReplaceOnDownscale` | boolean | — | `false` | If `true`, disable "replace" when enhanced dims < original (§2 note 2, decision c/b). |
| `pictureEnhancement.maxInputMegapixels` | number | 1–100 | `50` | Skip/guard absurdly large inputs. |
| `pictureEnhancement.retentionHours` | int | 1–720 | `168` | How long unapplied staging previews live before the purge cron reaps them. Raised from `72` in issue #201: the Enhancements hub (§9.7) is an inbox users work through over time, not a use-immediately dialog, and the shorter window was reaping unreviewed staged enhancements — each one a spent, paid `gpt-image-1` call — before a user got around to them. |
| `pictureEnhancement.maxBatchSize` | int | 1–200 | `25` | Epic #420. The AUTHORITATIVE cap on how many items one `POST /api/media/bulk/enhance[/by-filter]` request may queue (§16.2). Each queued item is a separately-billed `gpt-image-1` call, so this is the admin's spend guardrail against a fat-fingered or oversized selection/filter. The DTOs' own `.max(200)` array bound is only a schema backstop — an admin lowering this setting to `10` must actually cap batches at `10`, which a static schema max cannot express. Surfaced on `GET /api/features` (§8.8) so a non-admin collaborator's client can cap/label a selection client-side before submitting instead of discovering the limit as a `400`. |

### 7.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PICTURE_ENHANCEMENT_ENABLED` | `true` | Env kill-switch (hard override for CI/test), same pattern as `DUPLICATE_DETECTION_ENABLED`, `SOCIAL_MEDIA_DETECTION_ENABLED`, `AUTO_TAG_ENABLED`. |

The queue is governed by the shared enrichment-worker vars (`ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_JOB_POLL_MS`, `ENRICHMENT_WORKER_CONCURRENCY`, `ENRICHMENT_JOB_TIMEOUT_MS`, and the rate-limit/backoff vars) — see [enrichment-queue.md](enrichment-queue.md). No new worker knobs.

---

## 8. API Endpoints

All endpoints require JWT Bearer authentication. No new system-level RBAC permission scopes are introduced — media endpoints reuse `media:read`/`media:write` + per-circle roles; model selection reuses `ai_settings:*`, consistent with sibling features.

### 8.1 `POST /api/media/:id/enhance`
Start an enhancement. Gated on `features.pictureEnhancement`.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Request body:** the §4.1 params, including `preset` and `quality` (all optional; empty body = full `auto` defaults).
- **Behavior:** photo-only guard (400 for video/non-image); supersedes any existing live enhancement for the item (discards its staging bytes); creates a `media_enhancements` row (`pending`); enqueues `picture_enhancement` at priority 0.
- **Response `202`:** `{ data: { enhancementId, jobId, status: 'pending' } }`
- **Response `400`:** feature disabled / not a photo / input over `maxInputMegapixels` / no `ai.features.enhance` configured.
- **Response `404`:** item missing/soft-deleted/no storage object.

### 8.2 `GET /api/media/:id/enhance/:enhancementId`
Poll status + fetch compare payload.
- **Auth:** `media:read` + per-circle `viewer`.
- **Response `200` (ready):**
  ```json
  {
    "data": {
      "id": "…", "status": "ready", "model": "gpt-image-1",
      "original": { "url": "<signed>", "width": 4032, "height": 3024, "size": "3145728" },
      "enhanced": { "url": "<signed>", "width": 1536, "height": 1152, "size": "812345" },
      "downscaled": true,
      "params": { … }
    }
  }
  ```
- **Response `200` (pending/processing/failed):** same envelope with `status` and, on failure, `lastError`.

### 8.3 `GET /api/media/:id/enhance` *(optional convenience)*
Return the latest enhancement for the item (so the UI can resume a review after a reload). Same payload as 8.2.

### 8.4 `POST /api/media/:id/enhance/:enhancementId/apply`
Commit the result.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Request body:** `{ decision: 'keep_both' | 'replace' }`.
- **`keep_both`:** promotes staging bytes into a new `MediaItem` (metadata copy §5.2 + marker §5.3/§5.4), enqueues upload enrichment, sets `result_media_item_id`, row → `applied`. Response `201` with the new item id.
- **`replace`:** overwrites the original storage key, nulls `contentHash`, updates dims/size, `reprocessObjectNow`, re-enqueues face detection (best-effort), marks AI-enhanced, deletes staging, row → `applied`. Response `200` `{ data: { status: 'ready'|'failed', width, height } }` (mirrors orientation edit's return). `400` if `allowReplace=false` or blocked by downscale policy.
- Writes an `audit_events` row (`media_enhancement:applied`).

### 8.5 `POST /api/media/:id/enhance/:enhancementId/discard`
Delete staging bytes, row → `discarded`. Response `204`. (`media:write` + `collaborator`.)

### 8.6 AI model selection (Admin)
- `PUT /api/ai/features/enhance` body `{ provider, model }` — set active enhancement provider+model (`ai_settings:write`, Admin). New `SetEnhanceFeatureDto`; extends the `ai.features` Zod schema; updates the `getSettings` default.
- `GET /api/ai/models?provider=openai&capability=image` — list image-capable models. New `capability=image` branch → curated list (`['gpt-image-1']`) since `client.models.list()` output is filtered *out* by the chat-model `isEligibleOpenAiModel` regex; image models need their own curated source.

### 8.7 Admin status *(for Doctor + settings UI)*
- `GET /api/admin/ai/enhance/status` — `{ featureEnabled, provider, model, credentialConfigured, ready }` (`system_settings:read` or `ai_settings:read`, Admin). Backs the Doctor check (§11) and the `/admin/settings/enhancer` readiness panel (§9.6).

### 8.8 `GET /api/features` *(any authenticated user)*
Least-privilege carrier added in the follow-up pass to fix the button-never-renders-for-non-admins gap (see [Implementation status (v1)](#implementation-status-v1)). Unlike every other endpoint in this section, it is **not** gated by `media:*`/`ai_settings:*` — it requires authentication only (`@Auth()` with no roles/permissions), so any logged-in user, regardless of role or circle membership, can call it.
- **Auth:** authenticated (any role, no permission).
- **Response `200`:**
  ```json
  {
    "features": { "pictureEnhancement": true, "faceRecognition": false, "...": "..." },
    "pictureEnhancement": {
      "enabled": true,
      "allowReplace": true,
      "blockReplaceOnDownscale": false,
      "model": "gpt-image-1"
    }
  }
  ```
- `features` is the raw global feature-flag record (all boolean `features.*` settings) — no other settings namespace is exposed. `pictureEnhancement.enabled` folds in the `PICTURE_ENHANCEMENT_ENABLED` env kill-switch server-side via the shared `isPictureEnhancementEnabled()` helper, the same one `MediaEnhancementService`'s server-side gates use — so the client gate and the API gate cannot drift. `pictureEnhancement.model` surfaces only the configured model **name**, never a credential.
- Backed by `SystemSettingsService.getPublicFeatures()`, which reads through the same cached `getSettings()` (5 s TTL) as every other settings caller — no extra DB read path.
- **Web usage:** `useFeatureFlags()` (`apps/web/src/hooks/useFeatureFlags.ts`) wraps this with a module-level, 60 s-TTL in-flight-promise cache, so concurrent `MediaGallery` + `MediaLightbox` mounts share one request instead of each firing their own; failures are never cached (a fetch outage can only hide a gated affordance, never break the surface hosting it).

### 8.9 `GET /api/media/enhancements` *(the Enhancements hub, issue #201)*
Cross-item, paginated listing of every AI picture enhancement in a circle — the first cross-item enhancement listing in the codebase (every endpoint above is scoped to one `:id`). Backs the `/enhancements` hub's Pending review tab (§9.7).
- **Auth:** `media:read` + per-circle `viewer`. Declared in `MediaEnhancementController`'s static-routes block, ahead of any `:id` route, so the literal `enhancements` path segment is never captured as an `:id` param (same convention as `media.controller.ts`).
- **Query params:** `circleId` (required, uuid). `status` (optional) — a concrete `MediaEnhancementStatus` (`pending`\|`processing`\|`ready`\|`failed`\|`applied`\|`discarded`\|`expired`\|`cancelled`, the last added by §16's batching) **or** one of three convenience aliases (`ENHANCEMENT_STATUS_ALIASES`) the hub UI actually thinks in: `in_progress` → [`pending`, `processing`], `awaiting_decision` → [`ready`], `terminal` → [`applied`, `discarded`, `expired`]. `batchId` (optional, uuid; epic #420, §16.2) — narrows to one bulk-enhance batch's enhancements, composing with `status`; served by the `(batchId)` index added alongside `media_enhancements.batch_id`; used by the batch progress page's failed-items table (§16.4). `page` (default `1`), `pageSize` (default `24`, max `50`), `sortBy` (`createdAt`\|`updatedAt`, default `createdAt`), `sortOrder` (`asc`\|`desc`, default `desc`).
- **Response `200`:** `{ items: [...], meta: { page, pageSize, totalItems, totalPages } }`. Each item:
  ```json
  {
    "id": "…", "mediaItemId": "…", "status": "ready", "decision": null,
    "model": "gpt-image-1", "params": { "preset": "low_light" },
    "original": { "thumbnailUrl": "<signed>", "width": 4032, "height": 3024, "size": "3145728" },
    "enhanced": { "thumbnailUrl": "<signed>", "previewUrl": "<signed>", "width": 1536, "height": 1152, "size": "812345" },
    "downscaled": true,
    "expiresAt": "2026-08-03T12:00:00.000Z",
    "lastError": null,
    "resultMediaItemId": null,
    "sourceFilename": "IMG_1234.jpg",
    "capturedAt": "2024-12-25T09:00:00.000Z",
    "createdBy": { "id": "…", "name": "…" },
    "createdAt": "2026-07-27T12:00:00.000Z",
    "updatedAt": "2026-07-27T12:00:00.000Z"
  }
  ```
- **Contract points worth calling out explicitly:**
  1. **Byte-size fields are STRINGS.** `original.size` and `enhanced.size` are decimal strings, not numbers — the same BigInt-JSON-safety pattern used everywhere else in the codebase (the underlying `enhancedSize`/storage-object `size` columns are Prisma `BigInt`).
  2. **`expiresAt` is computed server-side**, once per request (not per row), as `updatedAt + pictureEnhancement.retentionHours` — and is **non-null only for the `ready` and `failed` statuses**, the two the `picture_enhancement_purge` retention job (§6.4) actually reaps. The client never has to know the retention setting to render a countdown; it just watches the deadline the server already resolved.
  3. **`enhanced.*` is populated only while the row is `ready`.** A row that is `applied`/`discarded`/`expired`/`pending`/`processing`/`failed` gets `enhanced: { thumbnailUrl: null, previewUrl: null, width: null, height: null, size: null }`, because staged bytes exist only for a `ready` row (every other status has had them promoted, discarded, or reaped).
  4. **`enhanced.thumbnailUrl` is a real thumbnail; `enhanced.previewUrl` is the full-resolution staged object** (issue #203). Originally the field named `thumbnailUrl` served the full-res staged bytes, because staged objects had no thumbnail derivative — so a page of `ready` rows downloaded N full `gpt-image-1` outputs (up to 1536×1024) to paint 148px cards, and the `pageSize` cap existed partly to bound that. `PictureEnhancementHandler` now writes a derivative alongside the result (§6.5), so the two use cases have two honestly-named fields. `thumbnailUrl` is `null` — with `previewUrl` still populated — for rows staged before #203 and for rows whose best-effort thumbnail render failed; clients render `thumbnailUrl ?? previewUrl`.
  5. **Batched signing, no N+1.** One `mediaItem.findMany` loads every source item on the page; one `signThumbsBatched` call signs every source thumbnail key; a per-`provider|bucket` cache resolves *both* staged keys so a page of N rows touches at most one provider client per distinct destination, not N. Staged objects deliberately have no `StorageObject` row (see §6.5), which is what `signThumbsBatched` resolves providers from — so they are signed through that cache instead, which also costs no extra query. A single unsignable staged object logs a warning and degrades that field to `null` rather than failing the whole page.
- **Response `400`:** invalid query params. **Response `403`:** caller is not a viewer of the circle.

### 8.10 `POST /api/media/bulk/enhance` *(epic #420, issue #421)*
Queue an AI enhancement for every eligible item in an explicit selection. See §16.2 for the full behavior and the five deliberate divergences from §8.1.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Request body:** `{ circleId, ids: uuid[] (1–200), params? }`. `ids` are deduplicated before counting; `params` is the same §4.1 shape as the single-item endpoint, applied to every eligible item.
- **Behavior:** feature-gate and model-configured checks identical to §8.1; distinct ids are checked against `pictureEnhancement.maxBatchSize` (the DTO's `.max(200)` is a schema backstop only); one authorization pass for the whole batch; creates a `media_enhancement_batches` row (even when nothing is eligible) and, per eligible item, a `media_enhancements` row + a `picture_enhancement` job at **priority 50** with **`skipDedup: true`** (§16.2). An item already carrying a live enhancement, a non-photo, or an oversized image is skipped and counted rather than superseded or failing the request.
- **Response `202`:** `{ data: { batchId, requested, queued, skipped: { notPhoto, tooLarge, alreadyLive } } }` — `requested` is the deduplicated id count; `queued + notPhoto + tooLarge + alreadyLive === requested` always.
- **Response `400`:** feature disabled / no `ai.features.enhance` configured / selection exceeds `maxBatchSize`.
- **Response `404`:** one or more ids are not live items of the circle.

### 8.11 `POST /api/media/bulk/enhance/by-filter` *(epic #420, issue #424)*
Queue an AI enhancement for every photo matching a gallery filter, resolved server-side. See §16.6 for the full behavior, the never-truncate rule, and the three pinned predicates.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Request body:** `{ circleId, ...mediaFilterFields, params? }` — the same filter shape `GET /api/media` and `POST /api/media/albums/:id/items/by-filter` take (so one filter object works against any of the three), plus the optional §4.1 `params`. No id array and no client-supplied cap; the server resolves the match set.
- **Behavior:** feature-gate and model-configured checks in the same order as §8.10 (byte-identical disabled/unconfigured responses between the two bulk endpoints); authorization runs **before** the match count (the reverse of §8.10's order — see §16.6 for why); `deletedAt`, `archivedAt`, and `type: photo` are pinned in the resolved `where` regardless of what the filter asked for; a zero match is a `400`; a match over `maxBatchSize` is refused, never truncated. On success, delegates to the same batch-creation path as §8.10 (§16.3), so eligibility skipping and job priority/dedup are identical.
- **Response `202`:** `{ data: { batchId, requested, queued, skipped: { notPhoto, tooLarge, alreadyLive } } }` (same shape as §8.10).
- **Response `400`:** feature disabled / no model configured / no photos match the filter / match exceeds `maxBatchSize` — the last carries `{ message, details: { matchedCount, maxBatchSize } }` (§16.6; must live under `details`, per the repo-wide `HttpExceptionFilter` allowlist gotcha).

### 8.12 `GET /api/enhancement-batches` *(epic #420, issue #421)*
Paginated list of a circle's bulk-enhance batches, newest first.
- **Auth:** `media:read` + per-circle `viewer`.
- **Query params:** `circleId` (required, uuid), `page` (default `1`), `pageSize` (default `20`, max `50`).
- **Response `200`:** `{ items: EnhancementBatch[], meta: { page, pageSize, totalItems, totalPages } }` — each item is the same derived shape as §8.13's detail response.

### 8.13 `GET /api/enhancement-batches/:id` *(epic #420, issue #421/#423)*
Single batch detail — the derived, `BaseRun`-shaped progress payload described in §16.4.
- **Auth:** `media:read` + per-circle `viewer`.
- **Response `200`:**
  ```json
  {
    "id": "…", "circleId": "…", "status": "running",
    "matchedCount": 26, "processedCount": 14, "succeededCount": 12,
    "failedCount": 2, "skippedCount": 0,
    "startedById": "…", "createdAt": "…", "updatedAt": "…",
    "startedAt": "…", "finishedAt": null, "lastError": null,
    "requestedCount": 30, "queuedCount": 26,
    "skipped": { "notPhoto": 3, "tooLarge": 0, "alreadyLive": 1 },
    "params": { "preset": "low_light" }, "source": "selection",
    "cancelledAt": null
  }
  ```
  The first 14 fields are the shared `BaseRun` contract (§16.4) — the same field set `workflow_runs`/`trash_empty_runs`/`review_runs` emit — so the web `RunProgressPanel`/`useRunPolling` drive this response with no new component. `succeededCount` counts every row whose render completed regardless of the human's later decision (`ready`+`applied`+`discarded`+`expired`); `skippedCount` counts rows withdrawn by a cancel before any render ran. `status` is terminal as soon as no rows remain `pending`/`processing` — a batch that queued nothing (`queuedCount: 0`) reads `completed`, never a stuck `running`.
- **Response `404`:** batch not found. **Response `403`:** caller is not a viewer of the circle.

### 8.14 `POST /api/enhancement-batches/:id/cancel` *(epic #420, issue #421/#423)*
Cooperatively cancel a non-terminal batch. See §16.5 for the full cancellation semantics.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Behavior:** deletes the still-`pending` job rows belonging to the batch (matched precisely by the enhancement id in their payload) and marks their `media_enhancements` rows `cancelled`; a row already `processing` is deliberately left to finish — its OpenAI call is already billed, so aborting would spend the money and discard the result for nothing. `PictureEnhancementHandler` re-checks the batch's `cancelledAt` at claim time as a second gate, covering a job that was already claimed by a worker when the cancel request landed.
- **Response `200`:** `{ batchId, status: 'cancelled', cancelled }` — `cancelled` is the number of pending enhancements withdrawn.
- **Response `400`:** batch already finished (terminal status, or already cancelled).
- **Response `404`:** batch not found. **Response `403`:** caller is not a collaborator of the circle.

---

## 9. Frontend / UI

Precedents identified in the codebase are reused directly.

### 9.1 Trigger — selection top bar (primary)
`components/media/BulkActionToolbar.tsx` renders the selection bar. As of issue #422 (epic #420 phase 2) it counts eligible **photos** in the selection, not the raw selection size: `enhancePhotos = selectedItems.filter(item => item.type === 'photo')` (falling back to a single `singleSelectedItem` prop for callers not yet migrated to passing full item objects). This split routes the click to one of two different UIs, not just a label change:

- **Exactly one eligible photo** (`enhancePhotoCount === 1`, regardless of how many non-photo items sit alongside it in the selection) → the single-item drawer, `onOpenEnhance` (§9.3).
- **More than one eligible photo** (`enhancePhotoCount > 1`) → the batch dialog, `onOpenBatchEnhance` (§16.7). A mixed selection of, say, 1 photo + 1 video is still a single-item enhance — the video simply never counts toward `enhancePhotoCount`.

The **"AI Enhance" `IconButton`** (`AutoFixHigh`) in the right-cluster is shown whenever `enhancePhotoCount > 0` and the feature is on, labelled with the live count (`AI Enhance N photo(s)`); its tooltip appends `(limit N per batch)` when the count exceeds `pictureEnhancement.maxBatchSize` — the button stays enabled either way (the server is the real gate), this is only the courteous warning. Mirrors the existing `onOpenLocation`/`onOpenTags` callback wiring. The feature-on check reads `useFeatureFlags().pictureEnhancement?.enabled` (§8.8/§9.5) — **not** `useSystemSettings()` — since the latter 403s for non-admin circle members and previously hid the trigger from exactly the people meant to use it. A separate, always-available **"Enhance all matching photos"** entry (`onOpenFilterEnhance`, §16.7) opens the same dialog in filter mode regardless of the current selection size — it acts on the server-resolved filter match, not on `selected`.

Both the single-item drawer (`MediaEnhancementDrawer.tsx`, §9.3) and the batch dialog (`BatchEnhanceDialog.tsx`, §16.7) share one preset/params module, `components/media/enhancePresets.tsx` (`PRESETS`, `ADJUSTMENT_FIELDS`, `DEFAULT_ADJUSTMENTS`, `buildEnhanceParams`, `resolvePreset`) — the same six presets, the same toggle vocabulary, and the same `EnhanceParams` compiler feed both surfaces, so a preset means the same thing whichever way a user reached it. Extracted from `MediaEnhancementDrawer` in issue #422 specifically so the then-upcoming `BatchEnhanceDialog` would consume the same definitions rather than a second copy — no behavior change to the drawer at extraction time.

### 9.2 Trigger — full-screen viewer (secondary, mirrors orientation edit)
`components/media/MediaLightbox.tsx` has a **photo-only** "Edit orientation" `IconButton` that opens a right `Drawer`. An adjacent "AI Enhance" button opens the enhancement drawer, gated on the same `useFeatureFlags()` source as §9.1. `refreshFullItem()` is the hook called after a "replace" outcome to bust the cache and reload the image.

### 9.3 The enhance + compare + decide drawer
`MediaEnhancementDrawer.tsx`, a right `Drawer` (`zIndex` above the lightbox) rebuilt around three upgrades to the params/progress/compare flow:

1. **Params step — presets.** Opens with a preset picker (`PRESETS` in the drawer, mirroring the API's four presets §4.1: Auto, Restore old photo, Low-light rescue, Colorize B&W, Portrait polish, Custom) that pre-fills the existing adjustment toggles/strength/instructions while leaving them fully editable — selecting a preset is not a one-way door. The Colorize B&W card is labelled **"interpretive"**, and the panel repeats the warning once selected ("Colorizing is interpretive: the colors are the AI's best guess…") — invented color must never read as recovered fact in a family-history archive. Opening the "Customize" expander only sends `intent: 'custom'` if the user actually changed a toggle (previously it sent `custom` unconditionally just from being opened, silently swapping the prompt's base sentence even when nothing was customized). Model shown from `ai.features.enhance` via the drawer's `modelLabel` prop (wired for the first time in this pass — the prop existed earlier but no render site ever passed it, so the model line never appeared in production).
2. **Progress step — queued vs. enhancing, with elapsed time.** `useMediaEnhance` (`hooks/useMediaEnhance.ts`) now tracks `startedAt` and distinguishes the queued state from the actively-enhancing state, with elapsed time and rotating status lines, plus an explicit "close this panel — you'll be notified when it's ready" affordance, since a real `images.edit` call runs 10–60 s behind the enrichment queue. Two bugs fixed in the same pass: a rejected start (e.g. a 400) used to set status back to `idle` while the error alert only rendered on `failed`, so a failed start looked like a dead button with no feedback; and a poll timeout left `status` untouched, so the spinner ran forever and its error was unreachable — both paths now resolve to a terminal `failed` status so the error renders and the spinner stops.
3. **Compare step — before/after slider.** The two static ~200px side-by-side panes are replaced by `BeforeAfterSlider.tsx`, a draggable before/after comparison with a side-by-side toggle (for judging global color shift) and full-screen zoom (for inspecting faces/detail before committing) — plus the metadata delta row (dimensions/size, downscale warning when enhanced < original) and the decision bar: **Keep both** / **Replace** / **Discard**, each behind a confirm `Dialog` describing the outcome. **Replace is now gated client-side** on the admin's replace policy (threaded through the drawer's `replacePolicy` prop, sourced from `GET /api/features`, §8.8): hidden entirely when `allowReplace: false`, and disabled with an explanatory reason when `blockReplaceOnDownscale` is on and the result is downscaled — previously the user could confirm the destructive action and only then hit a 400.

### 9.4 Properties pane (tertiary)
Optionally add an "Enhance with AI" button + "AI Enhanced" badge in `MediaDetailDrawer.tsx` alongside "Re-run metadata extraction" / "Retry thumbnail".

### 9.5 API layer
`services/enhance.ts` using the existing `fetch` wrapper (`services/api.ts`, no React Query): `startEnhance(id, params)` (now accepting `preset`/`quality`, §4.1), `getEnhancement(id, enhancementId)`, `applyEnhancement(id, enhancementId, decision)`, `discardEnhancement(id, enhancementId)`, plus `getEnhancerAdminStatus()` for §9.6. `services/features.ts` + `hooks/useFeatureFlags.ts` provide the `GET /api/features` client (§8.8) that both the trigger gates (§9.1/§9.2) and the drawer's `replacePolicy`/`modelLabel` props (§9.3) are sourced from — a single fetch shared, via a module-level cache, by every consumer that mounts concurrently. `pages/Admin/AiSettingsPage.tsx` links out to §9.6 instead of embedding its own toggle.

### 9.6 Admin settings page — `/admin/settings/enhancer`
`pages/Admin/EnhancerSettingsPage.tsx`, added because `features.pictureEnhancement` was, before this page existed, the only one of the app's eight feature flags with no UI toggle anywhere — the sole way to turn the enhancer on was a hand-crafted `PATCH /api/system-settings`. Modeled on the sibling per-feature admin pages, three sections:
1. **Global Settings** — the `features.pictureEnhancement` master toggle (`system_settings:write`, Admin).
2. **Readiness panel** — consumes `GET /api/admin/ai/enhance/status` (§8.7, previously wired but never read by any UI) so an admin who enables the feature without configuring an image model sees the gap immediately instead of finding out from a user's failed 400.
3. **Defaults & policy** — the seven `pictureEnhancement.*` settings (§7.1): `defaultQuality`, `defaultStrength`, `stampExif` (default reflected as **on**, matching the shipped server default), `allowReplace`, `blockReplaceOnDownscale`, `maxInputMegapixels`, `retentionHours`.

Reachable from `/admin/settings` (Settings hub) and linked from `pages/Admin/AiSettingsPage.tsx`, which previously pointed users at a "Picture Enhancement feature toggle in System Settings" that did not exist.

### 9.7 The Enhancements hub — `/enhancements` (issue #201)

Before this, the only way to reach an enhancement was per-item — from the gallery selection bar (§9.1) or the lightbox (§9.2) — with no cross-item place to come back to. `pages/Enhancements/EnhancementsPage.tsx` adds that landing spot: three tabs, URL-addressable via `?tab=pending|enhanced|history` (default `pending`, omitted from the URL when default — the tab keys are part of the page's URL contract, so renaming one breaks bookmarks).

1. **Pending review — live in PR1** (`PendingEnhancementsTab.tsx`). A status/sort-filterable list, backed by `GET /api/media/enhancements` (§8.9), of everything sent through the enhancer that is still queued, running, awaiting a decision, or failed. Each card shows: a queued/enhancing/ready/failed chip with elapsed time while in flight; a "Lower resolution" badge when `downscaled`; an expiry countdown driven **entirely** by the server's `expiresAt` (§8.9 point 2) — the client never derives it from its own copy of `pictureEnhancement.retentionHours`, since the setting can change after a row was created and only the server's resolved deadline is authoritative. Countdown severity: `info` normally, `warning` under 24h remaining, `error` under 6h remaining. Per-card actions on a `ready` row: **Review** (reopens `MediaEnhancementDrawer` on that specific enhancement, §9.3/below), **Keep both**, and **Discard**; **Replace** appears/disables per the same admin replace-policy gating the drawer already applies (`allowReplace`/`blockReplaceOnDownscale` from `GET /api/features`, §8.8). Multi-select and bulk **review** actions are deliberately absent — see §15. Two additions from epic #420 (§16): an optional **`?batchId=`** query param narrows the list to one bulk-enhance batch's enhancements (§8.9), reached by clicking "Review N results →" from a batch's progress page (§16.4) — when present the tab shows a chip naming the batch with a clear-filter affordance instead of the default view; and, when `batchId` is **absent**, the tab renders `RecentBatches` — a small "last 5 batches" recovery list (`GET /api/enhancement-batches`, §8.12) sitting above the pending-review list, for a user who dismissed the submit toast or reloaded the page and needs to find their way back to an in-progress batch. `RecentBatches` deliberately carries no sidebar badge or nav entry of its own: a batch lives for minutes and the hub's own pending-review badge already counts the photos it produces, so a second badge would double-count the same photos.
2. **Enhanced photos — placeholder in PR1.** Renders "Enhanced photos — a gallery of every enhancement you kept — is coming soon." The real implementation (a gallery over the "AI Enhanced" system tag, §5.3) is deferred to PR3.
3. **History — placeholder in PR1.** Renders "History — the full audit trail of past enhancements — is coming soon." Deferred to PR3.

**Gating:** the page (and its sidebar entry, below) reads `features.pictureEnhancement` via `useFeatureFlags()` → `GET /api/features` (§8.8) — the same least-privilege source §9.1/§9.2 already use, deliberately **not** the Admin-only `GET /api/system-settings` — so non-admin circle collaborators reach the hub too.

**Sidebar entry.** `components/navigation/Sidebar.tsx` adds an "AI Enhancements" item (`AutoFixHigh` icon) to the **Utilities** section (alongside Review Bursts / Review Duplicates / Review Insights / Location Suggestions / Workflows) — not a primary nav item. Rendered only when `pictureEnhancement?.enabled === true` (strict equality, not a truthy check, so the entry doesn't flash in while the flag is still loading — `pictureEnhancement` is `null` until `useFeatureFlags()` resolves). It carries a badge showing the dashboard's `pendingEnhancements` count (rendered only when > 0) — the app's **first** sidebar nav-item badge; the shared `NavItemDef` interface gained a new optional `badgeCount?: number` field to support it, so this is now a reusable pattern rather than a one-off for this feature.

**Drawer change.** `MediaEnhancementDrawer` (§9.3) can now open directly on a **named, existing** enhancement via a new `enhancementId` prop, instead of only ever starting a fresh one — this is what lets the hub's "Review" action reopen the compare/decide flow for the specific card the user clicked, rather than kicking off a new (billable) request.

---

## 10. RBAC

| Endpoint | Permission | Per-circle role | Notes |
|----------|-----------|-----------------|-------|
| `POST /api/media/:id/enhance` | `media:write` | `collaborator` | + `features.pictureEnhancement` |
| `GET /api/media/:id/enhance[/:id]` | `media:read` | `viewer` | signed compare URLs |
| `POST …/enhance/:id/apply` | `media:write` | `collaborator` | keep_both creates item; replace overwrites |
| `POST …/enhance/:id/discard` | `media:write` | `collaborator` | |
| `PUT /api/ai/features/enhance` | `ai_settings:write` | — (Admin) | model selection |
| `GET /api/ai/models?capability=image` | `ai_settings:read` | — (Admin) | |
| `GET /api/admin/ai/enhance/status` | `system_settings:read` | — (Admin) | Doctor + `/admin/settings/enhancer` readiness panel |
| `GET /api/features` | *(none)* | — (any authenticated user) | §8.8; deliberately **not** gated by `media:*`/`ai_settings:*` — this is the least-privilege carrier that makes the trigger and drawer policy reachable for non-admin circle members |
| `POST /api/media/bulk/enhance` | `media:write` | `collaborator` | §8.10/§16.2; epic #420 |
| `POST /api/media/bulk/enhance/by-filter` | `media:write` | `collaborator` | §8.11/§16.6; epic #420 |
| `GET /api/enhancement-batches` | `media:read` | `viewer` | §8.12; epic #420 |
| `GET /api/enhancement-batches/:id` | `media:read` | `viewer` | §8.13; epic #420 |
| `POST /api/enhancement-batches/:id/cancel` | `media:write` | `collaborator` | §8.14/§16.5; epic #420 |

No new permission scopes. Super-admin bypass (`media:write_any`) applies as elsewhere.

---

## 11. Doctor Integration

Added an `ai.pictureEnhancer` check (`DoctorService.checkPictureEnhancer`) to the Doctor "AI & Enrichment" section, alongside `ai.socialMedia` and `ai.duplicateDetection` (see [doctor.md §4](doctor.md)). As implemented, the check does **not** call a live `testModel`/connectivity probe (unlike the original draft) — it's a presence/consistency check only:

| Condition | Status | Message / Action |
|-----------|--------|------------------|
| `features.pictureEnhancement` off | `skipped` | "AI picture enhancer is disabled." |
| Feature on, `PICTURE_ENHANCEMENT_ENABLED=false` env override | `warning` | "Feature enabled in settings but PICTURE_ENHANCEMENT_ENABLED=false overrides it." / "Remove or set PICTURE_ENHANCEMENT_ENABLED=true." |
| Feature on, no enabled credential for the resolved provider (configured provider, or `openai` default) | `error` | "No enabled `<provider>` credential configured for enhancement." / "Enable an OpenAI credential in Admin Settings → AI." |
| Feature on, credential present, `ai.features.enhance` unset (no provider/model) | `warning` | "Enhancement feature is on but no enhancement model is selected." / "Select an enhancement model in Admin Settings → AI Picture Enhancer." |
| Feature on, credential + model present | `ok` | "AI picture enhancer ready (`<provider>/<model>`)." |

The check was **not** modified by the follow-up pass that shipped the EXIF writer (§5.1): there is still no `stampExif`/ExifTool-availability check. This is now a genuine gap rather than a consequence of a deferred feature — `ExifCarryoverService` degrades silently (a logged warning, unstamped bytes returned) on a missing `exiftool-vendored` install or absent `perl`, and Doctor currently has no visibility into that failure mode. Worth adding as a fast follow.

---

## 12. Cost, Safety & Limitations

- **Cost.** `gpt-image-1` image generation is **billed per image and is materially more expensive than a text/vision call.** v1.2 bounded spend to explicit, one-at-a-time user actions by construction (no bulk, no upload-time auto-enhance). Epic #420 (§16) removed that ceiling — a single click can now queue up to `pictureEnhancement.maxBatchSize` (default `25`) separately-billed calls — so spend is now bounded by three things instead of one: the `maxBatchSize` admin-configured cap (§7.1), the never-truncate refusal on `bulk/enhance/by-filter` (a filter matching more than the cap is REFUSED outright, not silently trimmed to the first N — §16.6), and the batch confirmation dialog's explicit cost sentence, which for a filter-mode batch states outright that photos the user cannot currently see on screen are included (§16.7). Surface a subtle "uses AI credits" note in the UI (both single-item and batch).
- **Fidelity risk.** Generative editing can alter faces/text/detail (§2). Mitigated by `input_fidelity: 'high'`, the constraint-heavy prompt, `preserveFaces` default, and the mandatory review gate. **Never auto-applied** — batching (§16) queues the *generation* in bulk, but every result is still reviewed and decided one photo at a time; there is no bulk-apply.
- **Resolution loss.** Enhanced output is often lower-res than the original; the compare UI must make this obvious and replace must warn (§2 / §7 policy).
- **EXIF portability.** Shipped: the file-level marker (§5.1/§5.4) is applied via `ExifCarryoverService`, but strictly best-effort — a missing `exiftool-vendored`/`perl` install, an unwritable tmpdir, or corrupt input silently falls back to unstamped bytes with only a logged warning (no Doctor visibility yet, §11). In that fallback case only the in-app marker (§5.3) is authoritative.
- **Rate limits.** Handled by the queue's existing 429/529 deferral + backoff; `OpenAiProvider.enhanceImage` now preserves the provider's HTTP status onto the rethrown error so a real 429/529 is correctly classified and deferred (see [Implementation status (v1)](#implementation-status-v1)). This matters more now that batching exists: `ENRICHMENT_RATELIMIT_MAX_HITS` (default `10`) is a fixed budget shared across the whole queue's rate-limit deferrals, not scoped per batch — a large batch submitted during a sustained OpenAI quota window can exhaust that budget across its own jobs and permanently fail its tail (marking those `media_enhancements` rows `failed` rather than deferring them indefinitely), even though nothing about the individual photos was wrong. There is no per-batch rate-limit budget or backpressure in v1.3.
- **Idempotency / supersession.** One live enhancement per item, single-item and batch alike; re-requesting supersedes and reaps the prior staging for the single-item path. A **batch**, by contrast, never supersedes — an item already carrying a live enhancement is skipped and counted (`skipped.alreadyLive`), never discarded, because a batch touches many items unattended and silently destroying a completed, already-billed result would be far more costly than skipping it (§16.2).
- **Retention interacts with batch size.** `pictureEnhancement.retentionHours` (default `168`, 7 days) reaps unreviewed `ready`/`failed` staging regardless of whether the row came from a single-item request or a batch. A large batch a user does not get around to reviewing within the window loses every one of its already-billed results the same way a single unreviewed enhancement would — batching does not change the retention contract, it just makes the blast radius of ignoring it larger.

---

## 13. Testing Notes

**Backend (Jest + Supertest):**
- `picture-enhancement.handler.spec.ts` — mock the OpenAI `images.edit` client; assert staging upload, dims/size recorded from the actual returned bytes (§4.2/§6.1), `ready`/`failed`/`pending` (retry) transitions, retry-vs-rate-limit-deferral routing per the state machine in [Implementation status (v1)](#implementation-status-v1).
- `media-enhancement.controller.spec.ts` — photo-only 400, feature-flag 400, RBAC (viewer can GET, non-collaborator cannot apply), supersession, apply(keep_both) creates item + copies metadata + marker, apply(replace) overwrites/reprocesses/nulls-hash/re-enqueues faces, discard deletes staging.
- Metadata copy unit test — assert `capturedAt`/camera/geo columns carried and source `metadata` merged under the breadcrumb via `inheritableMetadata()` (§5.2); contentHash rotation + `P2002` fallback path.
- `exif-carryover.service.spec.ts` — assert the built `writeArgs` vector (tag groups, override ordering, the `Orientation#=1` PrintConv-bypass, dropped thumbnail/preview tags, AI marker tags per §5.1); best-effort fallback returns the input buffer unchanged on a simulated ExifTool failure.
- `openai.provider.spec.ts` — assert `rethrowWithProviderStatus` preserves `status`/`code`/`retry-after` on a simulated 429/529 SDK error, and that 401/404 keep their friendly messages.
- Retention sweep test — `expired` transition + staging deletion.
- `media-enhancement.service.spec.ts` / `enhancement-batches.controller.spec.ts` — batch enhancement (§16): `startBatch`/`startBatchByFilter` eligibility partitioning (`notPhoto`/`tooLarge`/`alreadyLive` sum to `requested`), `maxBatchSize` cap enforcement and the never-truncate by-filter refusal (`details.matchedCount`/`details.maxBatchSize`), `resolveFilterWhere`'s `AND`-merge (asserting it does NOT reproduce the `wherePeople` clobbering bug tracked as issue #431), `serializeBatch`'s derived status/counts (including the cascade-delete-shrinks-the-work-set case), and `cancelBatch`'s two gates (API-layer job deletion + `PictureEnhancementHandler`'s claim-time re-check).

**Frontend (RTL):**
- Enhance trigger routing: a selection with exactly one eligible photo opens the single-item drawer; more than one opens `BatchEnhanceDialog`; both gated on `useFeatureFlags()` (§8.8/§9.1), not `useSystemSettings()`.
- Drawer flow: preset selection pre-fills toggles → progress (queued vs. enhancing, elapsed time) → compare (before/after slider) → confirm dialogs; downscale warning renders; replace hidden/disabled per `replacePolicy`; replace calls `refreshFullItem`.
- `EnhancerSettingsPage.spec.tsx` — master toggle, readiness panel states, param save/validation (§9.6).

**Manual (`/verify`):** enable feature + configure OpenAI model → enhance a dim indoor photo → review → keep both (new item appears, original intact) → enhance another → replace (thumbnail regenerates, badge appears, EXIF marker present) → discard a third (staging gone).

---

## 14. Open Decisions Summary

Collected here for the review pass — each is flagged **⟐** in context above. Seven of eight are resolved for v1.1, as shipped; #6 remains genuinely open:

1. **Downscale policy on replace** (§2): **resolved as warn-and-allow** — `pictureEnhancement.blockReplaceOnDownscale` defaults to `false`; the UI shows the downscale warning but replace is not blocked unless an admin opts in.
2. **Auto-straighten** (§2): **resolved as an optional prompt toggle, off by default** — `adjustments.straighten` (§4.1) ships as a request param, default `false`.
3. **contentHash rotation on replace** (§3): **resolved as null-and-recompute** — `replace` nulls `MediaItem.contentHash` before `reprocessObjectNow`, matching the P2002-fallback handling already in `media-metadata-sync.service.ts`.
4. **Two-tier analyze-then-edit** (§4.3): **resolved as single-call v1** — `picture_enhancement` makes exactly one `images.edit` call per enhancement; no `pictureEnhancement.analyzeFirst` flag exists. Remains genuinely absent and future work.
5. **EXIF writer** (§5.1): **resolved as (A) — file-level carryover shipped, in the follow-up pass.** `exiftool-vendored` was added to `apps/api` (with `perl` in the Dockerfile base stage); `ExifCarryoverService` copies the original's EXIF/GPS/IPTC/XMP/ICC onto the enhanced file and stamps an AI marker; `pictureEnhancement.stampExif` now defaults to `true`. Originally resolved as (C) (in-app marker only) in the first pass — see [Implementation status (v1)](#implementation-status-v1).
6. **First-class `aiEnhancedAt` column** (§5.3): **leaning resolved in favor of NOT adding it** — the tag-based approach (`metadata._aiEnhanced` breadcrumb + the "AI Enhanced" system tag) is the direction issue #201 continues to build on rather than introducing a new column: the "Enhanced photos" tab of the hub (§9.7) is planned as a gallery over the existing system tag, not a query against a new column. That gallery is **not** built yet — it's a PR3 placeholder in the shipped PR1 (§9.7) — so this decision is directional, not fully proven out in a shipping surface yet. Treat as "leaning resolved, implementation pending in PR3," not "done." **Unaffected by epic #420** — batching (§16) groups enhancements by `batch_id`, an entirely separate axis from the AI-enhanced marker, and neither reopens nor depends on this decision.
7. **One live enhancement per item** (§6.1): **resolved as supersede semantics** — a new `POST …/enhance` request discards any existing `pending`/`processing`/`ready` row's staging bytes for that item.
8. **`allowReplace` default** (§7): **resolved as `true`** — replace is allowed by default; admins can set `pictureEnhancement.allowReplace=false` to force keep-both-only.

---

## 15. Future Work

| Capability | Notes |
|-----------|-------|
| Bulk enhancement — **starting** many enhancements at once | **Shipped in epic #420** (§16) — `POST /api/media/bulk/enhance` (issue #421, explicit selection) and `POST /api/media/bulk/enhance/by-filter` (issue #424, server-resolved filter), a batch progress page (issue #423), and the `media_enhancement_batches` grouping table. Moved out of this table; see §16. |
| Bulk enhancement — **reviewing** many results at once | **Still not built.** §16's batches queue *generation* in bulk, but every `ready` result is still reviewed and decided one photo at a time in the `/enhancements` hub's Pending review tab (§9.7) — there is no multi-select "keep both/replace/discard these N" action. **Correction to the plan this row used to state:** an earlier draft of this row said the bulk-review work would land on the shared `review_runs`/`review_run_items` evaluate/execute-batch engine (the one serving bursts/duplicates/location-suggestions bulk review — see [Review Runs spec](review-runs.md)). That plan was **not** followed for the bulk-*start* work that actually shipped (§16 explains why: the per-item unit of work already exists as the `picture_enhancement` job, so an evaluate/execute-batch pair would only re-implement OpenAI orchestration a second time), and it remains an open, unresolved design question for whichever future issue tackles bulk *review* — reusing `review_runs` is one option, not a settled decision, since a review action here (keep_both/replace/discard) doesn't reduce to the archive/trash/dismiss/accept/reject vocabulary that engine's `ReviewRunAction` enum currently expresses. |
| Two-tier analyze-then-edit | Vision-model diagnosis feeding the edit prompt for sharper targeting; `pictureEnhancement.analyzeFirst` flag (§4.3/§14 #4). |
| Additional providers | Registry supports it; e.g. a local ESRGAN/Real-ESRGAN upscaler or Stability edit endpoint for true enhancement/super-resolution. |
| C2PA content credentials | Cryptographic provenance marking (the industry standard for "AI-edited") instead of/alongside the EXIF marker (§5.1/§5.4 already ship an IPTC `DigitalSourceType` marker, but not full C2PA). |
| First-class `aiEnhancedAt` column | §5.3/§14 #6 — an indexed boolean/date column for an "AI Enhanced" search facet, in addition to the existing `metadata._aiEnhanced` breadcrumb + system tag. |
| Doctor ExifTool-availability check | §11 — Doctor has no visibility into `ExifCarryoverService`'s silent best-effort fallback (missing package/perl, unwritable tmpdir). |

**Shipped since the original draft** (moved out of this table): additional presets/styles beyond the original "Auto" (§4.1, four presets shipped) and a draggable before/after slider in the compare UI (§9.3, `BeforeAfterSlider.tsx`).

---

## 16. Batch Enhancement

**Epic #420** — starting an AI enhancement for many photos in one action. This section documents what shipped; §1, §7.1, §8, §9.1, §9.7, §10, §12, §14, and §15 above have been updated in place wherever this feature changed what they said.

### 16.1 User-facing flow

`selection top bar → BatchEnhanceDialog → one batch → per-item review in the hub`. Two entry points feed the same dialog in two modes (`BatchEnhanceTarget`, a discriminated union of `{ kind: 'selection' }` and `{ kind: 'filter' }`):

- **Multi-select** (§9.1): selecting more than one eligible photo in the gallery and clicking "AI Enhance N photos" opens the dialog in **selection** mode, sending an explicit id list.
- **"Enhance all matching photos"**: an always-available toolbar entry that opens the dialog in **filter** mode against the view's current filter (or an album's full membership), regardless of how many — if any — items are currently selected.

Selecting exactly **one** eligible photo does **not** open this dialog — it still opens the single-item `MediaEnhancementDrawer` (§9.3), because a batch of one has nothing to compare against and the drawer's params → progress → compare → decide flow already fits that case perfectly. §9.1 documents the exact split.

Both modes share the params step: a preset picker (the same six cards described in §9.3 — Auto, Restore old photo, Low-light rescue, Colorize B&W, Portrait polish, Custom — from the shared `components/media/enhancePresets.tsx` module) plus the same customizable adjustment/strength/instructions/quality controls as the single-item drawer. **One params object applies to every photo in the batch** — there is no per-photo tuning before results exist, since tuning without seeing a result is guesswork; each result is still reviewed individually afterwards. Submitting shows a per-reason skip breakdown (`notPhoto` / `tooLarge` / `alreadyLive`) inline before the dialog closes, then a toast with a "View progress" action that deep-links to the batch's progress page (§16.4).

### 16.2 Architecture: a grouping, not an engine

This is the load-bearing decision of the whole feature, and it is worth stating as settled reasoning rather than a summary, because the natural first instinct — "there's already a shared engine for bulk actions, reuse it" — is wrong for this specific feature and the reason why does not disappear just because nobody wrote it down.

MemoriaHub already has a general pattern for "start a bulk operation, track its progress, let it run in the background": the evaluate/execute-batch pair, used by Media Workflow Automation (`workflow_evaluate`/`workflow_execute_batch`), Empty Trash at Scale (`trash_empty_evaluate`/`trash_empty_execute_batch`), and the shared review-run engine (`review_run_evaluate`/`review_run_execute_batch`, serving bursts/duplicates/location-suggestions bulk review — see [Review Runs spec](review-runs.md)). Every one of those exists because the underlying mutation (archive a burst group, hard-delete a trashed item, run a workflow action) had **no pre-existing per-item async unit of work** — the evaluate job's whole job is to materialize a matched-item list, and the execute-batch job's whole job is to apply a mutation that, before the engine existed, only ever ran synchronously inside one HTTP request.

Batch enhancement is different in exactly the way that makes that engine the wrong tool: the per-item unit of work **already existed** before epic #420, as the ordinary `picture_enhancement` enrichment job (§6.2) that the single-item `POST /api/media/:id/enhance` endpoint has enqueued since v1.0. That job already has everything an evaluate/execute-batch pair would have had to re-implement: retry with backoff, 429/529 rate-limit deferral, an execution timeout, and visibility in `/admin/jobs`. Building an evaluate/execute-batch pair on top of it would mean re-wrapping one OpenAI orchestration inside a second one for no capability gained — the evaluate phase would materialize an id list (which `startBatch`/`startBatchByFilter` already do, synchronously, in one request), and the execute-batch phase would call the exact same `enhanceImage()` code path the existing handler already calls.

So the shipped design is a **batching layer, not a second execution engine**: `MediaEnhancementService.startBatch`/`startBatchByFilter` (issues #421/#424) do the authorization + eligibility-partitioning work synchronously in the request, create one `media_enhancement_batches` row, and then enqueue one ordinary `picture_enhancement` job per eligible item — the identical job type, identical handler (`PictureEnhancementHandler`), identical retry/rate-limit/timeout behavior the single-item path has always had. The batch row is pure **grouping metadata**; it never runs code of its own. **Progress is derived, status is computed** — see §16.4.

*(§15 used to carry a plan that this work would land on the shared `review_runs` engine instead. That plan was not followed, for the reason above; the corrected §15 row records this as a documented deviation, not a silent reconciliation.)*

### 16.3 Data model

`media_enhancement_batches` (migration `20260812000000_add_media_enhancement_batches` — see the CLAUDE.md Database Tables entry for the full column list): `id`, `circleId` (cascade delete), `requestedCount` / `queuedCount` (Int), `skipped` (JSONB, `{ notPhoto, tooLarge, alreadyLive }`), `params` (JSONB — the one enhance-params object, plus a `_filter` snapshot for a filter-mode batch), `source` (`'selection'` | `'filter'`), `cancelledAt`, `lastError`, `createdById` (FK → `users`, SetNull), `createdAt`/`updatedAt`. Index `(circleId, createdAt)`. The same migration adds `media_enhancements.batchId`.

`media_enhancements` (§6.1) gains `batchId` — a nullable FK → `media_enhancement_batches`, **`onDelete: SetNull`**. SetNull, not Cascade, because deleting a batch record must never delete the enhancements it produced — a batch's enhancements may already be `applied` (a new `MediaItem` created, or the original overwritten), and a batch is disposable metadata that must never be able to take real, decided-on media state down with it if it were ever pruned. `batchId` is null for a single-item, non-batched request. New index `(batchId)` serves both `GET /api/media/enhancements?batchId=` (§8.9) and the batch's own progress tally (§16.4).

`MediaEnhancementStatus` gains a new terminal value: **`cancelled`**, added in its own follow-on migration (`20260812010000_add_media_enhancement_cancelled_status`) — Postgres cannot add an enum value in the same transaction as statements that reference it, the same reason `MediaTagSource.system` and `NotificationType.memories_ready` each got their own migration. Appended last (an append-only `ALTER TYPE … ADD VALUE`, no `BEFORE`/`AFTER` clause), matching that same precedent. `cancelled` means the row was superseded or withdrawn **before any render ever ran**. This is deliberately a different state from `discarded`: `discarded` means a human reviewed a completed `ready` result and chose not to keep it (rendered, then rejected); `cancelled` means nothing was ever rendered at all. Conflating the two would make a batch's "how much money did this actually spend" story unreadable from the status column alone — a `discarded` row cost a `gpt-image-1` call, a `cancelled` one did not.

### 16.4 Progress: the `BaseRun`-shaped detail response

`GET /api/enhancement-batches/:id` (§8.13) returns the same 14-field shape every other async-run backend in this codebase emits — `id`, `circleId`, `status`, `matchedCount`, `processedCount`, `succeededCount`, `failedCount`, `skippedCount`, `startedById`, `createdAt`, `updatedAt`, `startedAt`, `finishedAt`, `lastError` — plus six batch-specific extras (`requestedCount`, `queuedCount`, `skipped`, `params`, `source`, `cancelledAt`) outside that shared contract. This is deliberate, not incidental: `workflow_runs`, `trash_empty_runs`, and `review_runs` all emit that same field set (informally, `BaseRun`), and the reason to match it exactly is that the web frontend already has a `RunProgressPanel` component and a `useRunPolling` hook built against it. Shaping the batch payload to match means the batch progress page (§16.7) is **assembly, not construction** — it reuses both pieces with zero new polling or progress-bar code.

Every one of those 14 fields is **derived**, never stored. `media_enhancement_batches` carries no counter columns at all. `MediaEnhancementService.tallyBatches` runs one `groupBy` over `media_enhancements` (`by: ['batchId', 'status']`, keyed to the requested batch ids) and `serializeBatch` folds the per-status counts into the response on every read:

- `succeededCount` = `ready` + `applied` + `discarded` + `expired` — every status meaning the render itself completed, regardless of what the human later did with the result. What happened after rendering is a separate axis from whether the batch's *work* succeeded.
- `failedCount` = `failed`.
- `skippedCount` = `cancelled` — rows withdrawn before any render ran (§16.5).
- `matchedCount` = the sum of all of the above plus `pending` + `processing`; `processedCount` = `matchedCount` minus the still-in-flight `pending`/`processing` count.

**`status` keys off "no rows remain `pending`/`processing`", never off `processedCount === matchedCount`.** This is the one rule in this section most worth internalizing, because the natural-looking counter-equality check is actively wrong here: `MediaEnhancement.mediaItemId` is `onDelete: Cascade`, so hard-deleting a source photo mid-batch deletes its enhancement row and **shrinks the work set** the batch is tracking. Under a counter-equality check, a batch that lost a row this way would never again satisfy `processedCount === matchedCount` (both numbers just got smaller together, but a stale target computed once would not shrink with them) and would sit at `running` forever. This is the exact failure mode already documented for `review_runs` (see the header comment above the `ReviewRunItem` model in `schema.prisma`, and `review_run_items`' entry under CLAUDE.md's Database Tables — "processedCount may legitimately finish below matchedCount … finalize keys off 'no rows remain matched/processing', not counter equality"), imported here deliberately rather than rediscovered. A batch with zero eligible rows (nothing survived eligibility partitioning) therefore renders as a terminal `completed` immediately, never a stuck `running` — there is nothing in flight to wait for.

### 16.5 Cancellation

`POST /api/enhancement-batches/:id/cancel` (§8.14) is **cooperative**, not immediate: only rows still at `pending` are affected. Their job rows are deleted (matched precisely by the enhancement id carried in `payload.enhancementId` — never by `mediaItemId`, which could catch an unrelated job for the same item) and the `media_enhancements` rows are marked `cancelled`. A row already `processing` is deliberately left running: its `gpt-image-1` call is already billed the moment the handler starts it, so aborting it would spend the money and throw away the result for nothing — the correct response to "I want to stop" once money is already spent is to let the work finish and decide on the result, not to destroy it.

This leaves one race window: a job claimed by a worker in the moment between the cancel request reading "still pending" and the delete actually landing. `PictureEnhancementHandler.process` closes it with a second, cheap gate — before making the OpenAI call, it re-reads the enhancement's `batchId` and, if set, checks whether that batch's `cancelledAt` is now set; if so, it marks the row `cancelled` and returns without ever calling the provider. Two gates, one at the API layer and one at the point of spend, is what makes "cancel" actually mean "we will not spend more money on this" rather than "we tried to stop, but a few in-flight jobs might have already been running when we asked."

### 16.6 The by-filter endpoint and its never-truncate rule

`POST /api/media/bulk/enhance/by-filter` (§8.11, issue #424) is the one endpoint in this whole feature that can enqueue a set the caller never enumerated — a filter like "everything in this album" or "every photo from this trip" can silently match hundreds of photos the user has never scrolled past. That is also the only reason its request-handling order deliberately diverges from `startBatch`'s: **authorization runs before the match count**, not after. `startBatch`'s cap check is a pure count of client-supplied ids and costs nothing to leak; this endpoint's cap check requires counting rows inside a circle, and reporting `matchedCount` back to a caller who turns out not to be a member would leak how many photos that circle holds under a filter they have no right to query. Running the membership check first closes that information-leak path.

Once membership is confirmed, `resolveFilterWhere` pins three predicates in the compiled `Prisma.MediaItemWhereInput` regardless of what the filter body asked for, each for a distinct reason:

- **`deletedAt: null`** — `buildMediaWhere` never filters trash on its own; without this pin, a filter-mode batch would spend real money re-rendering photos sitting in Trash.
- **`archivedAt: null`** — pinned directly rather than routed through the filter's own `excludeArchived` flag, so the guarantee does not depend on the caller remembering to pass it.
- **`type: MediaType.photo`** — expressed in SQL, not as a post-filter, because a post-filter would let videos count toward the match total before being silently dropped — and the number reported back on an over-cap refusal must be the number that would actually run, or the refusal is a lie. A caller who explicitly filters `type=video` therefore gets the honest "no photos match this filter" `400`, not a batch of zero after a phantom match.

If the resolved match is **zero**, the request is a `400` ("no photos match this filter") — not an empty, pollable batch. If the resolved match **exceeds `pictureEnhancement.maxBatchSize`**, the request is **refused outright** — `400` with `{ message, details: { matchedCount, maxBatchSize } }` — and is **never truncated to the first N**. This is the same principle as the cost note in §12: a user who filters to 400 photos and silently gets the first 25 enhanced, chosen by an ordering they cannot see, has been charged for a result they did not ask for and cannot reason about. `matchedCount`/`maxBatchSize` are carried under `details` rather than as top-level response fields, per the repo-wide `HttpExceptionFilter` allowlist gotcha (CLAUDE.md Gotchas / Lessons Learned) — a top-level custom field on a thrown `HttpException` payload is silently dropped by the filter before it reaches the client, so this is not a stylistic choice.

Only once the match is confirmed to be within bounds does the endpoint fetch the actual id list (bounded, by construction, to at most `maxBatchSize` rows) and delegate into the exact same `createBatchFrom` path `startBatch` uses (§16.2) — eligibility partitioning, job priority, and dedup semantics are therefore identical between the two bulk endpoints; only how the id list was obtained differs.

### 16.7 Frontend

`components/media/BatchEnhanceDialog.tsx` (issue #422 introduced it in selection mode; issue #424 added filter mode, §16.6) is one component covering both entry points (§16.1), selected by its `target: BatchEnhanceTarget` prop's `kind` discriminant (`'selection'` | `'filter'`) rather than two separate dialogs — the params step, the submit call, and the result/skip-breakdown display are identical either way; only the confirmation copy differs (a filter-mode batch's confirmation states outright that photos the user cannot currently see on screen are included, since that is the one fact a filter-mode user cannot infer for themselves). It shares its preset/params vocabulary with the single-item `MediaEnhancementDrawer` via `components/media/enhancePresets.tsx` (§9.1).

`pages/Enhancements/EnhancementBatchPage.tsx` (issue #423) is the batch progress page reached from the submit toast's "View progress" action or from `RecentBatches` (§9.7). As noted in §16.4, it is assembly rather than construction: `useRunPolling` polls `GET /api/enhancement-batches/:id` until the API reports a real terminal status, and the shared `RunProgressPanel` renders the counter tiles and the progress bar with two page-specific label overrides that are load-bearing, not cosmetic — the succeeded tile reads **"Ready to review"** rather than "Succeeded" (everywhere else in the app "succeeded" means the work is finished; here it means the work has only just started needing the user's attention), and the cancel button reads **"Cancel remaining"** rather than a bare "Cancel" (it must not promise to stop work that is already billed and running — §16.5). The review handoff — a button linking to `/enhancements?batchId=<id>` (§9.7) — is enabled the moment the first result lands rather than waiting for the whole batch to finish, since reviewing a 26-photo batch should not have to wait for photo 26. A failed-items table, sourced from `GET /api/media/enhancements?batchId=&status=failed` (§8.9), fills the gap left by batches having no `review_run_items`/`workflow_run_items` analogue of their own to page through.

Cancelling on this page is gated on **both** `media:write` + the per-circle `collaborator` role **and** the batch belonging to the currently **active** circle (`activeCircleRole` only describes the active circle's role, not an arbitrary batch's circle) — a batch deep-linked in from another circle (e.g. a stale bookmark, or a link shared before switching circles) withholds the cancel affordance entirely rather than guessing at a role the client cannot verify, matching the precedent `location-suggestion` bulk actions already established for per-circle role gating.

### 16.8 Deviations from the original phase plan

Documented here as deviations, not silently reconciled, per this document's own precedent (§14/§15 already do this for the v1.0/v1.1 passes):

1. **Batch read/cancel live on `MediaEnhancementService`**, not a separate service. An earlier phase plan called for a dedicated service backing the new `EnhancementBatchesController`; what shipped instead extended the existing `MediaEnhancementService` with `startBatch`/`startBatchByFilter`/`listBatches`/`getBatch`/`cancelBatch`, since the batch and single-item paths share `createBatchFrom`'s eligibility logic, the settings/feature-gate reads, and the `supersedeLive`-adjacent invariants closely enough that splitting them into two services would have meant threading shared state (or a second dependency) across a service boundary for no isolation benefit.
2. **`skipped.notPhoto` also absorbs ids that vanished** between the authorization read (`assertAllInCircle`) and the eligibility-partitioning read a few queries later — a concurrent hard delete of a source photo mid-request. Rather than a fifth bucket or a failed request, a vanished id is folded into `notPhoto` (it is, definitionally, no longer an eligible photo), which is what keeps the invariant `notPhoto + tooLarge + alreadyLive + queued === requested` true even under that race.
3. **`wherePeople(ids, 'all')` clobbering, fixed only in the by-filter path.** `buildMediaWhere` and `wherePeople(ids, 'all')` both return a top-level `AND` array; object-spreading the two (the pattern the two pre-existing call sites, `MediaService.listMedia` and `addAlbumItemsByFilter`, both use) lets the people fragment's `AND` silently overwrite the filter's own `AND`, dropping every other condition and **widening** the match set. `resolveFilterWhere` (§16.6) fixes this by merging the two `AND` arrays instead of spreading, but only at this one call site — the two pre-existing ones still spread and are tracked separately as **issue #431**. Until #431 lands, this creates a real, if narrow, asymmetry: a gallery view or an album's by-filter add can show or add MORE photos for the same filter+person combination than this endpoint would report as matching. The asymmetry is safe in the direction it points, though — this endpoint resolves the narrower, correct set and refuses rather than truncates an over-cap match, so the bug can only ever cause it to under-match relative to the gallery, never to overcharge relative to what a user believes they selected.
4. **The web client stringifies boolean filter fields.** `mediaFilterFields`'s boolean-ish query fields (`favorite`, `missingGeo`, `noFaces`, …) are declared `z.string().transform(...)` on the API side — a query-string-oriented shape inherited from `GET /api/media` — which means they expect the literal strings `"true"`/`"false"` even inside a JSON body. `BatchEnhanceDialog`'s `serializeEnhanceFilters` deliberately matches that quirk rather than sending real JSON booleans, for compatibility with the shared filter object. The consequence, inherited rather than introduced here: a caller that sends a raw JSON `true` for one of these fields gets `undefined` after the zod transform, and the filter is **silently dropped** — widening the match set rather than erroring. The pre-existing `addAlbumItemsByFilter` client path has the identical latent drop; this is a client-side footgun in the shared filter-serialization convention, not something new to the bulk-enhance feature.
5. **`BatchEnhanceDialog` is one component covering both selection and filter targets**, via the `target: BatchEnhanceTarget` discriminated union (§16.7) — not two separate dialogs, as an earlier framing of the two entry points as independent features might have suggested.
6. **Cancel is gated on the active circle**, not merely on the batch's own circle role (§16.7) — the client cannot verify a per-circle role for a circle that is not currently active, so the affordance is withheld rather than trusted from a stale or cross-circle deep link.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | July 2026 | AI Assistant | Initial draft for review. |
| 1.0 | July 2026 | AI Assistant | Marked Implemented (v1); documented deviations from the draft (EXIF writer deferred to option C, `stampExif` default flipped to `false`, `enhanceImage` failures use normal retry not rate-limit deferral, Doctor check has no live `testModel` probe); resolved all eight §14 open decisions. |
| 1.1 | July 2026 | AI Assistant | Phase G follow-up (issue #98). Fixed the two root causes making the feature unreachable: `GET /api/features` (§8.8) least-privilege endpoint + `/admin/settings/enhancer` admin page (§9.6), since `features.pictureEnhancement` was the only one of eight feature flags with no UI toggle. EXIF writer SHIPPED (§5.1/§5.4, option A — `exiftool-vendored`, `stampExif` now defaults `true`), reversing v1.0's deferral; §14 #5 updated accordingly. Rate-limit classification FIXED (`OpenAiProvider.enhanceImage` preserves provider status; handler catch is now a retry/defer/fail state machine) — no longer a known limitation. Added enhancement presets + per-run `quality` override (§4.1). Fixed keep_both to inherit source item metadata via `inheritableMetadata()` (§5.2). Fixed enhanced dims to read from actual output bytes, not the requested canvas (§4.2/§6.1). Rebuilt the drawer around presets, queued-vs-enhancing progress with elapsed time, and a before/after slider with replace-policy gating (§9.3). §14 #6 (`aiEnhancedAt` column) and the two-tier `analyzeFirst` flag (§14 #4) remain genuinely unshipped. |
| 1.2 | July 2026 | AI Assistant | Issue #201 PR1, "the AI Enhancements hub" — the first cross-item surface for the feature. Added `GET /api/media/enhancements` (§8.9), a paginated cross-item enhancement listing with three status aliases, server-computed `expiresAt`, and staged-bytes-only-when-`ready` semantics. Added the `/enhancements` hub page (§9.7): Pending review tab live (list, expiry countdown, per-card review/keep-both/replace/discard), Enhanced photos and History tabs are PR3 placeholders. Added a sidebar "AI Enhancements" entry (Utilities section) carrying the app's first sidebar nav-badge (`NavItemDef.badgeCount`). Added `pendingEnhancements` to `GET /api/media/dashboard`, in the same commit as a fix for a pre-existing bug where `pendingBurstGroups`/`pendingDuplicateGroups`/`pendingLocationSuggestions` were returned top-level while the web client read them from `counts.*`, leaving three Home review-queue banners permanently dead. Raised `pictureEnhancement.retentionHours`'s default `72h → 168h` (7 days) — the hub is an inbox worked through over time, and 72h was reaping unreviewed, already-billed enhancements. `MediaEnhancementDrawer` gained an `enhancementId` prop to open directly on a named existing enhancement (what the hub's "Review" action uses). §14 #6 (`aiEnhancedAt` column) updated from "open" to "leaning resolved" (tag-based, no new column) since the tag-driven gallery it would back is still PR3, not shipped. §15's "Bulk enhancement" row updated from not-started to in-progress, landing in PR2 on the shared review-run engine. |
| 1.3 | August 2026 | AI Assistant | Epic #420 (issues #421/#422/#423/#424) shipped **starting** an enhancement for many photos at once — new §16. Issue #422 (epic phase 2) delivered the client-facing half: widening the `BulkActionToolbar` AI Enhance gate from a single-photo selection to a photo-count-in-selection gate that routes to either the single-item drawer or the new batch dialog (§9.1), the `BatchEnhanceDialog` component itself in selection mode (§16.7), the shared `components/media/enhancePresets.tsx` preset/params module extracted from `MediaEnhancementDrawer` so both surfaces consume one preset catalog (§9.1/§16.7), and the web `bulkEnhance` service call plus `maxBatchSize` on the client feature-flags type. `POST /api/media/bulk/enhance` (explicit selection) and `POST /api/media/bulk/enhance/by-filter` (server-resolved filter, never-truncate over-cap refusal) both queue ordinary `picture_enhancement` jobs grouped under a new `media_enhancement_batches` row (migration `20260812000000_add_media_enhancement_batches`) whose progress is entirely derived, never stored (§16.4); `MediaEnhancementStatus` gained `cancelled` (migration `20260812010000_add_media_enhancement_cancelled_status`), distinct from `discarded` — never-rendered vs. rendered-then-rejected. New setting `pictureEnhancement.maxBatchSize` (§7.1), also surfaced on `GET /api/features`. New endpoints `GET /api/enhancement-batches[/:id]` and `POST /api/enhancement-batches/:id/cancel` (§8.10-§8.14), plus a `batchId` filter on `GET /api/media/enhancements` (§8.9); no new RBAC permission (§10). **Corrected, not merely extended, four sections that v1.2's plan had gotten wrong once the code shipped:** §1 Non-Goals (bulk starting is no longer a non-goal; bulk *review* still is); §9.1 (the trigger is photo-count-in-selection, not raw selection size, and single-vs-batch is a routing decision to two different UIs, not a label); §12 (spend is now bounded by `maxBatchSize` + the never-truncate refusal + the confirmation dialog, not by one-at-a-time clicking; noted the `ENRICHMENT_RATELIMIT_MAX_HITS` shared-budget interaction and the retention-window blast-radius interaction, both new risks introduced by batching); and §15's "Bulk enhancement" row, split in two — bulk **start** marked shipped, bulk **review** kept as future work with its description corrected: the plan to build it on the shared `review_runs` engine was never followed for the work that shipped (§16.2 records why) and remains merely one option for the still-open review work, not a settled decision. Documented six deliberate implementation deviations from the original phase plan in §16.8 (batch service placement, the vanished-id `notPhoto` bucket, the by-filter-only `wherePeople` AND-merge fix — tracked as issue #431 for the two pre-existing call sites — the inherited boolean-filter-stringification footgun, the single discriminated-union dialog, and active-circle-gated cancel). §14 #6 noted as unaffected by this pass. |

# AI Picture Enhancer — Feature Spec

| Field | Value |
|-------|-------|
| **Version** | 1.4 (Implemented) |
| **Last Updated** | August 2026 |
| **Status** | Implemented (v1.4) — see [Implementation status (v1)](#implementation-status-v1) below for scope shipped vs. deferred |
| **Owner** | oscar@marin.cr |
| **Scope** | Photos only. Human-reviewed, non-destructive by default. Single-item or bulk-queued (up to `pictureEnhancement.maxBatchSize`); review of results is always single-item (§15). |

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
- **Bulk enhance START shipped (epic #420, issues #421/#424) — bulk REVIEW still is not.** `POST /api/media/bulk/enhance` (a selection) and `POST /api/media/bulk/enhance/by-filter` (a saved/ad-hoc filter, resolved server-side) each queue up to `pictureEnhancement.maxBatchSize` (default 25) individual `picture_enhancement` jobs behind one new `media_enhancement_batches` row, polled via `GET /api/enhancement-batches/:id` and cancellable via `.../cancel`. This is **not** built on the `review_runs`/`review_run_items` engine the §15 table used to say it would be — see the new §6.6 for why a second evaluate/execute-batch engine would only re-implement work the existing per-item `picture_enhancement` job already does. What genuinely remains unbuilt is reviewing the *results*: the hub's Pending review tab is still single-item keep-both/replace/discard, so a 25-photo batch is still 25 individual decisions — see the corrected [§15](#15-future-work).
- **Facial identity on `restore_old_photo` hardened (issue #436).** Restoring a scanned print was returning a recognizably *different person* — creases repaired, face redrawn. The preset clause now carries explicit face-geometry language plus permission to leave facial damage unrepaired, and the drawer's restore prefill drops from `strength: 'strong'`/`sharpness: true` to `'balanced'`/`false`. `input_fidelity` is unchanged (already `'high'` on every affected run). The underlying ~1.6 MP output ceiling — which makes small faces synthesizable no matter what the prompt says — is **known and unfixed**; see [§4.3.1](#431-why-restore_old_photo-carries-identity-language-the-other-presets-dont-issue-436).

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

---

## 1. Overview and Goals

### The problem

A large fraction of a family library is casual phone/point-and-shoot photography: dim indoor shots, muddy colors, soft focus, crooked horizons, heavy noise. Users want a one-click "make this look better" that applies good photographic judgement — white balance, exposure/tone, color, sharpness, denoise, straightening — without them having to learn an editor. We already have the AI-provider plumbing (OpenAI credentials, per-feature model selection) and a destructive photo-edit precedent (orientation edit), so an **AI Picture Enhancer** is a natural addition.

The request: when **exactly one photo** is selected, a button in the selection top bar (and, mirroring the orientation editor, in the full-screen viewer) triggers an OpenAI image model to produce an enhanced version. The user then **reviews original vs. enhanced side-by-side** and chooses to **keep both** (enhanced saved as a new item) or **replace** the original. On replace, the enhanced file must carry over **all of the original's metadata** and be **marked as AI-improved** both in-app and, where possible, in the file's EXIF/XMP.

### Goals

- **Photo-only.** Every enhancement — single-item or one row inside a bulk batch (§6.6) — is gated by the same two-part guard already used by orientation edit (`media-orientation-edit.service.ts:96`): `MediaItem.type === photo` **and** `StorageObject.mimeType` starts with `image/`. The single-item trigger appears only when exactly one selected item is a photo; a multi-photo selection instead offers the bulk-enhance trigger (§9.1), which enforces this guard per item and reports a non-photo as skipped rather than failing the whole request (§6.6).
- **Non-destructive by default, human-in-the-loop.** The AI output is never auto-applied. It lands in a **staging preview** that the user must explicitly accept (keep both / replace) or discard. This is a safety requirement, not a nicety — see §2.
- **Reuse the AI feature pattern.** Model selection via a new `ai.features.enhance` config (provider + model), configured in Admin Settings → AI exactly like search/tagging/embedding.
- **Reuse the enrichment queue.** Enhancement is a slow external call (10–60 s), so it runs as an async `picture_enhancement` enrichment job, polled by the UI — not a synchronous request like orientation edit.
- **Reuse the destructive-edit precedent for "replace".** The replace path clones `MediaOrientationEditService`'s structure: download → transform → overwrite same storage key → update columns → `reprocessObjectNow` → re-enqueue face detection.
- **Global feature toggle** (`features.pictureEnhancement`, default `false`) + env kill-switch (`PICTURE_ENHANCEMENT_ENABLED`, default `true`), consistent with face recognition, auto-tagging, burst/duplicate detection, location inference, social-media detection.
- **Portable + queryable AI-improved marking.** A DB/tag marker inside the app (searchable) **and** a best-effort EXIF/XMP stamp in the file bytes.

### Non-Goals (v1)

- **Bulk enhance is start-only, not review-only.** Epic #420 (§6.6/§8.10-§8.14) lets a caller queue up to `pictureEnhancement.maxBatchSize` enhancements from a selection or a filter in one request. Reviewing the results is still exactly the single-item flow below — no multi-select keep-both/discard across a batch's finished rows.
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

### 3.1 Replace and the thumbnail cache (issue #434)

`applyReplace` overwrites the original's bytes in place, and `reprocessObjectNow` correctly re-renders the thumbnail before the response returns. That was never the problem. The problem was *where those correct new bytes landed*: thumbnails used to live at a content-independent key, `thumbnails/<objectId>.jpg`, uploaded with `Cache-Control: public, max-age=31536000, immutable` and handed out through `MediaThumbnailService`'s ~21.6h signed-URL reuse window. The new bytes therefore arrived at a byte-identical URL that the API cache, the browser and any CDN had each been told would never change — so every grid surface kept rendering the pre-enhancement image while the lightbox, which re-signs a fresh `downloadUrl` on `refreshFullItem()`, showed the enhanced one. The two views visibly disagreed.

The fix is **versioned, content-addressed thumbnail keys**: `thumbnails/<objectId>-<sha256(thumbBytes).slice(0,16)>.jpg` (`apps/api/src/storage/processing/thumbnail-key.util.ts`). Unchanged source bytes re-render to the identical key, so ordinary reprocessing stays an idempotent upsert with no churn; changed bytes move to a key nothing has ever cached, which makes `immutable` a true statement instead of a bug. The orientation editor — structurally the same destructive overwrite, and the precedent this path was cloned from (§1) — had the identical defect and is fixed by the same change.

Two ordering rules follow, and both are load-bearing:

1. **`syncFromStorageObject` is awaited inside the request** (see the contentHash bullet above). Until it runs, `MediaItem.metadata.thumbnailStorageKey` still names the OLD key, which is precisely what every list surface signs.
2. **`ThumbnailPruneService.pruneSupersededThumbnails` runs only AFTER that sync.** It deletes the previous thumbnail's row and bytes; doing it first would delete bytes a concurrent gallery request could still be signing. It is best-effort and never throws — an orphaned thumbnail is tens of KB of waste, not a reason to fail an edit that has already committed.

The rejected alternatives are worth recording. Appending a `?v=` cache-buster to the materialized URL does not work here: an S3 SigV4 presigned URL signs its entire canonical query string, so an extra parameter yields `SignatureDoesNotMatch`. Invalidating only the in-memory signed-URL cache would fix S3 (a re-signed URL carries a fresh `X-Amz-Date`, so the string changes) but not a provider whose URL is stable, and it leaves `immutable` a lie. Dropping `immutable` from `THUMBNAIL_CACHE_CONTROL` would give up the bandwidth win the design deliberately bought for the overwhelmingly common never-changes case.

**contentHash handling (the gotcha from the orientation precedent):** `MediaMetadataSyncService` refuses to overwrite a non-null `contentHash`. Orientation edit sidesteps this by never touching the hash (stale hash persists). For enhancement the bytes genuinely change, so:
- **keep_both:** the new item starts with `contentHash = null` and the reprocess pipeline computes it fresh — normal new-upload path.
- **replace:** explicitly set `MediaItem.contentHash = null` before `reprocessObjectNow` so the sync recomputes it. Handle the `(circle_id, content_hash)` partial-unique `P2002` path already caught in `media-metadata-sync.service.ts:293` (retry update without hash + log). **⟐ Decision for review:** confirm we want replace to rotate the hash (recommended — otherwise dedup/restore logic sees stale identity).
- **`applyReplace` AWAITS `syncFromStorageObject` (issue #434).** Nulling the hash only works if something recomputes it, and the recompute is delivered by `MediaMetadataSyncService`'s `@OnEvent(OBJECT_PROCESSED_EVENT)` listener — which `ObjectProcessingService` fires with `emit()`, not `emitAsync()`, so it is fire-and-forget *relative to the request*. If that listener throws it catches and logs, leaving the item with a permanently null `contentHash` and silently outside exact-hash dedup. `applyKeepBoth` always called the sync explicitly; `applyReplace` now does too, and the same call is what repoints the item at its new thumbnail key (§3.1 below).

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
| `restore_old_photo` | "This is an old or damaged photograph. Repair scratches, dust, creases, tears, stains, and faded areas, and recover lost contrast and detail. Keep the photo's period character — do not modernize it or colorize it unless asked. Do NOT redraw, reshape, re-detail or re-age any face: leave facial features, eyes, mouth, and jawline exactly as they appear in the original, even where they remain soft, blurred, or damaged. It is better to leave a face imperfect than to change who the person looks like. Preserve the original film grain and paper texture." |
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

### 4.3.1 Why `restore_old_photo` carries identity language the other presets don't (issue #436)

Restoring a scanned family print was returning **a recognizably different person**: the creases were repaired perfectly and the face was redrawn — a different jawline, different eye shape, a different apparent age. On a family photo archive that is the worst possible failure mode, because the face *is* the artifact, and a user who then hits **Replace** overwrites the original bytes in place and keeps the fabricated likeness.

Three compounding causes; the first two are fixed, the third is not.

1. **The clause said nothing about faces.** The generic always-on `preserveFaces` sentence ("Do NOT alter anyone's face, identity, expression, skin tone, or the number of people.") is present on every run and was demonstrably insufficient here — `restore_old_photo` is pointed at *damaged faces* essentially every time it is used, so "repair the damage" and "don't alter the face" are in direct conflict, and repair won. Ironically `portrait_polish` — the preset *least* likely to be aimed at a damaged face — was the only one defending facial geometry. Three obligations now live in the clause and must survive any rewording (they are pinned by name in `enhance-prompt.builder.spec.ts`): **(a)** name the specific geometry — features, eyes, mouth, jawline — since the generic sentence already covers "the face" and isn't enough; **(b)** explicitly *permit leaving damage unrepaired on faces*, which is what actually resolves the conflict; **(c)** preserve grain/texture, so a restored face isn't a smooth synthetic patch on a grainy print.
2. **The preset's own prefill fought that guard.** `MediaEnhancementDrawer`'s restore prefill sent `strength: 'strong'` (compiling to "**Strongly** … increase clarity and sharpness") with `sharpness: true`. In a generative edit model the aggressive instruction reliably wins, and "increase sharpness" on a soft face is an invitation to re-detail a face the model can only re-detail by inventing it. The prefill is now `strength: 'balanced'`, `sharpness: false`; `dehaze`/`tone`/`denoise` stay on because they act on the paper, not the face. Both remain raisable by hand under **Customize**.

   Note this does **not** change `input_fidelity`, which was already `'high'` on every affected run — `preserveFaces` defaults `true` and short-circuits the condition in §4.2. Forcing `input_fidelity: 'high'` is a genuine no-op and is not the fix.
3. **Resolution ceiling — known, unfixed.** Input is downscaled to a 2048px long edge, and the `gpt-image-1` output canvas caps at `1024×1024` / `1024×1536` / `1536×1024` (~1.6 MP). A face in a group shot can land on ~80×80 px of the output canvas; at that size there is no signal left to preserve and the model *must* synthesize the features. `images.edit` is generative — it re-renders the whole frame rather than retouching in place — and the face is the highest-information region, so that is where invention is most visible. **This cannot be fixed by prompt wording.** Changes 1 and 2 materially reduce the failure rate; they do not eliminate it. The real fix is a face-aware two-pass restore (restore the background, composite the original face region back, or run a second pass at native resolution over each face crop), which is a separate architectural piece of work — new compute in the handler, a compositing step, seam handling, and an interaction with the EXIF-carryover and staging-object flow.

**User-facing workaround** for a photo where identity still drifts, and still useful after the above: **Restore old photo** → **Customize** → Strength **Subtle**, uncheck **Sharpness**, leave **Preserve faces** checked, and add free-text instructions along the lines of *"Do not redraw or reshape any face; leave facial features exactly as they are even if they stay soft. Repair only the paper."* Typing instructions is what flips the request to `intent: 'custom'`, which is the gate that appends the text to the prompt. Then choose **Keep both**, never **Replace**.

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

### 6.6 Bulk enhance — `media_enhancement_batches` and the `cancelled` status (epic #420)

**The batch is a grouping over existing `media_enhancements` rows, not a second run engine.** This deliberately does NOT reuse the `review_runs`/`review_run_items` evaluate/execute-batch engine that bursts, duplicates, and location suggestions share (see [Review Runs spec](review-runs.md)) — that engine exists because ITS per-subject work (resolving a burst group, applying a bulk edit) had no existing async unit of work to hand off to. Here the per-item unit of work already exists: the single-item `picture_enhancement` enrichment job, complete with retry, 429/529 rate-limit deferral, execution timeouts, and `/admin/jobs` visibility. A second engine on top would only re-implement OpenAI call orchestration a second time. So a batch is exactly two things: (1) one `MediaEnhancementBatch` row recording what was asked for, and (2) N ordinary `MediaEnhancement` rows — each pointing back at the batch via a nullable `batchId` — each driving its own ordinary `picture_enhancement` job.

**`media_enhancement_batches`** (migration `20260813000000_add_media_enhancement_batches`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `circle_id` | uuid FK → `circles` | cascade delete |
| `requested_count` | int | how many ids the caller asked to enhance (post-dedup) |
| `queued_count` | int, default 0 | how many `media_enhancements` rows were actually created; `requested_count` minus every reason in `skipped` |
| `skipped` | jsonb | `{ notPhoto, tooLarge, alreadyLive }` — every requested id lands in exactly one of these three buckets or in `queued_count`, so the four numbers always sum to `requested_count` |
| `params` | jsonb | the one enhance-params object applied to every item in the batch (plus, for a by-filter batch, a reserved `_filter` key snapshotting the resolved filter — provenance only, never merged into the per-item prompt) |
| `source` | text, default `'selection'` | `'selection'` (gallery multi-select) \| `'filter'` (resolved server-side from a media filter) |
| `cancelled_at` | timestamptz? | set by `POST /api/enhancement-batches/:id/cancel` |
| `last_error` | text? | reserved; not currently written by any code path |
| `created_by_id` | uuid FK → `users` (SetNull) | |
| `created_at` / `updated_at` | timestamptz | |

Index: `@@index([circleId, createdAt])` (serves the paginated batch list, newest first).

**`media_enhancements.batch_id`** — nullable FK → `media_enhancement_batches`, **`onDelete: SetNull`**. A single-item `POST /api/media/:id/enhance` request still leaves this null; only a batch-created row sets it. `SetNull` (never `Cascade`) is deliberate: deleting a batch record must never delete the enhancements it produced, some of which may already be `applied` — the same precautionary FK shape as `resultMediaItemId`. Index `@@index([batchId])` serves both the batch-detail tally (below) and the hub's `?batchId=` filter (§8.9).

**`MediaEnhancementStatus.cancelled`** — added in its own migration (`20260813010000_add_media_enhancement_cancelled_status`; `ALTER TYPE ... ADD VALUE` cannot share a transaction with statements referencing the new value, the same precedent as the `system` tag-source value and the `memories_ready` notification type). Means the row was withdrawn or superseded **before any render ever ran** — deliberately distinct from `discarded`, which means a human reviewed a *completed* `ready` result and said no. Conflating the two would corrupt both the hub's status filters and the batch's derived counters below.

**Progress is derived, never stored.** A batch carries no counter columns beyond `queued_count` (fixed at creation) and no finalize job. `MediaEnhancementService.serializeBatch` computes everything else from **one `groupBy(['batchId','status'])` over `media_enhancements`**, mirrored across `listBatches`/`getBatch`/`cancelBatch`:

- `succeededCount` = `ready + applied + discarded + expired` — all four mean the render completed; what a human later did with the result (or that the retention purge later reaped it) is a separate axis from whether the batch's *work* succeeded.
- `skippedCount` = `cancelled` — the only way a row reaches `cancelled` is a batch cancel withdrawing it before it rendered.
- `status` is derived as `cancelled` (batch has `cancelledAt`) → `completed_with_errors` (no rows remain `pending`/`processing`, and at least one `failed`) → `completed` (no rows remain `pending`/`processing`, none failed) → else `running`.

**Status is keyed on "no rows remain `pending`/`processing`", NEVER on `processedCount === matchedCount`.** `MediaEnhancement.mediaItemId` is `onDelete: Cascade`, so hard-deleting a photo mid-batch removes its enhancement row and *shrinks* the work set — a counter-equality check would leave that batch `running` forever, the exact failure mode the `review_runs` schema comments warn about for the same reason. A batch with zero eligible items (everything in the selection was skipped) is therefore terminal — `completed` — the instant it is created, never a stuck `running`.

**The batch detail payload is deliberately shaped like `BaseRun`** (`{ id, circleId, status, matchedCount, processedCount, succeededCount, failedCount, skippedCount, startedById, createdAt, updatedAt, startedAt, finishedAt, lastError }`, plus the batch-only `requestedCount`/`queuedCount`/`skipped`/`params`/`source`/`cancelledAt`) — the same field set `TrashEmptyRunService.serializeRun` and the review-run/workflow-run serializers emit — so the web `RunProgressPanel` + `useRunPolling` drive it with zero new component. `startedAt` is the batch's own `createdAt` (batch creation is synchronous — there is no separate evaluating phase); `finishedAt` is the newest `updatedAt` across the batch's rows once terminal, else null.

**Cancel is cooperative, not an abort.** `POST /api/enhancement-batches/:id/cancel` only ever touches rows still at `pending`: it deletes their queued `picture_enhancement` job rows (matched precisely by the enhancement id in the job's `payload`, never by `mediaItemId`) and flips the enhancement rows to `cancelled`. A row already `processing` is deliberately left to finish — its `gpt-image-1` call is already billed, so aborting it would spend the money and throw away the result rather than save anything. `PictureEnhancementHandler` carries a second gate for the race where a job was claimed by a worker in the instant before the cancel landed: it re-checks the parent batch's `cancelledAt` and, if set, marks that one row `cancelled` and skips the render instead of proceeding.

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
| `pictureEnhancement.blockReplaceOnDownscale` | boolean | — | `false` | If `true`, replacing when enhanced dims < original requires an explicit `acknowledgeDownscale` confirmation — a speed bump, **not** a wall (§8.4, issue #426). Effectively an always-on prompt rather than a rare edge case: `gpt-image-1` caps output at ~1.6 MP, so any photo above that is downscaled. `allowReplace` is the setting that forbids replacing outright. |
| `pictureEnhancement.maxInputMegapixels` | number | 1–100 | `50` | Skip/guard absurdly large inputs. |
| `pictureEnhancement.retentionHours` | int | 1–720 | `168` | How long unapplied staging previews live before the purge cron reaps them. Raised from `72` in issue #201: the Enhancements hub (§9.7) is an inbox users work through over time, not a use-immediately dialog, and the shorter window was reaping unreviewed staged enhancements — each one a spent, paid `gpt-image-1` call — before a user got around to them. |
| `pictureEnhancement.maxBatchSize` | int | 1–200 | `25` | Epic #420. The AUTHORITATIVE cap on how many photos one bulk-enhance request (§6.6/§8.10-§8.11) may queue — enforced server-side in `MediaEnhancementService.startBatch`/`startBatchByFilter`; the DTOs' own array-length limits are schema backstops only, not the real cap an admin who lowers this setting can rely on. Also surfaced on `GET /api/features` (§8.8) so a non-admin client can label/cap its selection UI without an Admin-only settings read. Present in all four hand-maintained settings copies (`systemSettingsSchema`, `systemSettingsPatchSchema`, the wire `patchSystemSettingsSchema`, and `SystemSettingsService.patchSettings`'s hand-written merge) — see the "Three hand-maintained copies" gotcha in `CLAUDE.md`. |

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
- **Request body:** `{ decision: 'keep_both' | 'replace', acknowledgeDownscale?: boolean }`.
- **`keep_both`:** promotes staging bytes into a new `MediaItem` (metadata copy §5.2 + marker §5.3/§5.4), enqueues upload enrichment, sets `result_media_item_id`, row → `applied`. Response `201` with the new item id.
- **`replace`:** overwrites the original storage key, nulls `contentHash`, updates dims/size, `reprocessObjectNow`, **awaits `syncFromStorageObject` then prunes the superseded thumbnail** (§3.1), re-enqueues face detection (best-effort), marks AI-enhanced, deletes staging, row → `applied`. Response `200` `{ data: { status: 'ready'|'failed', width, height } }` (mirrors orientation edit's return). `400` if `allowReplace=false` or blocked by downscale policy.
- **The two replace policies are different KINDS of rule (issue #426).** `allowReplace: false` is a **hard** block — nothing overrides it. `blockReplaceOnDownscale` is a **confirm-through** guard that `acknowledgeDownscale: true` passes. That asymmetry is deliberate and load-bearing: `gpt-image-1` hard-caps its output at `1024×1024`/`1024×1536`/`1536×1024` (≈1.0–1.6 MP), so `downscaled` is true for essentially *every* photo in a real library, and an absolute guard turned a documented narrow safety net into a permanent kill switch for replace. Replacing a 12 MP original with a 1.5 MP restored scan is a legitimate informed choice, and it must remain makeable.
- `acknowledgeDownscale` only ever matters for a result that IS downscaled — it is not a blanket skip-the-guard switch, and it has no effect on `allowReplace: false`. Clients send it exclusively from behind an escalated confirmation naming the exact resolution loss and the in-place, no-version-history overwrite (§9.3/§9.7).
- Writes an `audit_events` row (`media_enhancement:applied`) carrying `downscaled` and `downscaleAcknowledged`, so an informed override is distinguishable after the fact from an ordinary replace.

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
      "model": "gpt-image-1",
      "maxBatchSize": 25
    }
  }
  ```
- `features` is the raw global feature-flag record (all boolean `features.*` settings) — no other settings namespace is exposed. `pictureEnhancement.enabled` folds in the `PICTURE_ENHANCEMENT_ENABLED` env kill-switch server-side via the shared `isPictureEnhancementEnabled()` helper, the same one `MediaEnhancementService`'s server-side gates use — so the client gate and the API gate cannot drift. `pictureEnhancement.model` surfaces only the configured model **name**, never a credential.
- Backed by `SystemSettingsService.getPublicFeatures()`, which reads through the same cached `getSettings()` (5 s TTL) as every other settings caller — no extra DB read path.
- **Web usage:** `useFeatureFlags()` (`apps/web/src/hooks/useFeatureFlags.ts`) wraps this with a module-level, 60 s-TTL in-flight-promise cache, so concurrent `MediaGallery` + `MediaLightbox` mounts share one request instead of each firing their own; failures are never cached (a fetch outage can only hide a gated affordance, never break the surface hosting it). `maxBatchSize` (epic #420) is read by `BulkActionToolbar` to disable/label the multi-photo AI Enhance trigger before the request is even sent (§9.1).

### 8.9 `GET /api/media/enhancements` *(the Enhancements hub, issue #201)*
Cross-item, paginated listing of every AI picture enhancement in a circle — the first cross-item enhancement listing in the codebase (every endpoint above is scoped to one `:id`). Backs the `/enhancements` hub's Pending review tab (§9.7).
- **Auth:** `media:read` + per-circle `viewer`. Declared in `MediaEnhancementController`'s static-routes block, ahead of any `:id` route, so the literal `enhancements` path segment is never captured as an `:id` param (same convention as `media.controller.ts`).
- **Query params:** `circleId` (required, uuid). `status` (optional) — a concrete `MediaEnhancementStatus` (`pending`\|`processing`\|`ready`\|`failed`\|`applied`\|`discarded`\|`expired`) **or** one of three convenience aliases (`ENHANCEMENT_STATUS_ALIASES`) the hub UI actually thinks in: `in_progress` → [`pending`, `processing`], `awaiting_decision` → [`ready`], `terminal` → [`applied`, `discarded`, `expired`]. `batchId` (optional, uuid; epic #420) — narrow to one bulk-enhance batch (§6.6/§8.10-§8.14), served by `@@index([batchId])`; composes with `status`. `page` (default `1`), `pageSize` (default `24`, max `50`), `sortBy` (`createdAt`\|`updatedAt`, default `createdAt`), `sortOrder` (`asc`\|`desc`, default `desc`).
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

### 8.10 `POST /api/media/bulk/enhance` *(bulk enhance a selection, epic #420 issue #421)*
Queue an enhancement per eligible item in an explicit id list. See §6.6 for the full batch model.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Request body:** `{ circleId, ids: uuid[] (1–200), params? }`. `ids` is deduplicated before counting against the cap, so pasting the same id twice never costs part of the budget. One `params` object (the §4.1 shape) applies to every item in the batch.
- **Behavior:** authorizes the whole batch in ONE pass (never per item), then partitions `ids` — precedence `notPhoto → tooLarge → alreadyLive`, so the four counts always sum to `requested` — and creates one `MediaEnhancementBatch` row plus one `MediaEnhancement`/`picture_enhancement` job pair per eligible item. **Four deliberate divergences from `POST /api/media/:id/enhance`** (each is what makes the bulk path safe, not an oversight to "fix" back toward parity): (1) an item with a live `pending`/`processing`/`ready` enhancement is **skipped and counted** in `skipped.alreadyLive`, never superseded — the single-item endpoint's `supersedeLive()` would otherwise silently destroy an already-billed, unreviewed `ready` result; (2) a non-photo or over-`maxInputMegapixels` item is **skipped and counted**, never a 400 — one video in a mixed selection must not fail the whole batch; (3) jobs are enqueued at **priority 50**, not 0 — below upload enrichment (5/10) and workflow evaluate (20) so a large batch never starves a live import, above the purge jobs (100) so it still drains promptly; (4) jobs are enqueued with **`skipDedup: true`**, safe here specifically because divergence (1) guarantees at most one live enhancement — and therefore at most one in-flight job — per item.
- **Response `202`:** `{ data: { batchId, requested, queued, skipped: { notPhoto, tooLarge, alreadyLive } } }`. The batch row is created even when `queued` is 0, so the caller always has a pollable id explaining why nothing ran.
- **Response `400`:** feature disabled / no `ai.features.enhance` configured / deduplicated selection exceeds `pictureEnhancement.maxBatchSize`.
- **Response `403`:** caller is not a collaborator of the circle. **Response `404`:** one or more ids are not live (non-deleted) items of the circle.

### 8.11 `POST /api/media/bulk/enhance/by-filter` *(bulk enhance a filter, epic #420 issue #424)*
Resolve a media filter to a photo id list server-side, then run the identical batch machinery as §8.10 over it — same response shape, same skip partition, same priority/dedup behavior; only "which items" differs.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Request body:** `{ circleId, params?, ...mediaFilterFields }` — the same filter shape `GET /api/media` and the album by-filter endpoint accept (boolean-ish fields arrive as the query-string-style strings `'true'`/`'false'`, matching `AddAlbumItemsByFilterDto`'s existing quirk, deliberately not "fixed" here so one filter object stays reusable across endpoints).
- **Behavior — three rules in the resolving `where`, all load-bearing because every match costs a real, billed `gpt-image-1` call:** (1) `deletedAt: null` and `archivedAt: null` are asserted explicitly in SQL, never left to a filter flag's incidental behavior — a by-filter enhance must not silently reach into Trash or Archive; (2) `type: photo` lives in the SQL too, so the count checked against the cap is the count that actually runs; (3) the media-filter fragment and the people-filter fragment are **AND-nested**, never spread-merged, because either can emit a top-level `OR`/`AND` and a spread would let one clobber the other (open issue #431 tracks the same defect elsewhere in the codebase — `listMedia`/`addAlbumItemsByFilter` — this endpoint was written to not repeat it). A `type: 'video'` filter is not silently overridden to `photo`; it AND-composes to zero matches and gets the honest 400 below.
- **Refuses loudly rather than truncating.** A filter matching more than `pictureEnhancement.maxBatchSize` photos is a 400 naming BOTH numbers under `details: { matchedCount, maxBatchSize }` (per the `HttpExceptionFilter` allowlist gotcha in `CLAUDE.md` — a top-level custom field would silently vanish on the wire) — never silently enhancing the first N by an ordering the caller can't see. A filter matching zero photos is likewise a 400.
- **Response `202`:** same shape as §8.10, plus the resolved filter snapshotted on the batch's `params._filter` for provenance (never merged into the per-item prompt).
- **Response `400`:** feature disabled / no model configured / zero matches / match count exceeds `maxBatchSize` (with `details.matchedCount`/`details.maxBatchSize`). **Response `403`:** caller is not a collaborator of the circle.

### 8.12 `GET /api/enhancement-batches` *(list batches, epic #420 issue #421)*
Paginated, newest-first list of a circle's bulk-enhance batches.
- **Auth:** `media:read` + per-circle `viewer`.
- **Query params:** `circleId` (required, uuid), `page` (default 1), `pageSize` (default 20, max 50).
- **Response `200`:** `{ items: [...BaseRun-shaped batch, see §6.6...], meta: { page, pageSize, totalItems, totalPages } }`. Every counter on every item is derived live from one `groupBy` per page — never one query per batch.

### 8.13 `GET /api/enhancement-batches/:id` *(batch detail / progress poll, epic #420 issue #421)*
Single-batch progress payload, `BaseRun`-shaped per §6.6, for `useRunPolling` to drive.
- **Auth:** `media:read` + per-circle `viewer`.
- **Response `200`:** `{ id, circleId, status, matchedCount, processedCount, succeededCount, failedCount, skippedCount, startedById, createdAt, updatedAt, startedAt, finishedAt, lastError, requestedCount, queuedCount, skipped, params, source, cancelledAt }`.
- **Response `403`:** caller is not a viewer of the circle. **Response `404`:** batch not found.

### 8.14 `POST /api/enhancement-batches/:id/cancel` *(cooperative cancel, epic #420 issue #421)*
Withdraw every enhancement still queued in a non-terminal batch. See §6.6 for the full cooperative-cancel/second-gate semantics.
- **Auth:** `media:write` + per-circle `collaborator`.
- **Behavior:** stamps `cancelledAt`; deletes the still-`pending` rows' queued `picture_enhancement` job rows; marks those rows `cancelled`. A `processing` row is deliberately left to finish — its model call is already billed, so aborting spends the money and discards the result anyway.
- **Response `200`:** `{ batchId, status: 'cancelled', cancelled: number }` — `cancelled` is how many pending enhancements were withdrawn.
- **Response `400`:** batch already finished (already cancelled, or every row already terminal). **Response `403`:** caller is not a collaborator of the circle. **Response `404`:** batch not found.

---

## 9. Frontend / UI

Precedents identified in the codebase are reused directly.

### 9.1 Trigger — selection top bar (primary; widened to multi-photo in epic #420)
`components/media/BulkActionToolbar.tsx` renders the selection bar. It receives selected **item objects** (not just ids), so it can tell photo from video and count both. The trigger now branches on selection size: **exactly one photo** opens the original single-item `MediaEnhancementDrawer` (§9.3) unchanged; **more than one photo** (`isBatchEnhance`) opens `BatchEnhanceDialog` (§9.3.1) instead. The button label reflects which mode applies — `"AI Enhance"` for a single photo, `"AI Enhance N photos"` for a batch — and when the batch photo count exceeds `useFeatureFlags().pictureEnhancement.maxBatchSize` (§8.8), the tooltip appends the limit (`"AI Enhance N photos (limit 25 per batch)"`) so the cap is visible before the request is ever sent, not discovered as a 400. Both modes are gated on the same `useFeatureFlags().pictureEnhancement?.enabled` (§8.8/§9.5) — **not** `useSystemSettings()` — since the latter 403s for non-admin circle members and previously hid the trigger from exactly the people meant to use it.

### 9.2 Trigger — full-screen viewer (secondary, mirrors orientation edit)
`components/media/MediaLightbox.tsx` has a **photo-only** "Edit orientation" `IconButton` that opens a right `Drawer`. An adjacent "AI Enhance" button opens the enhancement drawer, gated on the same `useFeatureFlags()` source as §9.1. `refreshFullItem()` is the hook called after a "replace" outcome to bust the cache and reload the image.

### 9.3 The enhance + compare + decide drawer
`MediaEnhancementDrawer.tsx`, a right `Drawer` (`zIndex` above the lightbox) rebuilt around three upgrades to the params/progress/compare flow:

1. **Params step — presets.** Opens with a preset picker (`PRESETS` in the drawer, mirroring the API's four presets §4.1: Auto, Restore old photo, Low-light rescue, Colorize B&W, Portrait polish, Custom) that pre-fills the existing adjustment toggles/strength/instructions while leaving them fully editable — selecting a preset is not a one-way door. The Colorize B&W card is labelled **"interpretive"**, and the panel repeats the warning once selected ("Colorizing is interpretive: the colors are the AI's best guess…") — invented color must never read as recovered fact in a family-history archive. Opening the "Customize" expander only sends `intent: 'custom'` if the user actually changed a toggle (previously it sent `custom` unconditionally just from being opened, silently swapping the prompt's base sentence even when nothing was customized). Model shown from `ai.features.enhance` via the drawer's `modelLabel` prop (wired for the first time in this pass — the prop existed earlier but no render site ever passed it, so the model line never appeared in production).
2. **Progress step — queued vs. enhancing, with elapsed time.** `useMediaEnhance` (`hooks/useMediaEnhance.ts`) now tracks `startedAt` and distinguishes the queued state from the actively-enhancing state, with elapsed time and rotating status lines, plus an explicit "close this panel — you'll be notified when it's ready" affordance, since a real `images.edit` call runs 10–60 s behind the enrichment queue. Two bugs fixed in the same pass: a rejected start (e.g. a 400) used to set status back to `idle` while the error alert only rendered on `failed`, so a failed start looked like a dead button with no feedback; and a poll timeout left `status` untouched, so the spinner ran forever and its error was unreachable — both paths now resolve to a terminal `failed` status so the error renders and the spinner stops.
3. **Compare step — before/after slider.** The two static ~200px side-by-side panes are replaced by `BeforeAfterSlider.tsx`, a draggable before/after comparison with a side-by-side toggle (for judging global color shift) and full-screen zoom (for inspecting faces/detail before committing) — plus the metadata delta row (dimensions/size, downscale warning when enhanced < original) and the decision bar: **Keep both** / **Replace** / **Discard**, each behind a confirm `Dialog` describing the outcome. **Replace is now gated client-side** on the admin's replace policy (threaded through the drawer's `replacePolicy` prop, sourced from `GET /api/features`, §8.8): hidden entirely when `allowReplace: false`, and — when `blockReplaceOnDownscale` is on and the result is downscaled — kept usable but routed through an escalated confirmation that names the exact resolution loss (`3168×3928 (12.4 MP) → 1024×1536 (1.6 MP)`) and sends `acknowledgeDownscale` (§8.4) — previously the user could confirm the destructive action and only then hit a 400.

   **The reason a replace is constrained is ALWAYS rendered as text, never a hover-only tooltip (issue #426).** It previously lived only in a MUI `Tooltip` wrapped around a `disabled` `Button`: a disabled button fires no pointer events and the wrapping `<span>` is neither focusable nor clickable, so on a phone or tablet the control was simply inert and silent, with no reason discoverable anywhere. Both surfaces now render the shared `ReplaceDownscaleNotice` (`apps/web/src/components/media/ReplaceDownscaleNotice.tsx`) unconditionally, and it additionally offers a link to `/admin/settings/enhancer` for a caller holding `system_settings:write` — the block is admin policy rather than a property of the photo, and an Admin who could fix it in one click previously had no way to learn that from here. Do not regress this back into a tooltip.

### 9.3.1 The batch submit dialog and progress page (epic #420, issues #421-#423)

`BatchEnhanceDialog.tsx` is the multi-photo counterpart to `MediaEnhancementDrawer` (§9.3) — same preset picker and adjustment toggles (lifted into a shared `enhancePresets` module so the two surfaces cannot drift), but it only ever *starts* a batch; it has no compare/decide step of its own; that still happens per-item, later, in the hub (§9.7). Submitting calls `POST /api/media/bulk/enhance` (§8.10) and, on success, shows a toast linking straight to the new batch's progress page rather than leaving the user to go find it.

`/enhancement-batches/:id` (`EnhancementBatchPage.tsx`) is the batch's live progress view, built by composing the shared `RunProgressPanel` + `useRunPolling` over the `BaseRun`-shaped payload from §8.13/§6.6 — the same reuse `TrashEmptyRunPage` and the review-run pages already established, so this page adds no new progress-rendering logic of its own. Two labels are deliberately overridden from `RunProgressPanel`'s generic defaults, because the generic wording would be actively wrong on this one surface:
- **"Ready to review"**, not "Succeeded" — for every other run in the app, succeeded means done; here it means the render finished and the photo is now waiting on the human, so calling it "succeeded" would announce the work is over exactly when it starts needing a decision.
- **"Cancel remaining"**, not "Cancel run" — the button (and adjacent body copy) is explicit that cancelling withdraws photos still queued, while anything already processing finishes because its model call is already billed (§6.6); the label must never promise more than the endpoint does.

A **"Review N results →"** button becomes enabled the moment `succeededCount > 0` — a 200-photo batch should not hold its first finished result hostage until the two-hundredth completes — and links to `/enhancements?batchId=<id>` (the hub's new `batchId` filter, §8.9/§9.7). A failed-photos table (built from `GET /api/media/enhancements?batchId=&status=failed`, since there is no separate `/enhancement-batches/:id/items` endpoint — a batch's items ARE enhancement rows) appears once `failedCount > 0`.

A **"Recent batches" card** (`RecentBatchesCard.tsx`) surfaces on the `/enhancements` hub, backed by `GET /api/enhancement-batches` (§8.12), so a user who submitted a batch and navigated away has a way back to it without knowing the batch id.

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

Since epic #420, the Pending review tab also accepts a `?batchId=` URL param (§8.9/§9.3.1) narrowing the list to one bulk-enhance batch's rows — how the batch progress page's "Review N results" button and a `RecentBatchesCard` (§9.3.1) hand a user back into the hub already filtered to their submission — and a "Recent batches" card (§9.3.1) surfaces above the tabs.

1. **Pending review — live in PR1** (`PendingEnhancementsTab.tsx`). A status/sort-filterable list, backed by `GET /api/media/enhancements` (§8.9), of everything sent through the enhancer that is still queued, running, awaiting a decision, or failed. Each card shows: a queued/enhancing/ready/failed chip with elapsed time while in flight; a "Lower resolution" badge when `downscaled`; an expiry countdown driven **entirely** by the server's `expiresAt` (§8.9 point 2) — the client never derives it from its own copy of `pictureEnhancement.retentionHours`, since the setting can change after a row was created and only the server's resolved deadline is authoritative. Countdown severity: `info` normally, `warning` under 24h remaining, `error` under 6h remaining. Per-card actions on a `ready` row: **Review** (reopens `MediaEnhancementDrawer` on that specific enhancement, §9.3/below), **Keep both**, and **Discard**; **Replace** follows the same admin replace-policy gating the drawer applies (`allowReplace`/`blockReplaceOnDownscale` from `GET /api/features`, §8.8), including the always-rendered `ReplaceDownscaleNotice` and the `acknowledgeDownscale` confirmation described in §9.3. Multi-select and bulk actions are deliberately absent — see §15.
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
| `POST /api/media/bulk/enhance[/by-filter]` | `media:write` | `collaborator` | §8.10/§8.11; batch cap enforced from `pictureEnhancement.maxBatchSize`, not a new permission |
| `GET /api/enhancement-batches[/:id]` | `media:read` | `viewer` | §8.12/§8.13 |
| `POST /api/enhancement-batches/:id/cancel` | `media:write` | `collaborator` | §8.14 |

No new permission scopes — epic #420's five new endpoints reuse the same `media:read`/`media:write` + per-circle roles as every other endpoint above; a batch is a grouping over enhancements the caller could already act on individually. Super-admin bypass (`media:write_any`) applies as elsewhere.

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

- **Cost.** `gpt-image-1` image generation is **billed per image and is materially more expensive than a text/vision call.** Every enhancement — single-item or one of up to `pictureEnhancement.maxBatchSize` in a bulk-enhance batch (§6.6) — is an explicit, on-demand user action; there is still no upload-time auto-enhance, so spend never happens without a human asking for it. Surface a subtle "uses AI credits" note in the UI.
- **Bulk enhance shifts the bottleneck from submitting to reviewing, not away from it.** Queuing 25 photos in one request (epic #420) is one click; deciding keep-both/replace/discard on the 25 results that come back is still 25 individual decisions — there is no multi-select review (§15). Combined with `pictureEnhancement.retentionHours` (default 168h), an unreviewed batch's results are staged, already-billed `gpt-image-1` output on a clock: anything left un-decided past the retention window is silently reaped by `PictureEnhancementPurgeTask` (§6.4), so a large batch a user does not work through in time quietly discards money already spent.
- **Fidelity risk.** Generative editing can alter faces/text/detail (§2). Mitigated by `input_fidelity: 'high'`, the constraint-heavy prompt, `preserveFaces` default, and the mandatory review gate. **Never auto-applied.**
- **Resolution loss.** Enhanced output is often lower-res than the original; the compare UI must make this obvious and replace must warn (§2 / §7 policy).
- **EXIF portability.** Shipped: the file-level marker (§5.1/§5.4) is applied via `ExifCarryoverService`, but strictly best-effort — a missing `exiftool-vendored`/`perl` install, an unwritable tmpdir, or corrupt input silently falls back to unstamped bytes with only a logged warning (no Doctor visibility yet, §11). In that fallback case only the in-app marker (§5.3) is authoritative.
- **Rate limits.** Handled by the queue's existing 429/529 deferral + backoff; `OpenAiProvider.enhanceImage` now preserves the provider's HTTP status onto the rethrown error so a real 429/529 is correctly classified and deferred (see [Implementation status (v1)](#implementation-status-v1)).
- **Idempotency / supersession.** One live enhancement per item; re-requesting supersedes and reaps the prior staging.

---

## 13. Testing Notes

**Backend (Jest + Supertest):**
- `picture-enhancement.handler.spec.ts` — mock the OpenAI `images.edit` client; assert staging upload, dims/size recorded from the actual returned bytes (§4.2/§6.1), `ready`/`failed`/`pending` (retry) transitions, retry-vs-rate-limit-deferral routing per the state machine in [Implementation status (v1)](#implementation-status-v1).
- `media-enhancement.controller.spec.ts` — photo-only 400, feature-flag 400, RBAC (viewer can GET, non-collaborator cannot apply), supersession, apply(keep_both) creates item + copies metadata + marker, apply(replace) overwrites/reprocesses/nulls-hash/re-enqueues faces, discard deletes staging.
- Metadata copy unit test — assert `capturedAt`/camera/geo columns carried and source `metadata` merged under the breadcrumb via `inheritableMetadata()` (§5.2); contentHash rotation + `P2002` fallback path.
- `exif-carryover.service.spec.ts` — assert the built `writeArgs` vector (tag groups, override ordering, the `Orientation#=1` PrintConv-bypass, dropped thumbnail/preview tags, AI marker tags per §5.1); best-effort fallback returns the input buffer unchanged on a simulated ExifTool failure.
- `openai.provider.spec.ts` — assert `rethrowWithProviderStatus` preserves `status`/`code`/`retry-after` on a simulated 429/529 SDK error, and that 401/404 keep their friendly messages.
- Retention sweep test — `expired` transition + staging deletion.
- `media-enhancement.service.spec.ts` (batch coverage, epic #420) — dedup + cap enforcement on both `startBatch` and `startBatchByFilter` (naming both `matchedCount`/`maxBatchSize` under `details`, asserted through the real `HttpExceptionFilter`, not just `getResponse()`); the `notPhoto`/`tooLarge`/`alreadyLive` partition and that a live `ready` row is skipped, never superseded; `serializeBatch`'s derived-status rules including the zero-eligible-items terminal case; `cancelBatch`'s pending-only scope and its 400 on an already-terminal batch.
- `enhancement-batches.controller.spec.ts` — RBAC (viewer can list/get, non-collaborator cannot cancel), 404 for an unknown/foreign-circle batch id.
- `picture-enhancement.handler.spec.ts`'s batch-cancellation gate — a job claimed in the race window before a cancel lands still resolves cleanly to a `cancelled` row instead of rendering.

**Frontend (RTL):**
- Enhance icon visibility: only `count===1 && photo && featureOn`, sourced from `useFeatureFlags()` (§8.8/§9.1), not `useSystemSettings()`.
- Drawer flow: preset selection pre-fills toggles → progress (queued vs. enhancing, elapsed time) → compare (before/after slider) → confirm dialogs; downscale warning renders; replace hidden/disabled per `replacePolicy`; replace calls `refreshFullItem`.
- `EnhancerSettingsPage.spec.tsx` — master toggle, readiness panel states, param save/validation (§9.6).

**Manual (`/verify`):** enable feature + configure OpenAI model → enhance a dim indoor photo → review → keep both (new item appears, original intact) → enhance another → replace (thumbnail regenerates, badge appears, EXIF marker present) → discard a third (staging gone).

---

## 14. Open Decisions Summary

Collected here for the review pass — each is flagged **⟐** in context above. Seven of eight are resolved for v1.1, as shipped; #6 remains genuinely open:

1. **Downscale policy on replace** (§2): **resolved as warn-and-allow, and — after issue #426 — confirm-through even when an admin opts in.** `pictureEnhancement.blockReplaceOnDownscale` defaults to `false`; the UI shows the downscale warning but replace is not blocked. Turning it on no longer forbids replace, it requires an explicit `acknowledgeDownscale` confirmation (§8.4): because the model caps output at ~1.6 MP, an absolute guard blocked replace for every photo forever rather than acting as the narrow safety net it reads as. `allowReplace: false` remains the hard, un-overridable block.
2. **Auto-straighten** (§2): **resolved as an optional prompt toggle, off by default** — `adjustments.straighten` (§4.1) ships as a request param, default `false`.
3. **contentHash rotation on replace** (§3): **resolved as null-and-recompute** — `replace` nulls `MediaItem.contentHash` before `reprocessObjectNow`, matching the P2002-fallback handling already in `media-metadata-sync.service.ts`.
4. **Two-tier analyze-then-edit** (§4.3): **resolved as single-call v1** — `picture_enhancement` makes exactly one `images.edit` call per enhancement; no `pictureEnhancement.analyzeFirst` flag exists. Remains genuinely absent and future work.
5. **EXIF writer** (§5.1): **resolved as (A) — file-level carryover shipped, in the follow-up pass.** `exiftool-vendored` was added to `apps/api` (with `perl` in the Dockerfile base stage); `ExifCarryoverService` copies the original's EXIF/GPS/IPTC/XMP/ICC onto the enhanced file and stamps an AI marker; `pictureEnhancement.stampExif` now defaults to `true`. Originally resolved as (C) (in-app marker only) in the first pass — see [Implementation status (v1)](#implementation-status-v1).
6. **First-class `aiEnhancedAt` column** (§5.3): **leaning resolved in favor of NOT adding it** — the tag-based approach (`metadata._aiEnhanced` breadcrumb + the "AI Enhanced" system tag) is the direction issue #201 continues to build on rather than introducing a new column: the "Enhanced photos" tab of the hub (§9.7) is planned as a gallery over the existing system tag, not a query against a new column. That gallery is **not** built yet — it's a PR3 placeholder in the shipped PR1 (§9.7) — so this decision is directional, not fully proven out in a shipping surface yet. Treat as "leaning resolved, implementation pending in PR3," not "done."
7. **One live enhancement per item** (§6.1): **resolved as supersede semantics** — a new `POST …/enhance` request discards any existing `pending`/`processing`/`ready` row's staging bytes for that item.
8. **`allowReplace` default** (§7): **resolved as `true`** — replace is allowed by default; admins can set `pictureEnhancement.allowReplace=false` to force keep-both-only.

---

## 15. Future Work

| Capability | Notes |
|-----------|-------|
| Bulk enhance **review** (multi-select decide) | **Not built.** Epic #420 (§6.6/§8.10-§8.14, §9.3.1) shipped bulk *start* — queuing up to `pictureEnhancement.maxBatchSize` enhancements from a selection or a filter in one request, with a shared batch progress page. What it deliberately did NOT build is multi-select review: the hub's Pending review tab (§9.7) is still single-item keep-both/replace/discard, so a 25-photo batch is still 25 individual decisions once the renders land. Any future work here is a hub UI change (bulk-select + a bulk keep-both/discard action over already-`ready` rows), not a backend one — the batch model, cap enforcement, and progress polling are already in place. |
| Two-tier analyze-then-edit | Vision-model diagnosis feeding the edit prompt for sharper targeting; `pictureEnhancement.analyzeFirst` flag (§4.3/§14 #4). |
| Additional providers | Registry supports it; e.g. a local ESRGAN/Real-ESRGAN upscaler or Stability edit endpoint for true enhancement/super-resolution. |
| C2PA content credentials | Cryptographic provenance marking (the industry standard for "AI-edited") instead of/alongside the EXIF marker (§5.1/§5.4 already ship an IPTC `DigitalSourceType` marker, but not full C2PA). |
| First-class `aiEnhancedAt` column | §5.3/§14 #6 — an indexed boolean/date column for an "AI Enhanced" search facet, in addition to the existing `metadata._aiEnhanced` breadcrumb + system tag. |
| Doctor ExifTool-availability check | §11 — Doctor has no visibility into `ExifCarryoverService`'s silent best-effort fallback (missing package/perl, unwritable tmpdir). |

**Shipped since the original draft** (moved out of this table): additional presets/styles beyond the original "Auto" (§4.1, four presets shipped) and a draggable before/after slider in the compare UI (§9.3, `BeforeAfterSlider.tsx`).

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | July 2026 | AI Assistant | Initial draft for review. |
| 1.0 | July 2026 | AI Assistant | Marked Implemented (v1); documented deviations from the draft (EXIF writer deferred to option C, `stampExif` default flipped to `false`, `enhanceImage` failures use normal retry not rate-limit deferral, Doctor check has no live `testModel` probe); resolved all eight §14 open decisions. |
| 1.1 | July 2026 | AI Assistant | Phase G follow-up (issue #98). Fixed the two root causes making the feature unreachable: `GET /api/features` (§8.8) least-privilege endpoint + `/admin/settings/enhancer` admin page (§9.6), since `features.pictureEnhancement` was the only one of eight feature flags with no UI toggle. EXIF writer SHIPPED (§5.1/§5.4, option A — `exiftool-vendored`, `stampExif` now defaults `true`), reversing v1.0's deferral; §14 #5 updated accordingly. Rate-limit classification FIXED (`OpenAiProvider.enhanceImage` preserves provider status; handler catch is now a retry/defer/fail state machine) — no longer a known limitation. Added enhancement presets + per-run `quality` override (§4.1). Fixed keep_both to inherit source item metadata via `inheritableMetadata()` (§5.2). Fixed enhanced dims to read from actual output bytes, not the requested canvas (§4.2/§6.1). Rebuilt the drawer around presets, queued-vs-enhancing progress with elapsed time, and a before/after slider with replace-policy gating (§9.3). §14 #6 (`aiEnhancedAt` column) and the two-tier `analyzeFirst` flag (§14 #4) remain genuinely unshipped. |
| 1.2 | July 2026 | AI Assistant | Issue #201 PR1, "the AI Enhancements hub" — the first cross-item surface for the feature. Added `GET /api/media/enhancements` (§8.9), a paginated cross-item enhancement listing with three status aliases, server-computed `expiresAt`, and staged-bytes-only-when-`ready` semantics. Added the `/enhancements` hub page (§9.7): Pending review tab live (list, expiry countdown, per-card review/keep-both/replace/discard), Enhanced photos and History tabs are PR3 placeholders. Added a sidebar "AI Enhancements" entry (Utilities section) carrying the app's first sidebar nav-badge (`NavItemDef.badgeCount`). Added `pendingEnhancements` to `GET /api/media/dashboard`, in the same commit as a fix for a pre-existing bug where `pendingBurstGroups`/`pendingDuplicateGroups`/`pendingLocationSuggestions` were returned top-level while the web client read them from `counts.*`, leaving three Home review-queue banners permanently dead. Raised `pictureEnhancement.retentionHours`'s default `72h → 168h` (7 days) — the hub is an inbox worked through over time, and 72h was reaping unreviewed, already-billed enhancements. `MediaEnhancementDrawer` gained an `enhancementId` prop to open directly on a named existing enhancement (what the hub's "Review" action uses). §14 #6 (`aiEnhancedAt` column) updated from "open" to "leaning resolved" (tag-based, no new column) since the tag-driven gallery it would back is still PR3, not shipped. §15's "Bulk enhancement" row updated from not-started to in-progress, landing in PR2 on the shared review-run engine. |
| 1.3 | August 2026 | AI Assistant | Issue #434 — "replace keeps showing the original photo's thumbnail". Added §3.1: thumbnail storage keys are now versioned and content-addressed (`thumbnails/<objectId>-<hash>.jpg`), so the correct-but-invisible thumbnail bytes `applyReplace` already regenerated no longer land at a URL the browser, CDN and API signed-URL cache were all told was `immutable` for a year. `applyReplace` now AWAITS `MediaMetadataSyncService.syncFromStorageObject` rather than racing the pipeline's fire-and-forget `emit()`, which both repoints the item at the new key and finally delivers the `contentHash` recompute the nulled column had always depended on (§3). The superseded thumbnail is pruned afterwards by the new `ThumbnailPruneService`, in that order. The orientation editor, the same destructive-overwrite shape and the precedent this path was cloned from, carried the identical defect and is fixed by the same change. |
| 1.4 | August 2026 | AI Assistant | Epic #420 (issues #421/#423/#424) — bulk enhance **start**, not review. Corrects §1/§12/§15, which previously said v1 had no bulk and that any future bulk work would land on the shared `review_runs` engine — it does not: added new §6.6 explaining why a batch is a grouping over ordinary `picture_enhancement` jobs rather than a second evaluate/execute-batch engine (the per-item async unit of work already exists). New `media_enhancement_batches` table (`circleId`, `requestedCount`, `queuedCount`, `skipped`, `params`, `source`, `cancelledAt`) and a nullable `media_enhancements.batchId` (`onDelete: SetNull`); new `MediaEnhancementStatus.cancelled` in its own migration, deliberately distinct from `discarded`. Five new endpoints (§8.10-§8.14): `POST /api/media/bulk/enhance`, `.../by-filter`, `GET /api/enhancement-batches[/:id]`, `POST .../cancel` — no new RBAC permission. New setting `pictureEnhancement.maxBatchSize` (default 25), surfaced on `GET /api/features`. Progress is derived (one `groupBy` per batch, no counter columns, no finalize job) and keyed on "no rows remain pending/processing" rather than counter equality, for the same cascade-delete reason `review_runs` documents. Cancel is cooperative — only queued (`pending`) rows are withdrawn; an already-billed `processing` row finishes. Web: a multi-photo AI Enhance trigger, `BatchEnhanceDialog`, an `/enhancement-batches/:id` progress page reusing `RunProgressPanel`, a `?batchId=` hub filter, and a Recent batches card. §15's "Bulk enhancement" row is corrected to describe what remains: bulk *review* (multi-select decide across a batch's finished results) is still not built. |

# AI Picture Enhancer — Feature Spec

| Field | Value |
|-------|-------|
| **Version** | 1.0 (Implemented) |
| **Last Updated** | July 2026 |
| **Status** | Implemented (v1) — see [Implementation status (v1)](#implementation-status-v1) below for scope shipped vs. deferred |
| **Owner** | oscar@marin.cr |
| **Scope** | Photos only. Single-item, human-reviewed, non-destructive by default. |

> This document was originally written to double as the body of a GitHub feature issue (#98) **and** as the eventual `docs/specs/` spec. Sections still marked **⟐ Decision for review** below are preserved for historical context; each is now resolved per the [Implementation status (v1)](#implementation-status-v1) note and the updated [§14 Open Decisions Summary](#14-open-decisions-summary).

### Implementation status (v1)

GitHub issue #98 shipped on this branch: DB migration, backend (endpoints, enrichment job handler, purge cron, OpenAI provider method), and frontend (gallery/lightbox triggers, compare-and-decide drawer, Admin AI settings). Key deviations from the original draft, resolved here so the rest of this document can be read as "what v1 actually does":

- **EXIF writer deferred.** §5.1 lists three options; v1 ships **option (C) — DB/tag marker only, no file-level EXIF**. The `exiftool-vendored` writer (option A) was **not** added to `apps/api` in this pass. Enhanced bytes carry the in-app marker (`metadata._aiEnhanced` breadcrumb + "AI Enhanced" system tag, §5.3) but no `XMP-MemoriaHub:*`/`Software` tags in the file itself. Accordingly `pictureEnhancement.stampExif` **defaults to `false`** (not `true` as originally drafted in §7.1) — flip it on is a no-op today since there is no writer wired to honor it yet; it exists as a forward-compatible setting for when option (A) lands.
- **`enhanceImage()` failures use the normal retry path, not rate-limit deferral.** `OpenAiProvider.enhanceImage` (`apps/api/src/ai/providers/openai.provider.ts`) catches SDK errors and rethrows a generic `Error` (only 401/404 are special-cased into distinct messages) — the original HTTP status code is not preserved on the thrown error. As a result, an actual OpenAI 429/529 during `images.edit` does **not** get classified by `classifyRateLimit` and routes through the job's normal-failure retry/backoff instead of the rate-limit-deferral path used elsewhere in the enrichment queue. This is a known limitation, not a design choice — a fast follow would have `enhanceImage` preserve `status` on the thrown error the way other provider methods do.
- **§8.6 endpoints shipped as designed**: `PUT /api/ai/features/enhance` and `GET /api/ai/models?provider=openai&capability=image` (curated `['gpt-image-1']` list) both landed unchanged from the draft.
- Everything else in this document (data model, endpoints, RBAC, config keys, Doctor check, retention cron) matches what was built; see [§14](#14-open-decisions-summary) for the resolved-decisions summary.

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

- **Photo-only, single-item.** The trigger appears only when exactly one selected item is a photo (`MediaItem.type === photo` **and** `StorageObject.mimeType` starts with `image/`), matching the two-part guard already used by orientation edit (`media-orientation-edit.service.ts:96`).
- **Non-destructive by default, human-in-the-loop.** The AI output is never auto-applied. It lands in a **staging preview** that the user must explicitly accept (keep both / replace) or discard. This is a safety requirement, not a nicety — see §2.
- **Reuse the AI feature pattern.** Model selection via a new `ai.features.enhance` config (provider + model), configured in Admin Settings → AI exactly like search/tagging/embedding.
- **Reuse the enrichment queue.** Enhancement is a slow external call (10–60 s), so it runs as an async `picture_enhancement` enrichment job, polled by the UI — not a synchronous request like orientation edit.
- **Reuse the destructive-edit precedent for "replace".** The replace path clones `MediaOrientationEditService`'s structure: download → transform → overwrite same storage key → update columns → `reprocessObjectNow` → re-enqueue face detection.
- **Global feature toggle** (`features.pictureEnhancement`, default `false`) + env kill-switch (`PICTURE_ENHANCEMENT_ENABLED`, default `true`), consistent with face recognition, auto-tagging, burst/duplicate detection, location inference, social-media detection.
- **Portable + queryable AI-improved marking.** A DB/tag marker inside the app (searchable) **and** a best-effort EXIF/XMP stamp in the file bytes.

### Non-Goals (v1)

- **No bulk enhancement.** Single selection only. (Bulk is future work — the queue architecture supports it, but the review-gate UX does not scale cleanly yet.)
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
        quality, input_fidelity:'high', n:1)   ◄── the slow call
   6. receive enhanced bytes (PNG/JPEG)
   7. upload to STAGING key: enhancements/<enhancementId>/result.jpg
        (NOT the original key — original untouched)
   8. record enhanced width/height/size; status=ready
      (on error → status=failed, lastError; routed through normal
       retry/backoff + rate-limit deferral like every enrichment job)
        │
        ▼
UI polls GET /api/media/:id/enhance/:enhancementId  (2s interval)
        │  status=ready → { originalUrl, enhancedUrl, dims/size deltas }
        ▼
User reviews side-by-side, then ONE of:
        │
   ├─ POST …/apply { decision:'keep_both' }
   │     ► create NEW MediaItem in same circle from staging bytes
   │       copy metadata columns + EXIF stamp (§5), new contentHash,
   │       enqueue upload enrichment. Original untouched.
   │       staging object is promoted to the new item's StorageObject.
   │
   ├─ POST …/apply { decision:'replace' }   (destructive, like orientation edit)
   │     ► copy original EXIF onto enhanced bytes + stamp marker (§5)
   │       overwrite original storageKey with enhanced bytes
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
| `adjustments.color` | boolean | `true` | Correct white balance and color cast; natural, non-oversaturated color. |
| `adjustments.tone` | boolean | `true` | Balance exposure, recover shadows/highlights, improve contrast. |
| `adjustments.sharpness` | boolean | `true` | Increase clarity/acuity without haloing. |
| `adjustments.denoise` | boolean | `true` | Reduce luminance/color noise (esp. low-light). |
| `adjustments.dehaze` | boolean | `false` | Cut atmospheric haze / lift flat contrast. |
| `adjustments.straighten` | boolean | `false` | Correct a slightly crooked horizon (AI-driven; see §2 note 3). |
| `strength` | enum `subtle` \| `balanced` \| `strong` | `balanced` | How aggressive the corrections are; maps to prompt wording **and** to `input_fidelity` (subtle → highest fidelity, strong → more latitude). |
| `preserveFaces` | boolean | `true` | Hard prompt constraint: do not alter facial features, identities, skin tone, or count of people. Also raises effective fidelity. |
| `instructions` | string (≤ 500 chars) | — | Advanced free-text appended to the prompt (`intent=custom`). |
| `model` | string | server config | Optional per-call override of `ai.features.enhance.model`. Defaults to the admin-configured model. |

### 4.2 OpenAI call parameters (server-derived, not user-facing)

| `images.edit` param | Value |
|---------------------|-------|
| `model` | `ai.features.enhance.model` (e.g. `gpt-image-1`) |
| `image` | the auto-oriented original bytes |
| `prompt` | compiled from §4.1 (see template below) |
| `size` | closest supported aspect ratio to the original (`1024×1024` / `1024×1536` / `1536×1024`), chosen from original W:H |
| `quality` | `pictureEnhancement.defaultQuality` (default `high`) |
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

### 5.1 The EXIF-writing gap (important)

Neither `sharp` (as used today) nor any `apps/api` dependency can **write** EXIF into a buffer. `sharp` strips all EXIF on re-encode and its `withMetadata()` cannot add arbitrary/custom tags. The **only** EXIF writer in the repo is `apps/cli/src/date-inference/exif-writer.ts`, backed by **`exiftool-vendored`** — but that's an `optionalDependency` of `apps/cli` only, writes to a **file path** (not a buffer), and keeps a long-lived helper process.

**⟐ Decision for review — how do we stamp EXIF?**
- **(A) Add `exiftool-vendored` to `apps/api`** (recommended). Robust: copies *all* tags from the original and sets custom markers in one pass. Cost: a new native-ish dependency (bundles Perl + ExifTool), plus materializing bytes to a temp file (we already stream video to `os.tmpdir()` with a janitor, so temp-file discipline exists). Command shape:
  ```
  exiftool -TagsFromFile ORIGINAL.jpg -all:all --Orientation \
    -Software="MemoriaHub AI Enhancer" \
    -XMP-xmp:CreatorTool="MemoriaHub AI Enhancer (<model>)" \
    -XMP-MemoriaHub:AIEnhanced=True \
    -XMP-MemoriaHub:AIEnhancedModel=<model> \
    -XMP-MemoriaHub:AIEnhancedAt=<iso8601> \
    -Orientation=1 -overwrite_original ENHANCED.jpg
  ```
- **(B) `sharp(...).withMetadata()` only** — carries ICC profile + orientation + basic EXIF through, but *cannot* add the custom "AI enhanced" markers and won't reliably preserve GPS/maker notes. Cheaper, weaker guarantee.
- **(C) DB/tag marker only, no file EXIF** — simplest; the in-app marker (§5.3) is authoritative and file EXIF is left as future work.

*Recommendation: (A).* It's the only option that fully satisfies "copy all of the metadata from the original AND include something in EXIF to say it's AI improved." If we want to avoid the dependency for v1, ship (C) now and note (A) as the very next increment.

### 5.2 What "copy all metadata from the original" means

Regardless of file-EXIF choice, the **DB columns** are always preserved/copied so the app behaves correctly:
- **keep_both** (new MediaItem): copy `capturedAt`, `capturedAtOffset`, `cameraMake`, `cameraModel`, `orientation` (→ 1, bytes are upright), geo columns (`takenLat/Lng/Altitude`, `geoCountry…geocodedAt`, `coordSource`), `originalFilename` (suffixed, e.g. `IMG_1234 (enhanced).jpg`), and relevant `metadata` JSON. `width/height/size/contentHash` come from the enhanced bytes via reprocess. Album membership/tags are **not** copied (it's a distinct item); a breadcrumb `metadata._enhancedFrom = <originalId>` links them.
- **replace** (same MediaItem): columns already hold the original's metadata; only `width/height`, `StorageObject.size/mimeType`, and `contentHash` change. File-level EXIF is copied from the pre-overwrite original bytes (§5.1) then re-embedded.

### 5.3 In-app "AI improved" marker (always applied)

Because file EXIF isn't guaranteed portable across our own thumbnail re-encodes, the authoritative in-app marker is:
- **`MediaItem.metadata._aiEnhanced`** = `{ model, at, enhancementId, fromId? }` (JSON breadcrumb). *(No new column needed; reuses the existing `metadata Json?`.)* **⟐ Decision for review:** promote to a first-class boolean column `aiEnhancedAt DateTime?` if we want an index/filter — recommended if we add an "AI Enhanced" search facet.
- **A system tag "AI Enhanced"** applied via `MediaTagSource.system` (same mechanism social-media detection uses), so users can find enhanced photos via `?tag=AI+Enhanced` and it survives AI-tag reruns (system tags are protected).
- Surfaced as a small badge/chip in `MediaDetailDrawer` and on the gallery tile.

### 5.4 File-level EXIF marker (best-effort, per §5.1 decision)

If option (A): `Software`, `XMP-xmp:CreatorTool`, and a custom `XMP-MemoriaHub:*` namespace (`AIEnhanced`, `AIEnhancedModel`, `AIEnhancedAt`), with all original tags copied via `-TagsFromFile` and `Orientation` normalized to 1.

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
| `staging_provider` / `staging_bucket` | text? | where the preview lives |
| `original_width` / `original_height` | int? | snapshot for the compare UI |
| `enhanced_width` / `enhanced_height` | int? | AI output dims (drives downscale warning) |
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
| `pictureEnhancement.stampExif` | boolean | — | `false` | Whether to embed the file-level EXIF/XMP marker (§5.4). Requires the §5.1(A) writer, which is **not present in v1** — setting this `true` currently has no effect; see [Implementation status (v1)](#implementation-status-v1). |
| `pictureEnhancement.allowReplace` | boolean | — | `true` | If `false`, only "keep both" is offered (never overwrite originals). |
| `pictureEnhancement.blockReplaceOnDownscale` | boolean | — | `false` | If `true`, disable "replace" when enhanced dims < original (§2 note 2, decision c/b). |
| `pictureEnhancement.maxInputMegapixels` | number | 1–100 | `50` | Skip/guard absurdly large inputs. |
| `pictureEnhancement.retentionHours` | int | 1–720 | `72` | How long unapplied staging previews live before the purge cron reaps them. |

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
- **Request body:** the §4.1 params (all optional; empty body = full `auto` defaults).
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
- `GET /api/admin/ai/enhance/status` — `{ featureEnabled, provider, model, credentialConfigured, ready }` (`system_settings:read` or `ai_settings:read`, Admin). Backs the Doctor check (§11).

---

## 9. Frontend / UI

Precedents identified in the codebase are reused directly.

### 9.1 Trigger — selection top bar (primary)
`components/media/BulkActionToolbar.tsx` renders the selection bar. It currently only receives selected **ids**, not item objects, so it can't tell photo from video. Add a `singleSelectedItem?: MediaItem` prop computed in `MediaGallery.tsx` from `selected` + `mergedItems`, and render an **"AI Enhance" `IconButton`** (`AutoFixHigh` / `AutoAwesome`) in the right-cluster (~line 264), shown only when `count === 1 && singleSelectedItem?.type === 'photo'` and `features.pictureEnhancement` is on. Mirrors the existing `onOpenLocation`/`onOpenTags` callback wiring.

### 9.2 Trigger — full-screen viewer (secondary, mirrors orientation edit)
`components/media/MediaLightbox.tsx` already has a **photo-only** "Edit orientation" `IconButton` at line 557 that opens a right `Drawer`. Add an adjacent "AI Enhance" button opening the new enhancement drawer. `refreshFullItem()` (line 184) is the exact hook to call after a "replace" outcome to bust the cache and reload the image.

### 9.3 The enhance + compare + decide drawer (new component)
`MediaEnhancementDrawer.tsx`, modeled structurally on `MediaOrientationEditor.tsx` (right `Drawer`, `zIndex` above the lightbox, busy/error states) but with:
1. **Params step** — the §4.1 toggles (`auto` default with a "Customize" expander), model shown from `ai.features.enhance`, "Enhance" button.
2. **Progress step** — spinner while the job runs; polls `GET …/enhance/:id` every 2 s (clone `hooks/useMediaMetadata.ts` → `hooks/useMediaEnhance.ts`, `services/enhance.ts`).
3. **Compare step** — two side-by-side panes copied from `pages/Duplicates/DuplicateGroupPage.tsx`'s `ComparePane` (`objectFit: contain`), a metadata delta row (dimensions/size, with a **downscale warning** when enhanced < original), and the decision bar: **Keep both** / **Replace** / **Discard**, each opening a confirm `Dialog` (same MUI confirm pattern used throughout) describing the outcome before committing.

### 9.4 Properties pane (tertiary)
Optionally add an "Enhance with AI" button + "AI Enhanced" badge in `MediaDetailDrawer.tsx` alongside "Re-run metadata extraction" / "Retry thumbnail".

### 9.5 API layer
`services/enhance.ts` using the existing `fetch` wrapper (`services/api.ts`, no React Query): `startEnhance(id, params)`, `getEnhancement(id, enhancementId)`, `applyEnhancement(id, enhancementId, decision)`, `discardEnhancement(id, enhancementId)`. Admin AI page (`pages/Admin/AiSettingsPage.tsx`) gains an "AI Picture Enhancer" `<Paper>` cloned from the Tagging block + a `putAiEnhanceFeature` service fn + an `enhance` field on `AiSettingsResponse.features`.

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
| `GET /api/admin/ai/enhance/status` | `system_settings:read` | — (Admin) | Doctor |

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

There is no `stampExif`/ExifTool-availability check in v1, consistent with the EXIF writer being deferred (see [Implementation status (v1)](#implementation-status-v1)).

---

## 12. Cost, Safety & Limitations

- **Cost.** `gpt-image-1` image generation is **billed per image and is materially more expensive than a text/vision call.** v1 is single-item, on-demand only — no bulk, no upload-time auto-enhance — which bounds spend to explicit user actions. Surface a subtle "uses AI credits" note in the UI.
- **Fidelity risk.** Generative editing can alter faces/text/detail (§2). Mitigated by `input_fidelity: 'high'`, the constraint-heavy prompt, `preserveFaces` default, and the mandatory review gate. **Never auto-applied.**
- **Resolution loss.** Enhanced output is often lower-res than the original; the compare UI must make this obvious and replace must warn (§2 / §7 policy).
- **EXIF portability.** If we ship §5.1 option (C) first, the file itself won't carry the AI-improved marker — only the in-app marker will. Full file marking needs the ExifTool writer.
- **Rate limits.** Handled by the queue's existing 429/529 deferral + backoff.
- **Idempotency / supersession.** One live enhancement per item; re-requesting supersedes and reaps the prior staging.

---

## 13. Testing Notes

**Backend (Jest + Supertest):**
- `picture-enhancement.handler.spec.ts` — mock the OpenAI `images.edit` client; assert staging upload, dims/size recorded, `ready`/`failed` transitions, retry/rate-limit routing.
- `media-enhancement.controller.spec.ts` — photo-only 400, feature-flag 400, RBAC (viewer can GET, non-collaborator cannot apply), supersession, apply(keep_both) creates item + copies metadata + marker, apply(replace) overwrites/reprocesses/nulls-hash/re-enqueues faces, discard deletes staging.
- Metadata copy unit test — assert `capturedAt`/camera/geo columns carried; contentHash rotation + `P2002` fallback path.
- EXIF stamp unit test (if §5.1 A) — round-trip: enhanced file gains `Software`/`XMP-MemoriaHub:*` and retains original GPS/DateTimeOriginal.
- Retention sweep test — `expired` transition + staging deletion.

**Frontend (RTL):**
- Enhance icon visibility: only `count===1 && photo && featureOn`.
- Drawer flow: params → polling → compare → confirm dialogs; downscale warning renders; replace calls `refreshFullItem`.

**Manual (`/verify`):** enable feature + configure OpenAI model → enhance a dim indoor photo → review → keep both (new item appears, original intact) → enhance another → replace (thumbnail regenerates, badge appears, EXIF marker present) → discard a third (staging gone).

---

## 14. Open Decisions Summary

Collected here for the review pass — each is flagged **⟐** in context above. All eight were resolved for v1, as shipped:

1. **Downscale policy on replace** (§2): **resolved as warn-and-allow** — `pictureEnhancement.blockReplaceOnDownscale` defaults to `false`; the UI shows the downscale warning but replace is not blocked unless an admin opts in.
2. **Auto-straighten** (§2): **resolved as an optional prompt toggle, off by default** — `adjustments.straighten` (§4.1) ships as a request param, default `false`.
3. **contentHash rotation on replace** (§3): **resolved as null-and-recompute** — `replace` nulls `MediaItem.contentHash` before `reprocessObjectNow`, matching the P2002-fallback handling already in `media-metadata-sync.service.ts`.
4. **Two-tier analyze-then-edit** (§4.3): **resolved as single-call v1** — `picture_enhancement` makes exactly one `images.edit` call per enhancement; no `pictureEnhancement.analyzeFirst` flag exists. Remains future work.
5. **EXIF writer** (§5.1): **resolved as (C) — in-app marker only for v1.** `exiftool-vendored` was **not** added to `apps/api`; `pictureEnhancement.stampExif` defaults to `false`. Option (A) remains the recommended next increment — see [Implementation status (v1)](#implementation-status-v1).
6. **First-class `aiEnhancedAt` column** (§5.3): **not added** — v1 uses `metadata._aiEnhanced` + the "AI Enhanced" system tag only; no new `media_items` column. Still open as future work if a dedicated search facet is wanted.
7. **One live enhancement per item** (§6.1): **resolved as supersede semantics** — a new `POST …/enhance` request discards any existing `pending`/`processing`/`ready` row's staging bytes for that item.
8. **`allowReplace` default** (§7): **resolved as `true`** — replace is allowed by default; admins can set `pictureEnhancement.allowReplace=false` to force keep-both-only.

---

## 15. Future Work

| Capability | Notes |
|-----------|-------|
| Bulk enhancement | Queue already supports it; needs a review-queue UX (like bursts/duplicates) rather than a per-item drawer. |
| Two-tier analyze-then-edit | Vision-model diagnosis feeding the edit prompt for sharper targeting. |
| Additional providers | Registry supports it; e.g. a local ESRGAN/Real-ESRGAN upscaler or Stability edit endpoint for true enhancement/super-resolution. |
| C2PA content credentials | Cryptographic provenance marking (the industry standard for "AI-edited") instead of/alongside the EXIF marker. |
| Preset styles | Saved parameter presets ("Auto", "Restore old photo", "Punchy", "Natural"). |
| Side-by-side slider | A draggable before/after slider in the compare UI. |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | July 2026 | AI Assistant | Initial draft for review. |
| 1.0 | July 2026 | AI Assistant | Marked Implemented (v1); documented deviations from the draft (EXIF writer deferred to option C, `stampExif` default flipped to `false`, `enhanceImage` failures use normal retry not rate-limit deferral, Doctor check has no live `testModel` probe); resolved all eight §14 open decisions. |

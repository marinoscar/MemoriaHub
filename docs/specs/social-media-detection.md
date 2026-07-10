# Social-Media Video Detection — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.1 |
| **Last Updated** | July 2026 |
| **Status** | Implemented (backend complete; UI not yet implemented) |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Gate-Then-Fan-Out Processing Flow](#2-gate-then-fan-out-processing-flow)
3. [Detection Engine](#3-detection-engine)
4. [Data Model](#4-data-model)
5. [Configuration](#5-configuration)
6. [API Endpoints](#6-api-endpoints)
7. [RBAC](#7-rbac)
8. [Doctor Integration](#8-doctor-integration)
9. [Degraded Mode and Limitations](#9-degraded-mode-and-limitations)
10. [Security and Privacy](#10-security-and-privacy)
11. [Testing Notes](#11-testing-notes)
12. [Extension Points and Future Work](#12-extension-points-and-future-work)

---

## 1. Overview and Goals

### The problem: TikTok/Instagram/Facebook re-shares pollute the family library

Family circles routinely accumulate videos that were never personally captured: someone downloads a TikTok, Reel, or Facebook video and uploads it into a circle "for the family to see." These files are not memories — they carry no faces to recognize, no location to geotag, and no camera metadata worth extracting — yet without a way to distinguish them they burn the same face-detection and auto-tagging compute budget as a genuine home video, and they clutter every browse surface (Home, Albums, People, Explore).

Social-media video detection classifies a video at upload time as **clean** (personal footage) or **flagged** (re-shared from TikTok, Instagram, or Facebook). Flagged videos are tagged, not deleted — the user decides via the existing tag-based search and archive/trash workflow whether to keep, archive, or delete them. This mirrors the non-destructive review-queue philosophy of burst detection and near-duplicate detection: **the system never deletes anything on its own.**

### Goals

- Detect video re-shares from TikTok, Instagram, and Facebook without any cloud API call — pure container-metadata/filename rules plus a local OCR fallback, both fully on-server.
- Save enrichment compute: a flagged video skips face detection (and every other enrichment type that would otherwise apply to a video) entirely.
- Operate as a global feature toggle (`features.socialMediaDetection`, default off), consistent with face recognition, auto-tagging, burst detection, duplicate detection, and location inference.
- Be non-destructive: apply tags, never delete or hide media automatically. The user finds flagged videos via `?tag=Social Media` and acts on them manually.
- Degrade gracefully: if OCR (Tier 2) is unavailable, the feature keeps working on Tier 1 (metadata/filename) alone rather than failing jobs.
- Reuse the existing tag/tag-protection model (`MediaTagSource`) rather than inventing a parallel labeling mechanism.

### Non-Goals

- **Auto-deletion or auto-archival.** Flagged videos are tagged only; a human decides what to do with them via the standard bulk-archive/bulk-delete workflow.
- **Photo detection.** Only `MediaType.video` items are classified — social-media re-shared *photos* (e.g. a screenshotted Instagram post) are out of scope for this feature, though the detector's input type is deliberately shaped to make adding a `kind: 'photo'` variant straightforward later (§12).
- **Cloud vision APIs.** Both tiers run entirely in-process: ffprobe for container metadata, tesseract.js (WASM) for OCR. No pixel data or video bytes are sent to a third-party service.
- **Perfect recall.** The detector is tuned for **precision over recall** — see §9 for the WhatsApp/Telegram re-encode blind spot this creates.

---

## 2. Gate-Then-Fan-Out Processing Flow

### 2.1 Why "Gate-Then-Fan-Out"

For photos, every enrichment type (`auto_tagging`, `face_detection`, `burst_detection`, `duplicate_detection`, `location_inference`) is enqueued independently and runs in parallel — there is no ordering dependency between them. For videos, the *only* upload-time enrichment type that existed before this feature was `video_face_detection`. Social-media detection needed to run **before** that face detection so a flagged video's face job could be skipped rather than wasted — but the classification itself (especially the Tier-2 OCR pass) is asynchronous and must not block the upload response.

The solution is a **gate-then-fan-out** pattern: at upload time, only `social_media_detection` is enqueued for a video (never `video_face_detection` directly). The `social_media_detection` handler is the single decision point:

- **Detected** → apply tags, stop. `video_face_detection` is never enqueued for this item.
- **Clean** → fan out the withheld `video_face_detection` job via `MediaEnrichmentService.enqueueVideoPostDetectionEnrichment(...)`.

```
Video uploaded
      │
      ▼
features.socialMediaDetection on? ──No──▶ enqueue video_face_detection directly (unchanged legacy behavior)
      │ Yes
      ▼
enqueue social_media_detection (priority 10)
      │
      ▼
SocialMediaDetectionHandler.process()
      │
      ├─ Tier 1 (metadata + filename rules) ──────► confident match? ──Yes──▶ DETECTED
      │                                                     │ No
      │                                                     ▼
      ├─ recommendTier2 (grey-zone / suspicious)? ──No──▶ CLEAN
      │        │ Yes, and socialMedia.ocrEnabled
      │        ▼
      └─ Tier 2 OCR on first/last frames ──────────► confident match? ──Yes──▶ DETECTED
                                                              │ No
                                                              ▼
                                                            CLEAN

DETECTED → apply "Social Media" + platform tag (system-sourced); write media_social_status +
           media_items.social_media_source; STOP (no fan-out)

CLEAN    → write media_social_status (isSocialMedia:false); if previously flagged, strip the
           system tags and clear social_media_source; THEN
           MediaEnrichmentService.enqueueVideoPostDetectionEnrichment(...) → video_face_detection
```

### 2.2 Defensive Gates

Two additional gates exist so a flagged video can never accidentally re-enter face-detection compute even if the fan-out call is skipped, retried, or raced:

- **`VideoFaceDetectionHandler`** (`apps/api/src/face/video-face-detection.handler.ts`) loads `mediaItem.socialMediaSource` and, if non-null, short-circuits: marks the item `no_faces` (so status reads as "processed", not stuck) without downloading the video or touching the face provider.
- **`FaceBackfillService`** (`apps/api/src/face/face-backfill.service.ts`) filters `socialMediaSource: null` into its eligibility query, so an admin-triggered `POST /api/admin/face/backfill` never re-creates face-detection jobs for videos already flagged as social re-shares.

Both gates are defense-in-depth on top of the gate-then-fan-out ordering, not a replacement for it — they protect against edge cases like a rerun of `social_media_detection` on an item that already has a `video_face_detection` job queued from before the feature was enabled.

### 2.3 Job Enqueue Details

| Trigger | Job type | Priority | Reason |
|---|---|---|---|
| Video upload, feature on | `social_media_detection` | 10 | `upload` |
| Video upload, feature off | `video_face_detection` (direct, unchanged legacy path) | 20 | `upload` |
| Per-item rerun (`POST /api/media/:id/social-media/rerun`) | `social_media_detection` | 0 (highest) | `rerun` |
| Admin backfill (`POST /api/admin/social-media/backfill`) | `social_media_detection` | 100 (lowest) | `backfill` |
| Clean-path fan-out (any of the above once classified clean) | `video_face_detection` | 0 / 20 / 100 (mirrors the reason that triggered classification) | same as the triggering job's reason |

`enqueueVideoPostDetectionEnrichment` maps priority from `reason` (`rerun` → 0, `upload` → 20, `backfill` → 100) so a fanned-out face-detection job inherits the same urgency class as the classification job that unblocked it. It is guarded by the same `features.faceRecognition` / `face.video.enabled` / `FACE_AUTO_DETECT` checks as the legacy direct-enqueue path — so if face recognition itself is off, no `video_face_detection` job is created regardless of the social-media classification outcome.

### 2.4 Legacy Item Re-Probing

`SocialMediaDetectionHandler` reads persisted ffprobe container metadata from `StorageObject.metadata._processing['video-probe']` (written by the `video-probe` storage processor at upload time — see `apps/api/src/storage/processing/processors/video-probe.processor.ts`). For videos uploaded **before** this feature existed, that block is absent; the handler downloads the video and re-runs ffprobe on the fly (`reprobe()`, writing to a temp file and cleaning up in a `finally` block) so backfill works uniformly across old and new library items.

### 2.5 Pre-Flight Caps and Orientation Gate

Before any download, the handler applies two cheap filters — in this order, cheapest first — so most non-social videos never touch the disk or the OCR engine on a low-compute VPS. Both are deliberate **precision-over-compute** tradeoffs consistent with the feature's precision-over-recall stance (§9.2).

**1. Size / duration caps (no download).** Evaluated against persisted metadata + object size:

| Order | Condition | Outcome |
|---|---|---|
| 1 | `VIDEO_ENRICHMENT_MAX_BYTES > 0` and object size exceeds it | clean, `matchedRule: skip-size-cap` |
| 2 | duration known and `> socialMedia.maxDurationSeconds` | clean, `matchedRule: skip-duration-cap` |
| 3 | duration unknown and object size `> socialMedia.maxSizeBytes` | clean, `matchedRule: skip-size-cap` |

Duration is taken from the persisted `video-probe` block, falling back to `mediaItem.durationMs`. The operator domain fact behind the duration cap: genuine TikTok/Instagram/Facebook re-uploads never exceed ~5 minutes, so a longer video is overwhelmingly likely to be real home footage. The size caps are the fallback signal when no duration is known. A capped video is routed through the **normal clean path** — `applyClean(...)` still strips any stale system tags and clears `social_media_source` if the item was previously flagged, and the withheld `video_face_detection` job still fans out via `enqueueVideoPostDetectionEnrichment` — so a cap decision is fully equivalent to a genuine "clean" classification, just cheaper.

**2. Orientation gate (no download for the download-dependent tiers).** A strictly-**landscape** video (`width > height`, from persisted probe or `mediaItem` dimensions) is never downloaded for this job. TikTok and Instagram videos are never landscape; Facebook can be, but landscape Facebook re-shares are accepted as adequately covered by the Tier-1 filename/container-metadata rules alone. A landscape video therefore:

- runs **Tier 1** on its filename plus whatever container metadata is already persisted (even if incomplete) — it does **not** trigger the legacy re-probe download that a portrait legacy item would (§2.4);
- **never runs Tier-2 OCR** — `recommendTier2` is forced off for landscape input regardless of what Tier 1 recommends.

The blind spot this accepts: a landscape re-share detectable only by reading a burned-in watermark via OCR is missed (classified clean). This is intentional — the download + OCR compute for every landscape video is not worth the marginal recall on a memory-constrained host.

The caps run before the orientation gate because they are cheaper still (pure comparisons, no metadata reasoning) and can short-circuit the whole job; orientation only gates the download-dependent work that survives the caps.

---

## 3. Detection Engine

`SocialMediaDetectorService` (`apps/api/src/social-media/social-media-detector.service.ts`) is a **zero-IO, synchronous, dependency-free** rule engine — it performs no database access and no network/disk IO, making it fully unit-testable in isolation. Rule sets are **data-driven** (module-level `const` arrays), so adding a platform or heuristic is a data-only change, not a control-flow change.

### 3.1 Tier 1 — Container Metadata and Filename Rules

`detectTier1(input, minConfidence)` evaluates every rule below against the input and returns the **highest-confidence match**. If the best match's confidence is `>= minConfidence` (default `0.8`, via `socialMedia.minConfidence`), it is returned as a `DetectionResult` immediately — Tier 2 never runs. Otherwise, Tier 2 is recommended (`recommendTier2: true`) when the best match falls in the grey zone `[0.6, minConfidence)` **or** any suspicion heuristic fires; if neither, the video is classified clean without OCR.

#### Metadata rules (scanned across `formatTags` + every `streamTags` entry)

| Rule ID | Platform | Confidence | Signal |
|---|---|---|---|
| `tt-comment-vid` | TikTok | 0.98 | `format.tags.comment` matches `^vid:v0[0-9a-z]` (TikTok's own export marker) |
| `tt-bytedance` | TikTok | 0.98 | Any tag key equals `aigc_info` or `com.bytedance.info`, or any tag key/value contains `bytedance` |
| `tt-handler` | TikTok | 0.95 | Any stream's `handler_name` tag contains `bytedance` or `tiktok` |
| `tt-text` | TikTok | 0.90 | Format tag `artist`, `description`, or `copyright` contains `tiktok` or `douyin` |
| `ig-text` | Instagram | 0.90 | Any tag value contains `instagram` |
| `fb-text` | Facebook | 0.90 | Any tag value contains `facebook` |

#### Filename rules (case-insensitive unless noted)

| Rule ID | Platform | Confidence | Pattern |
|---|---|---|---|
| `tt-fn-downloader` | TikTok | 0.95 | Filename matches a known downloader-app signature: `snaptik`, `ssstik`, `tikmate`, `musical(ly)?down`, `ttsave`, `tikdown`, `tiktokio` |
| `tt-fn-word` | TikTok | 0.95 | Filename contains the standalone word `tiktok` |
| `tt-fn-bareid` | TikTok | 0.70 | Filename is a bare 19-digit TikTok snowflake ID starting with `7` (e.g. `7123456789012345678.mp4`) |
| `ig-fn-downloader` | Instagram | 0.95 | Filename matches `snapinsta`, `saveinsta`, `instasave`, `igram.`, `storysaver`, `reelsav`, `fastdl` |
| `ig-fn-word` | Instagram | 0.95 | Filename contains the standalone word `instagram` or `ig_reel`/`igreel` |
| `ig-fn-cdn` | Instagram | 0.75 | Filename matches Instagram's own CDN naming, **case-sensitive**: `^AQ[MN][\w-]{12,}\.mp4$` |
| `fb-fn-downloader` | Facebook | 0.95 | Filename matches `fdown`, `fbdown`, `getfvid`, `fbvideo`, `fb_video`/`fbvideo` |
| `fb-fn-word` | Facebook | 0.90 | Filename contains the standalone word `facebook`, or starts with `fb_vid`/`fbvid` |
| `gen-fn-downloader` | `other` | 0.85 | Filename matches a generic downloader-app signature not specific to one platform: `snapsave`, `savefrom`, `y2mate`, `videodownloader` |

Every metadata/filename match carries `method: 'metadata'` or `method: 'filename'` respectively in the resulting `DetectionResult`, matching the rule's `source`.

#### Caption, hashtag, and @mention rules

Download apps commonly name the saved file after the original post's caption (e.g. `Every man wants this!! #fypシ #reels #dating @empoweredtok on TT.mp4`), and sometimes also copy that same caption into container text tags. Personal camera-captured filenames (`IMG_1234.MOV`, `PXL_20260704_120000.mp4`, `VID-20260704-WA0001.mp4`, `MVI_0031.MOV`) never contain hashtags or @mentions, which makes a hashtag/@mention in either location a high-precision social-media signal — one the prior literal-word/downloader-app rules above missed. This specifically closes the Instagram/cross-post gap: a re-share that has had its own platform-specific container markers stripped by an intermediate re-share step still carries its caption in the filename.

`detectCaptionSignal(input)` implements this and is folded into `detectTier1` — its result competes on confidence against the metadata/filename rule winner above; whichever is higher wins. It scans the filename first, then caption text harvested from container tags (`title`, `comment`, `description`, `synopsis`, `keywords`, `artist`, `album`, `author` format tags, plus every value in every stream-tag bag), attributing `method: 'filename'` or `method: 'metadata'` depending on which source produced the match.

| Rule ID | Platform | Confidence | Signal |
|---|---|---|---|
| `caption-tt-token` | TikTok | 0.90 | A TikTok platform token: `#fyp*`/`#foryou*` (prefix match, so `#fypシ`, `#fypage`, `#foryoupage` all hit), `#tiktok`, `#ttok`, `#capcut`, the phrase `on tt`, or an @mention ending in `tok` (e.g. `@empoweredtok`) |
| `caption-ig-token` | Instagram | 0.90 | An Instagram platform token: `#reel`/`#reels`, `#instagram`, `#igreel`, `#insta`, or the phrase `ig reel` |
| `caption-fb-token` | Facebook | 0.90 | A Facebook platform token: `#facebook`, `#fbreel`/`#fbreels`, or the phrase `fb reel` |
| `caption-generic` | `other` | 0.90 | No platform token, but ≥2 hashtags, OR ≥1 hashtag + an @mention, OR ≥1 hashtag + a multi-word phrase |
| `caption-single-hashtag` | `other` | 0.85 | Exactly one lone hashtag (none of the `caption-generic` conditions met) |

When platform token patterns are tied on hit count, tie-break order is `tiktok` > `instagram` > `facebook`.

A lone @mention with **no** hashtag and no platform token is **not** classified by `detectCaptionSignal` — it instead fires the `heur-caption-mention` suspicion heuristic below, routing the item to Tier 2 OCR rather than an immediate classification.

> **Note:** Hashtag counting excludes purely-numeric hashtags (`#1`, `#2`, `#23`) — a hashtag only counts toward `caption-generic`/`caption-single-hashtag` if it contains at least one Unicode letter. This precision guard specifically prevents filenames like `Take #2.mp4` or `Photo #1.mp4` (common for numbered family-video exports) from being miscounted as social captions.

#### Suspicion heuristics (never produce a result on their own — only recommend Tier 2)

| Heuristic ID | Signal |
|---|---|
| `heur-portrait-short` | Portrait aspect ratio (`height/width >= 1.6`), duration ≤ 180 s, **no** device-capture tags (`com.apple.quicktime.make/model`, `com.android.*`), **and** `creation_time` is missing, unparseable, or resolves to the Unix epoch (1970) — the classic profile of a re-encoded short-form clip with metadata stripped |
| `heur-reshare-filename` | Filename matches a messaging-app re-share pattern: `^VID-\d{8}-WA\d{4}` (WhatsApp) or `^video_\d{4}-\d{2}-\d{2}[_ ]` (Telegram-style) |
| `heur-caption-mention` | Filename or caption metadata contains an @mention but zero hashtags and no platform token — routes to Tier 2 OCR only, never classifies on its own |

### 3.2 Tier 2 — OCR Watermark Reading

When Tier 1 is inconclusive but suspicious, `SocialMediaOcrService.recognizeVideo()` (`apps/api/src/social-media/social-media-ocr.service.ts`) extracts a handful of frames biased toward the **start and end** of the clip (`computeOcrTimestamps`) — social watermarks and usernames typically sit at one or both ends of a re-shared video. Each frame is preprocessed with `sharp` (downscale to 720 px long edge, grayscale, normalize) and run through a lazily-created, reused `tesseract.js` worker. Recognized words below `WORD_CONFIDENCE_THRESHOLD` (60, out of 100) are discarded before the text is handed to `detectFromOcr`.

`detectFromOcr(texts, input, minConfidence)` reasons over the normalized (diacritics-stripped, lowercased) OCR text:

| Signal | Platform | Confidence | Notes |
|---|---|---|---|
| `tik ?tok` or `douyin` | TikTok | 0.90 | `ocr-tiktok-word` |
| `instagram` | Instagram | 0.90 | `ocr-instagram-word` |
| `facebook` | Facebook | 0.85 | `ocr-facebook-word` |
| `reels?` (bare word) | Instagram | 0.60 | `ocr-reels-corroborate` — **always sub-threshold**, corroboration only, never a standalone match |
| `@[a-z0-9_.]{3,24}` (username) | `other` | 0.50 (0.75 if a suspicion heuristic also fired) | `ocr-username` — only added when no platform word is already present; a platform word's own confidence is not boosted by a co-occurring username |
| TikTok platform token (§3.1) visible on screen | TikTok | 0.90 | `ocr-tiktok-token` — the same `#fyp*`/`#foryou*`/`#tiktok`/`#ttok`/`#capcut`/`on tt`/`@...tok` patterns as the Tier-1 caption rules, applied to OCR'd text (e.g. an `@user...tok` handle visible in frame) |
| Instagram platform token (§3.1) visible on screen | Instagram | 0.90 | `ocr-instagram-token` — the same `#reel(s)`/`#instagram`/`#igreel`/`#insta`/`ig reel` patterns as the Tier-1 caption rules, applied to OCR'd text (e.g. a `#reels` watermark) |
| Facebook platform token (§3.1) visible on screen | Facebook | 0.90 | `ocr-facebook-token` — the same `#facebook`/`#fbreel(s)`/`fb reel` patterns as the Tier-1 caption rules, applied to OCR'd text |

The highest-confidence candidate is returned as a `DetectionResult` (`method: 'ocr'`) only if it meets `minConfidence`; otherwise `detectFromOcr` returns `null` and the video is classified clean.

**Design constraints on the OCR service** (`SocialMediaOcrService`):
- **Never throws.** Worker init failure, frame-extraction failure, or a recognize error all resolve gracefully (empty/partial text, `available: false`) rather than propagating — the enrichment job never fails because of OCR.
- **Sticky degraded mode.** Once `degraded = true` (permanent worker-init failure), every subsequent call short-circuits to `{ texts: [], available: false }` without retrying; a warning is logged exactly once (`degradedWarned`).
- **Serialized worker.** A single lazily-created tesseract worker is reused across calls; `recognizeFrame` calls are chained through a promise so the worker is never asked to run two jobs concurrently.
- **Soft timeout.** The whole OCR phase races against `socialMedia.ocrTimeoutSeconds` (default 60 s); on timeout, whatever text was collected so far is returned with `available: true` — a timeout is a budget limit, not a failure.
- **Air-gapped support.** `traineddata` is cached under `${MODELS_DIR}/tesseract`; if the file(s) already exist there, `langPath` is set to read locally instead of hitting tesseract's CDN, mirroring the `MODELS_DIR` precedent already established for the CLIP model (see [duplicate-detection.md §4.1](duplicate-detection.md#41-model-distribution)).

---

## 4. Data Model

### 4.1 New Table: `media_social_status`

One row per video media item that has (or had) a social-media detection outcome, mirroring the shape of `media_geocode_status`/`media_metadata_status`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `mediaItemId` | UUID | Unique, FK → `media_items` (cascade delete) |
| `status` | `MediaSocialStatusType` | `not_processed` \| `pending` \| `processing` \| `processed` \| `failed`; default `not_processed` |
| `isSocialMedia` | Boolean | Default `false`; the classification outcome |
| `platform` | String? | `'tiktok'` \| `'instagram'` \| `'facebook'` \| `'other'`; null when clean |
| `detectionMethod` | String? | `'metadata'` \| `'filename'` \| `'ocr'`; null when clean |
| `confidence` | Float? | 0–1; null when clean |
| `matchedRule` | String? | The winning rule/heuristic ID (e.g. `tt-comment-vid`, `ocr-instagram-word`) when detected; for a video skipped by a pre-flight cap (§2.5) it records WHY it read as clean — `skip-duration-cap` or `skip-size-cap` — even though `isSocialMedia` is false; null for a genuine no-match clean |
| `processedAt` | DateTime? | |
| `lastError` | String? | |
| `createdAt` / `updatedAt` | DateTime | |

Index: `@@index([status])`.

### 4.2 New Column on `media_items`: `social_media_source`

| Column | Type | Notes |
|--------|------|-------|
| `socialMediaSource` | String? | `'tiktok'` \| `'instagram'` \| `'facebook'` \| `'other'`; null = clean/unknown |

This is the **denormalized, queryable outcome column** — `media_social_status` records the full detection audit trail (method, confidence, matched rule), while `socialMediaSource` is the single column every gate (`VideoFaceDetectionHandler`, `FaceBackfillService`) checks to decide whether to skip face-related processing. Written only by `SocialMediaDetectionHandler`; cleared automatically if a rerun reclassifies a previously-flagged video as clean (§2.1).

### 4.3 `MediaTagSource.system` and Tag Protection

`MediaTagSource` (already `manual` | `ai`) gained a third value, **`system`**, added in its own migration (`20260705000000_add_media_tag_source_system`) because Postgres cannot add an enum value in the same transaction as statements that reference it — the follow-up migration (`20260705000100_add_social_media_detection`) that actually uses `system` had to be separate.

`system` marks tags applied by an automated feature whose provenance should never be silently overwritten by a *less* authoritative writer. The `SocialMediaDetectionHandler` is (as of this version) the sole writer of `system`-sourced tags:

- **Applying a tag** (`applyDetected`): `MediaTag.upsert` creates the row with `source: system` if absent; if a row already exists with `source: ai` (i.e. auto-tagging had independently applied the same tag name, e.g. a vision model guessing "TikTok" from on-screen content), it is **promoted** to `system` via `updateMany({ where: { source: ai }, data: { source: system } })`. An existing `source: manual` row is left untouched — a user's own manual tag is never downgraded or overwritten.
- **Clearing a tag** (`applyClean`, only when the item was previously flagged): `MediaTag.deleteMany` removes rows scoped to `source: system` and one of the four social tag names (`Social Media`, `TikTok`, `Instagram`, `Facebook`). A user who separately, manually applied one of these same tag names keeps their manual row untouched — only the system-sourced row is removed.

This one-directional promotion rule (`ai` → `system`, never `manual` → anything, never `system` → `ai`) is the general pattern any future system-tagging feature should follow: **system provenance wins over AI, user intent always wins over both.**

### 4.4 Tag Vocabulary

Two tag names are applied on detection: the umbrella tag **`Social Media`** (always) plus a platform-specific tag — **`TikTok`**, **`Instagram`**, or **`Facebook`** (platform `other` gets no platform tag, only the umbrella one). Both are ordinary circle-scoped `Tag` rows (`Tag.upsert` by `(circleId, name)`) — there is no separate vocabulary table for these labels, unlike the admin-managed `tag_labels` used by AI auto-tagging.

---

## 5. Configuration

### 5.1 System Settings (Admin-Editable)

| Setting key | Type | Range | Default | Description |
|-------------|------|-------|---------|-------------|
| `features.socialMediaDetection` | boolean | — | `false` | Global on/off. Gates both the upload-time enqueue (videos route to `social_media_detection` instead of directly to `video_face_detection`) and the admin backfill/rerun endpoints. |
| `socialMedia.ocrEnabled` | boolean | — | `true` | Whether Tier 2 OCR runs at all. When `false`, the feature is Tier-1-only even if Tier 1 recommends Tier 2. |
| `socialMedia.ocrLanguages` | string[] | 1–5 entries | `['eng']` | tesseract language codes to load. |
| `socialMedia.ocrMaxFrames` | integer | 2–6 | `4` | Hard cap on frames OCR'd per video. |
| `socialMedia.ocrTimeoutSeconds` | integer | 10–300 | `60` | Soft timeout for the whole OCR phase; partial results are kept on timeout. |
| `socialMedia.minConfidence` | number | 0.5–1.0 | `0.8` | Decision threshold shared by both tiers — the minimum confidence a Tier 1 or Tier 2 candidate must meet to classify a video as detected. |
| `socialMedia.maxDurationSeconds` | integer | 60–3600 | `300` | A video whose known duration exceeds this is treated as CLEAN without downloading or OCR — genuine social-media clips never exceed ~5 minutes. Recorded as `matchedRule: skip-duration-cap`. See [§2.5](#25-pre-flight-caps-and-orientation-gate). |
| `socialMedia.maxSizeBytes` | integer | ≥ 10_000_000 | `500_000_000` | Size fallback used only when the video's duration is unknown (no persisted ffprobe metadata) — an over-cap video is treated as CLEAN, `matchedRule: skip-size-cap`. Distinct from the unconditional `VIDEO_ENRICHMENT_MAX_BYTES` env cap (§5.2), which is checked first regardless of duration. |

All `socialMedia.*` values are validated by the same Zod schema used for every other system-settings write path (`apps/api/src/common/schemas/settings.schema.ts`), round-tripped through `PATCH /api/system-settings` / `PUT /api/system-settings` like every other setting group.

### 5.2 Environment Variables

| Variable | Default | Description |
|----------|---------|--------------|
| `SOCIAL_MEDIA_DETECTION_ENABLED` | `true` | Environment kill-switch. Set to `false` to disable upload-time `social_media_detection` enqueue regardless of `features.socialMediaDetection` — same pattern as `DUPLICATE_DETECTION_ENABLED`, `LOCATION_INFERENCE_ENABLED`, `BURST_DETECTION_ENABLED`. When killed, videos fall back to the legacy direct `video_face_detection` enqueue path. |
| `VIDEO_ENRICHMENT_MAX_BYTES` | `0` | Optional unconditional hard cap (bytes) on videos this handler will process, **shared with `video_face_detection`** so one knob covers both. `0` disables. An over-cap video is treated as CLEAN without downloading (`matchedRule: skip-size-cap`), checked before both the duration/size settings caps and the orientation gate. See [§2.5](#25-pre-flight-caps-and-orientation-gate). |
| `MODELS_DIR` | `./data/models` | Persistent-volume directory; the OCR tier caches downloaded tesseract `traineddata` under `${MODELS_DIR}/tesseract` (same volume already used for the CLIP model — see [duplicate-detection.md §4.1](duplicate-detection.md#41-model-distribution)). |

The shared enrichment worker variables (`ENRICHMENT_WORKER_ENABLED`, `ENRICHMENT_JOB_POLL_MS`, `ENRICHMENT_WORKER_CONCURRENCY`) govern the queue that runs `social_media_detection` alongside every other enrichment type — see [enrichment-queue.md](enrichment-queue.md).

---

## 6. API Endpoints

All endpoints require JWT Bearer authentication. No new system-level RBAC permission scopes were introduced — the per-item endpoints reuse `media:read`/`media:write` (plus per-circle role checks), and the admin endpoints reuse `system_settings:read`/`system_settings:write`, exactly like duplicate detection and location inference.

### 6.1 `GET /api/media/:id/social-media/status`

Get the per-item detection status.

- **Auth:** `media:read` + per-circle `viewer` role.
- **Response `200`:**
  ```json
  {
    "data": {
      "status": "processed",
      "isSocialMedia": true,
      "platform": "tiktok",
      "detectionMethod": "metadata",
      "confidence": 0.98,
      "matchedRule": "tt-comment-vid",
      "processedAt": "2026-07-04T12:00:00.000Z",
      "lastError": null
    }
  }
  ```
  Returns a synthetic `{ status: "not_processed", isSocialMedia: false, platform: null, detectionMethod: null, confidence: null, matchedRule: null, processedAt: null, lastError: null }` when no `media_social_status` row exists yet (mirrors the geocode/metadata status endpoints' "no row yet" convention).
- **Response `404`:** item not found or soft-deleted.

### 6.2 `POST /api/media/:id/social-media/rerun`

Re-enqueue detection for a single media item at priority 0 (highest).

- **Auth:** `media:write` + per-circle `collaborator` role (`CircleMembershipService.assertCircleAccess`), consistent with the geocode, metadata-extraction, and duplicate-detection rerun endpoints.
- **Response `201`:** `{ "data": { "jobId": "uuid", "status": "pending" } }`.
- **Response `400`:** `features.socialMediaDetection` is `false`.
- **Response `404`:** item not found or soft-deleted.

> **UI:** Both endpoints back a "Re-run social-media detection" affordance in the media properties pane, mirroring the metadata/geocode rerun buttons already present there.

### 6.3 `POST /api/admin/social-media/backfill`

Bulk-enqueue `social_media_detection` jobs across **all circles**, video items only.

- **Auth:** Admin role + `system_settings:write`.
- **Requirement:** `features.socialMediaDetection` must be `true`; otherwise `400`.
- **Request body:** `{ "from": "ISO-8601"?, "to": "ISO-8601"?, "force": false }`. `from`/`to` bound `capturedAt` (both inclusive, independent). `force: false` (default) skips items whose `media_social_status.status` is already `processed`; `force: true` re-enqueues every eligible video regardless of existing status.
- **Response `201`:** `{ "data": { "enqueued": 42, "circles": 4 } }` — `enqueued` is the number of `social_media_detection` job rows created across every circle (matches the `/admin/settings/jobs` dashboard's `byType` count for this type exactly).

### 6.4 `GET /api/admin/social-media/status`

OCR (Tier 2) model availability and effective configuration — the social-media-detection analog of `GET /api/admin/duplicates/status`.

- **Auth:** Admin role + `system_settings:read`.
- **Response `200`:**
  ```json
  {
    "data": {
      "ocrEnabled": true,
      "ocrAvailable": true,
      "degraded": false,
      "modelPath": "./data/models/tesseract",
      "languages": ["eng"],
      "minConfidence": 0.8,
      "ocrMaxFrames": 4,
      "ocrTimeoutSeconds": 60
    }
  }
  ```
  `ocrEnabled` reflects the `socialMedia.ocrEnabled` setting; `ocrAvailable`/`degraded` reflect the live tesseract worker's actual state (a lazy worker init is attempted as part of this call, without any frame extraction, so it returns quickly — well under the Doctor 10 s check timeout). `degraded: true` means the deployment is running Tier 1 (metadata/filename) only.

### 6.5 Dashboard Integration

Unlike burst detection, near-duplicate detection, and location inference, `GET /api/media/dashboard` does **not** gain a `pendingSocialMediaGroups`-style review-queue count for this feature — there is no review queue. Flagged videos are discovered by the user via the tag `Social Media` in normal search/browse (`?tag=Social+Media`), not through a dedicated dashboard banner.

---

## 7. RBAC

| Endpoint | Permission | Per-circle role | Notes |
|---|---|---|---|
| `GET /api/media/:id/social-media/status` | `media:read` | `viewer` | |
| `POST /api/media/:id/social-media/rerun` | `media:write` | `collaborator` | 400 if feature disabled |
| `POST /api/admin/social-media/backfill` | `system_settings:write` | — (Admin, app-wide) | 400 if feature disabled |
| `GET /api/admin/social-media/status` | `system_settings:read` | — (Admin) | |

No new permission scopes were introduced. All endpoints reuse `media:read`/`media:write`/`system_settings:read`/`system_settings:write`, consistent with every other enrichment feature's rerun/backfill/admin-status endpoints.

---

## 8. Doctor Integration

`ai.socialMedia` (`DoctorService.checkSocialMedia`) is registered in the **AI & Enrichment** section, alongside `ai.search`, `ai.tagging`, `ai.embedding`, and `ai.flagConsistency`. See [doctor.md §4](doctor.md#4-check-catalog) for the full catalog this joins.

| Condition | Status | Message / Action |
|---|---|---|
| `features.socialMediaDetection` is `false` | `skipped` | "Social media detection disabled" |
| Feature on but `SOCIAL_MEDIA_DETECTION_ENABLED=false` | `warning` | "Feature enabled in settings but SOCIAL_MEDIA_DETECTION_ENABLED=false overrides it" → "Remove or set SOCIAL_MEDIA_DETECTION_ENABLED=true" |
| Any `socialMedia.*` tunable out of its documented range | `warning` | Lists each out-of-range value (`ocrMaxFrames`, `ocrTimeoutSeconds`, `minConfidence`) → "Correct the social media detection parameters in Admin Settings." |
| Feature on, `socialMedia.ocrEnabled` is `false` | `ok` | "Tier-1 (metadata/filename) only — OCR disabled in settings" |
| Feature on, OCR enabled, tesseract worker healthy | `ok` | "Two-tier detection operational (metadata/filename + OCR)" |
| Feature on, OCR enabled, tesseract worker degraded/unavailable | `warning` | "Running Tier-1 only — OCR model unavailable (degraded)" → "Ensure MODELS_DIR/tesseract is writable and traineddata can be fetched or pre-placed" |

The check calls `SocialMediaOcrService.getStatus()` — the same cheap availability probe used by `GET /api/admin/social-media/status` (§6.4) — so a passing Doctor check has the same meaning as a healthy admin status response.

---

## 9. Degraded Mode and Limitations

### 9.1 OCR-Unavailable Degraded Mode

If the tesseract worker cannot be initialized (missing/unwritable `MODELS_DIR/tesseract`, failed traineddata download, unsupported platform), `SocialMediaOcrService` sets a sticky `degraded` flag (§3.2). The feature keeps running on **Tier 1 only** — jobs never fail because of this, they simply classify using metadata/filename rules alone, which is a strict subset of full two-tier detection (fewer detections, never a job failure).

### 9.2 WhatsApp/Telegram Double Re-Encode Is the Known Blind Spot

The hardest case for this feature is a video that was **already** re-shared through TikTok/Instagram/Facebook, then **additionally** re-shared through WhatsApp or Telegram before reaching MemoriaHub. The messaging-app re-encode strips the original platform's container metadata (defeating Tier 1's metadata rules) **and** recompresses the frame enough that a burned-in watermark can become faint or blocky (making Tier 2 OCR less reliable). The `heur-reshare-filename` heuristic (§3.1) exists specifically to still route these files to the (more expensive) OCR pass rather than skip it, but OCR itself is a best-effort fallback, not a guarantee, in this doubly-recompressed case.

This is a deliberate **precision-over-recall** design choice: the rule catalog is tuned so that a positive detection is very likely correct (high per-rule confidence values, a 0.8 default threshold), accepting that some heavily-obscured re-shares will be missed (classified clean) rather than risk mis-flagging a genuine home video.

The caption/hashtag/@mention signal (§3.1, `detectCaptionSignal`) is specifically how a cross-posted Instagram download still gets caught even when it has had its own container markers stripped by an intermediate re-share/download step: the caption and its hashtags typically survive in the saved filename even when platform-specific metadata tags do not, so a cross-posted file can still trip `caption-ig-token`/`caption-generic` purely on filename inspection.

**Cross-post platform attribution is best-effort, not a guarantee.** A video may legitimately carry multiple platforms' tokens at once — for example, a TikTok clip re-shared to Instagram can carry both `#fyp` and `#reels` in the same caption/filename. The umbrella `Social Media` tag is always applied regardless of which platform wins, but the specific platform tag (`TikTok`/`Instagram`/`Facebook`) is attributed to whichever platform's signal is strongest (or wins the tie-break when counts are equal, per §3.1) — it does not necessarily reflect the video's true platform of origin.

### 9.3 Detaching the Tag Does Not Restore Enrichment

If a user manually removes the `Social Media` tag from a flagged item (rather than using the rerun endpoint), `media_items.social_media_source` is **not** cleared — the tag and the gating column are independent. `VideoFaceDetectionHandler` will continue to skip face detection for that item until a rerun (`POST /api/media/:id/social-media/rerun`) reclassifies it, because the gate checks `socialMediaSource`, not the presence/absence of the tag. This is intentional: tag removal is a display-only action a user might take for organizational reasons, while a rerun is the explicit signal that reclassification (and, if the outcome is clean, fan-out to face detection) should occur.

### 9.4 Video-Only

Only `MediaType.video` items are ever considered. A social-media re-shared *photo* (e.g. a screenshot of an Instagram post) is not detected by this feature at all — see §12 for the extension path.

---

## 10. Security and Privacy

### All Processing Is On-Server

Both tiers run entirely in-process: ffprobe (already required for video metadata extraction generally) for Tier 1, and a local WASM tesseract.js worker for Tier 2. No video bytes, frames, or extracted text are ever sent to a third-party service.

### Non-Destructive by Design

Detection only ever writes tags and status columns. No media item is archived, trashed, or hidden by this feature. All destructive/organizational actions (archive, delete, or ignore) remain manual, driven by the user searching `?tag=Social Media` and using the existing bulk-archive/bulk-delete workflow.

### Tag Provenance Protection

The `system` tag source (§4.3) ensures a user's own manual tagging is never silently overwritten by this feature, and this feature's own tags are never silently overwritten by a later AI auto-tagging pass (the promotion is one-directional: `ai` → `system`, never the reverse).

---

## 11. Testing Notes

**Current state (as of this version):** unit coverage exists for the core rule engine and handler wiring:

- `apps/api/src/social-media/social-media-detector.service.spec.ts` — covers every `METADATA_RULES` and `FILENAME_RULES` entry (including the case-sensitive `ig-fn-cdn` rule and the confidence tie-break between `tt-bytedance` and `tt-handler`), both suspicion heuristics, `detectTier1`'s grey-zone/threshold logic, and `detectFromOcr`'s signal combinations including `minConfidence` boundary behavior.
- `apps/api/src/social-media/social-media-detection.handler.spec.ts` — covers early-return guards (non-video/deleted/missing storage object), the feature gate, Tier-1-detected and clean outcomes, the OCR (Tier 2) fallback path, rerun-of-a-previously-flagged-item-now-clean (tag stripping + `social_media_source` clearing), and error handling.
- `apps/api/src/social-media/social-media-ocr.service.spec.ts` — covers `getStatus`, degraded-mode behavior, frame-extraction-returns-nothing, the soft timeout partial-results path, and word-confidence filtering.
- `apps/api/src/media/enrichment/media-enrichment.social.spec.ts` — covers the upload-time video routing decision (`social_media_detection` vs. direct `video_face_detection`) under feature-on, feature-on-with-env-kill-switch, and feature-off, confirms photos are unaffected by the flag, and covers `enqueueVideoPostDetectionEnrichment`'s reason-to-priority mapping.

**Known gaps**, tracked the same way duplicate detection's initial version tracked its own (see [duplicate-detection.md §13](duplicate-detection.md#13-testing-notes)):

- No dedicated spec file yet for `SocialMediaBackfillService` (per-circle/global backfill counting, `force` semantics, `enqueueRerun`, `getStatus`'s synthetic not-processed shape).
- No dedicated spec file yet for `SocialMediaMediaController` or `AdminSocialMediaController` (RBAC branches, the 400-when-disabled guard, request validation).
- `apps/api/src/face/video-face-detection.handler.spec.ts` and `apps/api/src/face/face-backfill.service.spec.ts` (pre-existing files) do not yet contain a case asserting the `socialMediaSource`-non-null early-return or the backfill eligibility exclusion described in §2.2 — the production code path exists and is exercised indirectly by the handler's own spec, but there is no test pinned to the face-side files themselves.

### Unit Tests (remaining target coverage)

- **`SocialMediaBackfillService`:** per-circle/all-circles counting, `force: true` vs. `force: false` eligibility (status absent or not-`processed`), `enqueueRerun` 404 on missing/deleted item, `getStatus`'s synthetic not-processed shape.
- **Controllers:** RBAC branches (viewer vs. collaborator vs. admin), the `features.socialMediaDetection` 400 guard on rerun and backfill, request DTO validation (`from`/`to` date parsing, `force` default).
- **Gate defensiveness (face-side):** `VideoFaceDetectionHandler` early-return when `socialMediaSource` is non-null; `FaceBackfillService`'s eligibility query excludes flagged videos — both currently exercised only by inspection of the source, not by a pinned test case in those files' own specs.

### Integration Tests (target coverage)

- **Gate-then-fan-out, detected path:** upload a video with a TikTok-signature filename, feature on; verify `social_media_detection` runs, tags are applied, and no `video_face_detection` job is ever created.
- **Gate-then-fan-out, clean path:** upload a video with no social signals, feature on; verify `social_media_detection` classifies clean and a `video_face_detection` job is subsequently enqueued.
- **Feature off:** upload a video with feature off; verify `video_face_detection` is enqueued directly (legacy path), with no `social_media_detection` job created at all.
- **Rerun reclassification:** flag a video, then rerun after changing its filename/tags such that it now classifies clean; verify the system tags are removed, `social_media_source` clears, and `video_face_detection` is fanned out.
- **Backfill `force` semantics:** seed items with and without an existing `processed` `media_social_status` row; verify `force: false` only re-enqueues the missing/non-processed ones and `force: true` re-enqueues all eligible videos.
- **Backfill 400 when disabled:** verify `POST /api/admin/social-media/backfill` returns `400` when `features.socialMediaDetection` is `false`.

### RBAC Tests (target coverage)

- Verify a `viewer` can call the status endpoint but receives `403` on rerun.
- Verify `POST /api/admin/social-media/backfill` and `GET /api/admin/social-media/status` return `403` for a non-admin.

---

## 12. Extension Points and Future Work

| Capability | Notes |
|------------|-------|
| Photo detection | `VideoDetectionInput.kind` is typed as the literal `'video'` specifically so a future `kind: 'photo'` variant (matching against EXIF software tags, screenshot dimensions, or a downloaded-screenshot OCR pass) can be added without breaking the existing type. Not implemented today. |
| New platforms (Snapchat, YouTube Shorts, etc.) | Because both rule catalogs (`METADATA_RULES`, `FILENAME_RULES`) are plain data arrays, adding a platform is a data-only change: add new `DetectionRule` entries with a new `SocialPlatform` value and, if a platform-specific tag is desired, add it to `PLATFORM_TAG`. No control-flow changes required. |
| Review queue / dashboard count | Unlike burst detection, duplicate detection, and location inference, this feature has no review queue and no `GET /api/media/dashboard` count (§6.5) — flagged items are discovered by tag search only. A future version could add a `pendingSocialMediaReview`-style banner if user feedback indicates the tag-search discovery path is not surfacing flagged items prominently enough. |
| Frontend admin settings page | `/admin/settings/social-media` is registered in the Settings hub routing per CLAUDE.md, but as of this specification's version the dedicated settings UI (global toggle, OCR tuning sliders, backfill panel) has not been independently verified against this document — treat the backend API (§6) as the source of truth. |
| Full-file EXIF/metadata stripping for detected videos | Out of scope — detection only tags; it does not modify the underlying file. If a user chooses to keep a flagged video, its original container metadata (including any embedded platform markers) remains untouched. |
| Test coverage | See §11 — no dedicated test file exists yet for any of the five new source files. |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification, documenting the shipped implementation: gate-then-fan-out video routing, two-tier (metadata/filename + OCR) detection engine, `media_social_status` / `social_media_source` / `MediaTagSource.system` data model, settings and env configuration, the four API endpoints, Doctor integration, degraded-mode and precision-over-recall rationale, and known test-coverage gaps |
| 1.1 | July 2026 | AI Assistant | Documented the new Tier-1 caption/hashtag/@mention signal (`detectCaptionSignal`, rules `caption-tt-token`/`caption-ig-token`/`caption-fb-token`/`caption-generic`/`caption-single-hashtag`, numeric-hashtag exclusion guard), the new `heur-caption-mention` suspicion heuristic, the three corresponding Tier-2 OCR platform-token signals (`ocr-tiktok-token`/`ocr-instagram-token`/`ocr-facebook-token`), and the Instagram cross-post detection rationale plus cross-post platform-attribution caveat in §9.2 |
| 1.2 | July 2026 | AI Assistant | New §2.5 pre-flight caps + orientation gate: `socialMedia.maxDurationSeconds` (default 300) and `socialMedia.maxSizeBytes` (default 500 MB) settings and the shared `VIDEO_ENRICHMENT_MAX_BYTES` env cap skip over-long/over-size videos as clean without downloading (`matchedRule: skip-duration-cap` / `skip-size-cap`); strictly-landscape videos are never downloaded (Tier-1-only, no OCR re-probe/OCR). §4.1 `matchedRule` row, §5.1 settings table, §5.2 env table updated |

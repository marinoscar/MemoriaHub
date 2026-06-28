# Social Media Detection — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Detector Registry Model](#2-detector-registry-model)
3. [Signal Sources and Tiered Pipeline](#3-signal-sources-and-tiered-pipeline)
4. [Scoring Table](#4-scoring-table)
5. [System-Tag Protection Matrix](#5-system-tag-protection-matrix)
6. [Data Model](#6-data-model)
7. [Processing and Enrichment Flow](#7-processing-and-enrichment-flow)
8. [Configuration](#8-configuration)
9. [API Endpoints](#9-api-endpoints)
10. [UI](#10-ui)
11. [Security and Privacy](#11-security-and-privacy)
12. [Testing Notes](#12-testing-notes)
13. [How to Add a New Platform](#13-how-to-add-a-new-platform)

---

## 1. Overview and Goals

Family photo libraries frequently contain short video clips saved from social media platforms — TikTok dances, Instagram Reels, Facebook Live clips, WhatsApp forwards. These clips mix poorly with original family footage: they carry watermarks, have compressed quality, and were never shot by the family. Detecting them automatically allows the app to surface them for review, separate them in browse views, and help users decide whether to keep them.

Social media detection identifies these clips and labels them with **protected system tags** (`Social Media`, plus a per-platform refinement such as `TikTok`) so they appear in the existing tag-filter surfaces without any new query infrastructure. The tags are applied by code — they are not user-editable vocabulary entries — and are guarded against accidental removal by any deletion path.

### Goals

- Detect videos saved from TikTok, Instagram, Facebook, and WhatsApp using on-server, zero-cost signals.
- Apply a protected `Social Media` system tag and a per-platform system tag (e.g. `TikTok`) via the existing `media_tags` join table, using the new `source='system'` value.
- Track per-item status in `media_social_status` using the same status lifecycle used by other enrichment features.
- Run as a `social_media_detection` enrichment job on the existing `enrichment_jobs` queue, inheriting standard retry, observability, and admin jobs dashboard support at zero infrastructure cost.
- Apply a broad "re-encoded social media" heuristic (vertical 9:16 aspect + stripped camera metadata + re-encoded container) to catch clips whose platform watermarks have been cropped or burned out, even when no specific platform is identifiable.
- Integrate with the existing tag-filter system (`GET /api/media?tag=Social Media`, `POST /api/search {tag:"TikTok"}`): no new query endpoints are needed.

### Non-Goals

- Detection does not apply to photos. Only `MediaType.video` items are processed.
- Detection does not download or decode full video frames for anything except the optional OCR tier. The primary tiers read only metadata and the filename — no pixel data moves unless OCR is configured.
- The feature does not expose a UI to remove system tags. Users who disagree with a detection should move the clip to a separate circle or delete it entirely.
- Detection does not scan audio tracks for music or voice watermarks.

---

## 2. Detector Registry Model

The detector registry lives at `apps/api/src/social/social-detectors.ts`. It is the single authoritative source for which platforms are supported, what system tag each platform applies, and how to match a set of signals against that platform.

### 2.1 Constants

```typescript
export const SOCIAL_MAIN_TAG = 'Social Media';

export const ALL_SYSTEM_TAG_NAMES: readonly string[] = [
  SOCIAL_MAIN_TAG,
  'TikTok',
  'Instagram',
  'Facebook',
  'WhatsApp',
] as const;
```

`ALL_SYSTEM_TAG_NAMES` is used at startup to upsert `Tag` rows with `is_system = true` for every name in the list. This ensures the rows exist before any detection job runs.

### 2.2 Signal Bag Interface

```typescript
export interface DetectionSignals {
  /** ffprobe format.tags, format.format_name, streams[].codec_name, etc. */
  containerTags: Record<string, string>;
  /** Original filename as provided by the uploader; no directory component. */
  filename: string;
  /** Video width in pixels (from ffprobe streams). */
  width: number;
  /** Video height in pixels (from ffprobe streams). */
  height: number;
  /** Camera make from EXIF (null if absent or re-encoded). */
  cameraMake: string | null;
  /** Camera model from EXIF (null if absent or re-encoded). */
  cameraModel: string | null;
  /** GPS latitude from EXIF (null if absent). */
  lat: number | null;
  /** GPS longitude from EXIF (null if absent). */
  lng: number | null;
  /**
   * OCR text extracted from sampled frames.
   * Undefined when OCR is disabled or has not been attempted yet.
   * Null when OCR ran but produced no usable text.
   */
  ocrText?: string | null;
}
```

### 2.3 PlatformDetector Interface

```typescript
export interface PlatformDetector {
  /** Stable machine key (lower-case, no spaces). Used as the `platform` value in media_social_status. */
  key: string;
  /** System tag name applied to matched items (must appear in ALL_SYSTEM_TAG_NAMES). */
  tagName: string;
  /**
   * Return a confidence score in [0, 1] for this platform.
   * A score >= PLATFORM_MATCH_THRESHOLD (0.6) triggers a positive match.
   * Return 0 when there is no evidence.
   */
  match(signals: DetectionSignals): number;
}
```

### 2.4 detectSocial

```typescript
export function detectSocial(signals: DetectionSignals): {
  detected: boolean;
  platform: string | null;
  score: number;
  tagNames: string[];
} 
```

`detectSocial` runs every registered detector against `signals`. The detector with the highest score is selected. If the winner's score meets or exceeds `PLATFORM_MATCH_THRESHOLD` (0.6), the item is tagged with `SOCIAL_MAIN_TAG` plus the winner's `tagName`. If the generic heuristic (see §3.4) fires but no specific platform is identified, only `SOCIAL_MAIN_TAG` is applied.

---

## 3. Signal Sources and Tiered Pipeline

Detection proceeds in three tiers. Each tier is strictly additive — lower tiers only run when higher tiers have not produced a conclusive score. This keeps the common case (obvious platform metadata) fast and cheap.

### 3.1 Tier 1 — Container Metadata (ffprobe)

The primary signal is the video container's metadata fields as returned by `ffprobe -v quiet -print_format json -show_format -show_streams`. These fields are already present in `StorageObject.metadata._processing['video-probe']` from the upload-time video-probe processor, so Tier 1 requires no additional I/O.

Key fields inspected:

| ffprobe field | TikTok signal | Instagram signal | Facebook signal | WhatsApp signal |
|--------------|--------------|-----------------|-----------------|-----------------|
| `format.tags.encoder` | `ByteDance` / `TikTok` | `Instagram` | — | — |
| `format.tags.major_brand` | `isom` or `mp42` (not conclusive alone) | `mp42` | `MSNV` | — |
| `format.tags.handler_name` | `TikTokHandler` | — | — | — |
| `format.tags.com.android.manufacturer` | — | — | — | present (WhatsApp saves OEM metadata in some versions) |
| `format.tags.location` | — | present on saved Reels | — | — |
| `streams[].codec_name` | `h264`/`hevc` re-encoded | — | — | `opus` audio codec |
| `format.tags.compatible_brands` | `isomiso2avc1mp41` common | — | — | — |

No single field is conclusive. Each detector computes a weighted sum across the fields it knows about and returns a score.

### 3.2 Tier 2 — Filename Pattern

File names sometimes carry platform fingerprints:

| Pattern | Platform |
|---------|----------|
| `tiktok_*.mp4`, `@*.mp4` | TikTok |
| `reel_*.mp4`, `ig_*.mp4` | Instagram |
| `fb_*.mp4`, `facebook_*.mp4` | Facebook |
| `VID-YYYYMMDD-WA\d+.mp4` (case-insensitive) | WhatsApp |

Filename matching is a secondary signal. A filename match alone cannot produce a conclusive score — it raises the total above threshold only when combined with at least weak container evidence.

### 3.3 Tier 3 — OCR of Sampled Frames (Keyless, WASM In-Process)

OCR is attempted only when Tiers 1 and 2 have not produced a conclusive match. It is the most compute-intensive tier but runs entirely in-process using `tesseract.js` with the `eng.traineddata` file bundled in the Docker image — no external call, no API key, and $0/video cost.

**Frame sampling strategy:**

1. The last frame of the video is always sampled (TikTok and Instagram watermarks typically appear in the bottom-right corner of the last frame).
2. Additional frames are sampled evenly from the second half of the video up to `social.ocr.frameCount - 1` additional frames. (Watermarks are more reliably present after the first few seconds of intro graphics.)
3. Each frame is extracted via the ffmpeg integration already present in the video-probe processor.

**Text matching:**

The concatenated OCR text from all sampled frames is searched for:

| Text pattern | Platform |
|-------------|---------|
| `TikTok` (case-insensitive) or `@[a-z0-9_.]+` handle pattern | TikTok |
| `Instagram` or `Reels` (case-insensitive) | Instagram |
| `Facebook` or `Watch` on Facebook branding (case-insensitive) | Facebook |
| — (WhatsApp does not embed visible watermarks) | — |

OCR confidence degrades on compressed video frames. The OCR tier therefore contributes a lower maximum score weight than the container metadata tier, so OCR alone cannot push a low-confidence item above the threshold — it can only tip items that already have weak container evidence.

**`tesseract.js` and offline traineddata:**

`tesseract.js` (v5+) runs the Tesseract OCR engine compiled to WebAssembly, entirely in the Node.js process. The English `eng.traineddata` language file (~4 MB) is bundled in the API Docker image at build time and loaded from the local filesystem — no network call occurs at runtime. This eliminates cloud OCR costs and avoids sending any video frame data outside the server.

### 3.4 Generic Heuristic (Re-encoded Social Clip)

Independently of the platform detectors, a generic heuristic fires when all three of the following conditions are met:

1. **Vertical aspect ratio:** `height / width >= 1.7` (approximately 9:16 portrait orientation).
2. **No camera make/model:** `cameraMake` and `cameraModel` are both null (the camera EXIF was stripped or was never present, as is typical for re-encoded clips).
3. **Re-encoded container:** the `video-probe` codec analysis detects H.264 or HEVC re-encoding artifacts (e.g. `streams[].codec_tag_string` lacks the camera-native codec tag `avc1` with bitrate consistent with direct-from-camera capture).

When the generic heuristic fires but no platform detector reaches threshold, the item receives only `SOCIAL_MAIN_TAG` with `platform = null`. When the heuristic fires alongside a platform match, the platform match is used (the heuristic score is subsumed).

---

## 4. Scoring Table

Each detector computes a score in [0, 1]. The table below describes the weight each signal contributes for each platform.

| Signal | TikTok | Instagram | Facebook | WhatsApp | Generic |
|--------|--------|-----------|----------|----------|---------|
| `encoder` tag matches platform | +0.50 | +0.50 | — | — | — |
| `handler_name` tag matches | +0.30 | — | — | — | — |
| `major_brand` known platform value | +0.10 | +0.10 | +0.30 | — | — |
| `compatible_brands` known pattern | +0.10 | — | — | — | — |
| Android manufacturer tag present | — | — | — | +0.20 | — |
| `opus` audio codec | — | — | — | +0.30 | — |
| Location tag present | — | +0.20 | — | — | — |
| Filename pattern match | +0.15 | +0.15 | +0.15 | +0.40 | — |
| OCR text match | +0.20 | +0.20 | +0.20 | — | — |
| Vertical 9:16 + no camera + re-encoded | — | — | — | — | 1.00 |

Scores are capped at 1.0. `PLATFORM_MATCH_THRESHOLD = 0.6`.

WhatsApp relies heavily on filename (the `VID-YYYYMMDD-WA\d+.mp4` convention is highly distinctive) and the `opus` audio codec (WhatsApp transcodes to Opus, which is unusual in consumer-recorded video). The absence of a WhatsApp OCR tier entry is intentional: the app does not embed visible text watermarks.

---

## 5. System-Tag Protection Matrix

System tags differ from user tags and AI tags in one critical property: **they cannot be removed by any user action**. The table below lists every delete/remove code path and how it is guarded.

| Path | Guard |
|------|-------|
| `DELETE /api/tag-labels/:id` (admin deletes a tag label) | Only deletes `media_tags` rows where `source='ai'`; `source='system'` rows are skipped. |
| `POST /api/media/bulk/tags` with `remove` action | Refuses to remove any tag where the `tags.is_system` flag is true; returns `400` with a list of rejected tag names. |
| `DELETE /api/media/:id/tags/:tagId` (if such a per-item endpoint exists) | Same `is_system` check; `403 Forbidden`. |
| Auto-tagging re-run | Re-run is authoritative only over `source='ai'` rows; never touches `source='system'` rows. |
| `social_media_detection` re-run | Idempotently upserts `source='system'` rows; does not delete existing `source='system'` rows for other platforms. |
| `DELETE /api/tag-labels/:id` cascade | `tag_labels` rows for system-defined tag names are not present in `tag_labels` (system tags are not in the tag vocabulary table); cascade has no effect. |
| Circle deletion (cascade) | `media_tags` rows cascade-delete with the circle — this is expected and correct. |

`Tag.is_system` is a non-nullable Boolean column added to the `tags` table. It defaults to `false`. System tags are seeded (upserted) at API startup by `SocialDetectorBootstrapService.onModuleInit`, which calls `prisma.tag.upsert` for each name in `ALL_SYSTEM_TAG_NAMES` with `is_system: true`. This ensures the rows exist before any enrichment job runs, even in a fresh database.

Because system tags live in the `tags` table (circle-scoped), each circle gets its own `Tag` rows for `Social Media`, `TikTok`, etc. seeded on first use. The `is_system` flag is set on every row regardless of circle.

---

## 6. Data Model

### 6.1 New Table: `media_social_status`

One row per media item. Tracks the status of the most recent `social_media_detection` enrichment job for that item.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `mediaItemId` | UUID | FK → `media_items` (cascade delete); unique — one row per item |
| `circleId` | UUID | FK → `circles` (cascade delete); denormalized for indexed queries |
| `status` | `MediaMetadataStatusType` | Reuses existing enum; default `not_processed` |
| `detected` | Boolean? | `true` = positive platform identification or generic heuristic fired; `false` = no social media detected; `null` = not yet processed |
| `platform` | String? | Matched platform key (e.g. `tiktok`); null when only the generic heuristic fired or item is not processed |
| `score` | Float? | Aggregate confidence score from `detectSocial`; null when not processed |
| `processedAt` | DateTime? | Set when status transitions to `processed` |
| `lastError` | String? | Set when status transitions to `failed` |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

**Indexes:**

- Unique on `media_item_id`
- Index on `circle_id`
- Index on `status`

### 6.2 New Column: `tags.is_system`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `is_system` | Boolean | `false` | True for code-defined system tags; protects rows from user-initiated deletion paths |

### 6.3 Extended Enum: `MediaTagSource`

The `media_tags.source` column is extended from `manual | ai` to `manual | ai | system`:

| Value | Applied by | Authoritative re-run behaviour |
|-------|-----------|-------------------------------|
| `manual` | User | Never overwritten by any enrichment re-run |
| `ai` | Auto-tagging handler | Auto-tagging re-run replaces all `source='ai'` rows for the item |
| `system` | Enrichment detectors (e.g. `social_media_detection`) | Social media re-run upserts its own `source='system'` rows; does not delete other detectors' rows |

No migration is needed to rename existing `manual` or `ai` rows — the enum extension is additive.

---

## 7. Processing and Enrichment Flow

### 7.1 New Enrichment Job: `social_media_detection`

`social_media_detection` is a new job type in the `enrichment_jobs` queue. It is handled by `SocialMediaDetectionHandler` (`apps/api/src/social/social.handler.ts`), which self-registers with `EnrichmentHandlerRegistry` via `onModuleInit`.

**Priority conventions:**

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| Per-item rerun (user) | `rerun` | 0 (highest) |
| On upload (video only) | `upload` | 10 |
| Backfill | `backfill` | 100 (lowest) |

For queue architecture, worker lifecycle, and retry configuration, see [enrichment-queue.md](enrichment-queue.md).

### 7.2 SocialEnqueueListener

`SocialEnqueueListener` listens for `OBJECT_PROCESSED_EVENT` and enqueues a `social_media_detection` job when:

1. `MediaType` is `video`.
2. `mediaItem.deletedAt` is null.
3. `SOCIAL_MEDIA_DETECTION_ENABLED` environment variable is not `'false'`.
4. `features.socialMediaDetection` is `true` in system settings.

### 7.3 SocialMediaDetectionHandler — Step-by-Step

The handler delegates to `SocialMediaDetectionService.processMediaItem(job)`.

**Step 1.** Load `MediaItem` with `storageObject` and `circle`. If the item is not found, deleted, or has no `StorageObject`, mark `media_social_status` as `failed` and return (non-retryable skip).

**Step 2.** Verify `mediaType === 'video'`. Non-video items are marked `processed` with `detected = false` immediately (early-exit, no error).

**Step 3.** Upsert `media_social_status` to `processing`.

**Step 4 (Tier 1 — Container Metadata).** Read `storageObject.metadata._processing['video-probe']` from the JSONB. Extract `containerTags`, `width`, `height`, codec info. Assemble a partial `DetectionSignals` bag. Call `detectSocial(signals)`. If score >= threshold, proceed to Step 7.

**Step 5 (Tier 2 — Filename).** Add the original filename (from `storageObject.originalFilename`) to the signals bag. Call `detectSocial(signals)` again. If score >= threshold, proceed to Step 7.

**Step 6 (Tier 3 — OCR, conditional).** If `social.ocr.enabled` is `true` in system settings and no conclusive score has been reached:

1. Download the video from the storage provider (streaming, not fully buffered — the video is piped through ffmpeg for frame extraction without writing to disk).
2. Extract up to `social.ocr.frameCount` frames at the configured sample points.
3. Run `tesseract.js` on each frame JPEG. Concatenate all output text.
4. Add `ocrText` to the signals bag.
5. Call `detectSocial(signals)`.

**Step 7 (Generic Heuristic).** Evaluate the generic heuristic independently of the platform detectors (see §3.4). If the heuristic fires and the platform score is below threshold, set `tagNames = [SOCIAL_MAIN_TAG]` with `platform = null`.

**Step 8 (Apply Tags).** If `detected = true`:

1. Resolve or create the circle-scoped `Tag` rows for each name in `tagNames` with `is_system = true`.
2. Upsert `media_tags` rows with `source = 'system'` for each tag. Use `skipDuplicates` to remain idempotent.

**Step 9.** Upsert `media_social_status` with final state: `status = 'processed'`, `detected`, `platform`, `score`, `processedAt = now()`.

On any uncaught error, mark status `failed` with `lastError` and re-throw so the worker applies standard retry logic.

**Idempotency:** re-running the handler for the same item is safe. Step 8 uses upsert with `skipDuplicates`; Step 9 overwrites the status row. No duplicate tags or status rows are created.

---

## 8. Configuration

### 8.1 System Settings (Admin-Editable)

| Setting key | Type | Range | Default | Description |
|-------------|------|-------|---------|-------------|
| `features.socialMediaDetection` | boolean | — | `false` | Global on/off toggle; also gated by env `SOCIAL_MEDIA_DETECTION_ENABLED` |
| `social.ocr.enabled` | boolean | — | `true` | Enable/disable the OCR tier; when false, detection relies on metadata and filename only |
| `social.ocr.frameCount` | integer | 1–10 | 3 | Number of video frames sampled for OCR |

Settings are stored in the `system_settings` JSONB column and are editable via `/admin/settings/social`.

### 8.2 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOCIAL_MEDIA_DETECTION_ENABLED` | `true` | Environment kill-switch. Set to `false` to disable `SocialEnqueueListener` regardless of system settings. The system setting `features.socialMediaDetection` is the runtime on/off toggle; this env var is a hard override for CI/test environments. |

---

## 9. API Endpoints

All endpoints require JWT Bearer authentication. No new RBAC permissions are introduced — the feature reuses `media:read` and `media:write` combined with per-circle viewer and collaborator roles.

### 9.1 Per-Item Rerun

#### `POST /api/media/:id/social/rerun`

Re-enqueue social media detection for a single video.

- **Auth:** `media:write` + per-circle `collaborator` role (or `media:write_any` for admin bypass)
- **Path param:** `id` — UUID of the media item
- **Request body:** none
- **Response `201`:**
  ```json
  {
    "data": {
      "jobId": "uuid",
      "status": "pending"
    }
  }
  ```
  The job is enqueued at priority 0 (highest). `media_social_status` is upserted to `pending` immediately. Computation is asynchronous — poll `GET /api/media/:id/social/status`.
- **Response `404`:** Item not found or soft-deleted.
- **Response `403`:** Caller is not a `collaborator` in the item's circle.

### 9.2 Per-Item Status

#### `GET /api/media/:id/social/status`

Get the current social media detection status for a single item.

- **Auth:** `media:read` + per-circle `viewer` role (or `media:read_any` for admin bypass)
- **Path param:** `id` — UUID of the media item
- **Response `200`:**
  ```json
  {
    "data": {
      "status": "processed",
      "detected": true,
      "platform": "tiktok",
      "processedAt": "2026-06-28T10:15:00.000Z",
      "lastError": null
    }
  }
  ```
  When no `media_social_status` row exists, `status` is `"not_processed"` and all other fields are `null`.
- **Response `404`:** Item not found or soft-deleted.

### 9.3 Global Backfill (Admin)

#### `POST /api/admin/social/backfill`

Bulk-enqueue `social_media_detection` jobs for videos across **all circles**.

- **Auth:** Admin role + `system_settings:write`
- **Requirement:** `features.socialMediaDetection` must be `true`; otherwise returns `400`.
- **Request body:**
  ```json
  {
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-12-31T23:59:59.999Z",
    "force": false
  }
  ```
  `from` and `to` are optional ISO-8601 bounds on `capturedAt`. `force = false` (default) skips items whose `media_social_status.status` is already `processed`. `force = true` re-enqueues all non-deleted videos in scope.
- **Response `201`:**
  ```json
  {
    "data": { "enqueued": 87, "circles": 3 }
  }
  ```
- **Error cases:**
  - `400` — `features.socialMediaDetection` is `false`
  - `400` — `from` is later than `to`

### 9.4 Platform Registry (Admin)

#### `GET /api/admin/social/detectors`

Return the read-only platform registry. Useful for auditing which platforms are supported without reading source code.

- **Auth:** Admin role + `system_settings:read`
- **Response `200`:**
  ```json
  {
    "data": {
      "mainTag": "Social Media",
      "platforms": [
        { "key": "tiktok",    "tagName": "TikTok" },
        { "key": "instagram", "tagName": "Instagram" },
        { "key": "facebook",  "tagName": "Facebook" },
        { "key": "whatsapp",  "tagName": "WhatsApp" }
      ]
    }
  }
  ```

---

## 10. UI

### 10.1 Admin Settings — Social Media Detection (`/admin/settings/social`)

The admin settings sub-page at `/admin/settings/social` provides:

- **Feature toggle:** writes `features.socialMediaDetection` to system settings. When disabled, the OCR and backfill controls are grayed out.
- **OCR settings:** a toggle for `social.ocr.enabled` and a numeric field for `social.ocr.frameCount` (1–10).
- **Platform registry:** a read-only table showing the detector list returned by `GET /api/admin/social/detectors`. This helps admins understand what platforms are covered without reading source code.
- **Global backfill panel:** optional `from`/`to` date range pickers, a `force` checkbox, and a Run button that calls `POST /api/admin/social/backfill` and displays `{ enqueued, circles }`.

### 10.2 Media Properties Pane

The media detail drawer (for videos) shows the detection status from `GET /api/media/:id/social/status`. When `detected = true`, the applied system tags appear in the tag list with a lock icon to indicate they cannot be removed. A "Re-run detection" button is visible to collaborators and calls `POST /api/media/:id/social/rerun`.

### 10.3 Tag Filter Integration

Because system tags are stored as regular `media_tags` rows, all existing tag-filter surfaces work without modification:

- `GET /api/media?tag=Social+Media` returns all tagged videos.
- `GET /api/media?tag=TikTok` returns only TikTok-detected items.
- `POST /api/search { "tag": "Instagram" }` works in deterministic search.
- The agentic search `search_media` tool accepts `tag` — the AI can naturally respond to "show me TikTok videos."
- The Explore → Tags surface lists `Social Media`, `TikTok`, etc. with cover thumbnails.

---

## 11. Security and Privacy

### All Processing Is On-Server

Tier 1 reads metadata that is already in the database (no new I/O). Tier 2 reads the filename stored in `storage_objects`. Tier 3 (OCR) extracts frames via ffmpeg and runs them through `tesseract.js` WASM entirely within the API process. No video frames, no filenames, and no container metadata leave the server.

### No New Credentials Required

`tesseract.js` is keyless. The `eng.traineddata` file is bundled in the Docker image at build time. The feature introduces no new third-party service dependency.

### System Tag Immutability

System tags are protected at the application layer (see §5). Even an Admin cannot remove a `source='system'` tag via the API — the guard is enforced in the service layer, not just the UI. The only way to remove a system tag is to delete the media item itself, which is an intentional and auditable action.

### Feature Gating

`features.socialMediaDetection` defaults to `false`. No video is processed until an Admin explicitly enables the feature. The env kill-switch `SOCIAL_MEDIA_DETECTION_ENABLED=false` provides an additional override for CI/test environments.

---

## 12. Testing Notes

### Unit Tests

- **`detectSocial`:** provide a `DetectionSignals` bag with known TikTok `encoder` metadata; verify score >= 0.6 and `tagNames` includes `TikTok` and `Social Media`.
- **No false positive on clean video:** provide signals with no social signals; verify `detected = false`, `tagNames = []`.
- **Generic heuristic only:** provide vertical + no camera + re-encoded signals with no platform match; verify `detected = true`, `tagNames = [SOCIAL_MAIN_TAG]`, `platform = null`.
- **OCR signal:** provide partial container signals and OCR text containing `"TikTok @username"`; verify score tips over threshold and platform is `tiktok`.
- **Filename match:** verify WhatsApp filename `VID-20260628-WA0042.mp4` raises WhatsApp score.
- **Score cap:** verify that stacking all signals for one platform caps at 1.0.

### Integration Tests

- **Full pipeline:** upload a mock video with TikTok container metadata; run the `social_media_detection` job; verify `media_social_status` transitions `pending → processing → processed` with `detected = true`, `platform = 'tiktok'`; verify `media_tags` has rows for both `Social Media` and `TikTok` with `source = 'system'`.
- **Idempotency:** run the handler twice for the same item; verify no duplicate `media_tags` rows are created.
- **Non-video early exit:** seed a photo item; run the job; verify `detected = false`, `status = processed`, no tags applied.
- **`is_system` protection — bulk remove:** call `POST /api/media/bulk/tags` to remove `TikTok`; verify `400` response with rejection list.
- **`is_system` protection — tag-label cascade:** call `DELETE /api/tag-labels/:id` for a system tag name; verify `media_tags` rows with `source = 'system'` are not deleted.
- **Backfill — basic:** call `POST /api/admin/social/backfill` with `force: false`; verify already-processed items are not re-enqueued.
- **Backfill — 400 when disabled:** verify `400` when `features.socialMediaDetection = false`.
- **OCR disabled:** set `social.ocr.enabled = false`; verify Tier 3 is not invoked (mock ffmpeg extraction and assert it is never called).

### RBAC Tests

- Verify a viewer can call `GET /api/media/:id/social/status` but receives `403` on `POST /api/media/:id/social/rerun`.
- Verify a collaborator can call `POST /api/media/:id/social/rerun`.
- Verify `POST /api/admin/social/backfill` and `GET /api/admin/social/detectors` return `403` for non-admins.
- Verify a non-member receives `403` on per-item endpoints.

---

## 13. How to Add a New Platform

Adding support for a new social media platform (e.g. Twitter/X) requires **one code change** and no database migration.

### Step 1 — Append to `ALL_SYSTEM_TAG_NAMES`

```typescript
// apps/api/src/social/social-detectors.ts

export const ALL_SYSTEM_TAG_NAMES: readonly string[] = [
  SOCIAL_MAIN_TAG,
  'TikTok',
  'Instagram',
  'Facebook',
  'WhatsApp',
  'Twitter',   // <-- add here
] as const;
```

`SocialDetectorBootstrapService.onModuleInit` will upsert a `Tag` row with `is_system = true` for `'Twitter'` on the next server start.

### Step 2 — Implement a PlatformDetector

```typescript
// apps/api/src/social/social-detectors.ts

const twitterDetector: PlatformDetector = {
  key: 'twitter',
  tagName: 'Twitter',
  match(signals: DetectionSignals): number {
    let score = 0;
    // Twitter/X app saves videos with a distinctive filename pattern
    if (/^[A-Z0-9]{10,}\.mp4$/i.test(signals.filename)) score += 0.15;
    // Container encoder may reference Twitter
    if (/twitter/i.test(signals.containerTags['encoder'] ?? '')) score += 0.50;
    // OCR: look for the X logo text or twitter.com watermark
    if (signals.ocrText && /\btwitter\.com\b|@\w+\s+on\s+[Xx]\b/i.test(signals.ocrText)) {
      score += 0.20;
    }
    return Math.min(score, 1);
  },
};
```

### Step 3 — Register the Detector

```typescript
// apps/api/src/social/social-detectors.ts

export const PLATFORM_DETECTORS: readonly PlatformDetector[] = [
  tiktokDetector,
  instagramDetector,
  facebookDetector,
  whatsappDetector,
  twitterDetector,   // <-- add here
];
```

That is the entire change. No new endpoints, no migration, no new service wiring. The next `social_media_detection` job that runs will include the new detector, and `GET /api/admin/social/detectors` will return the new platform in its list.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |

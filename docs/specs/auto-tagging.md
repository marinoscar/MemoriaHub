# AI Auto-Tagging — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview and User-Facing Behavior](#1-overview-and-user-facing-behavior)
2. [Architecture and Data Flow](#2-architecture-and-data-flow)
3. [Data Model](#3-data-model)
4. [Provider and Vision Integration](#4-provider-and-vision-integration)
5. [Configuration and Environment Variables](#5-configuration-and-environment-variables)
6. [API Endpoints](#6-api-endpoints)
7. [Operations](#7-operations)

---

## 1. Overview and User-Facing Behavior

AI auto-tagging automatically assigns descriptive tags to uploaded photos using a vision language model. The model evaluates each photo against a **global vocabulary** of tag labels managed by the admin, then adds matching labels as regular circle-scoped tags.

**Core capabilities:**

- Tag photos automatically on upload when opted in per circle (default off).
- Use any configured AI provider (Anthropic, OpenAI) with admin-selected model.
- Draw only from an admin-defined global vocabulary — the model cannot invent labels.
- Allow circle collaborators to trigger a per-item re-run from the media drawer.
- Allow admins to backfill existing photos in a circle, with optional date-range scoping and a force flag to reprocess already-tagged items.
- Track per-item status (`not_processed`, `pending`, `processing`, `processed`, `failed`) for monitoring and UI display.

Auto-tagging is deliberately decoupled from the synchronous upload path. Uploads complete immediately; image analysis runs in the background via the generic `enrichment_jobs` queue. See **[docs/specs/enrichment-queue.md](enrichment-queue.md)** for the full queue architecture.

---

## 2. Architecture and Data Flow

### Upload Path

```mermaid
flowchart TD
    A[File uploaded and processed] -->|OBJECT_PROCESSED_EVENT| B[TaggingEnqueueListener]
    B -->|AUTO_TAG_ENABLED != false| C{circle.autoTaggingEnabled?}
    C -->|No| D[Skip — log and return]
    C -->|Yes| E[EnrichmentJobService.enqueue type=auto_tagging priority=20 reason=upload]
    E --> F[(enrichment_jobs table)]
    E --> G[Upsert MediaTagStatus → pending]
    F -->|poll every ENRICHMENT_JOB_POLL_MS| H[EnrichmentJobWorker]
    H -->|atomic claim| I[AutoTaggingHandler.process]
    I --> J[AutoTaggingService.processMediaItem]
    J --> K[Read system_settings ai.features.tagging]
    K --> L[Load enabled TagLabels]
    L --> M[Download + prepareImageForProcessing]
    M --> N[AiProvider.analyzeImage — vision model call]
    N --> O[Parse JSON array response]
    O --> P[Case-insensitive vocabulary validation]
    P --> Q[Upsert Tag + MediaTag rows per validated label]
    Q --> R[Upsert MediaTagStatus → processed]
    J -->|on error| S[Upsert MediaTagStatus → failed; rethrow for worker retry]
```

### Priority Ordering

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| Per-item re-run | `rerun` | 0 (highest) |
| On upload | `upload` | 20 |
| Backfill | `backfill` | 100 (lowest) |

The worker claims jobs ordered by `priority ASC, createdAt ASC`, so re-runs process before fresh uploads, which process before backfill work.

### Idempotent Enqueue

`EnrichmentJobService.enqueue` checks for an existing `pending` or `running` job with the same `type` + `mediaItemId` before inserting. If one exists, it returns the existing job without creating a duplicate.

### Worker Retry Logic

The `EnrichmentJobWorker` retries failed jobs up to **3 attempts** total (`MAX_ATTEMPTS = 3`). If `AutoTaggingService.processMediaItem` throws (e.g. transient provider error), the worker resets the job to `pending` for the next tick. After the third failure the job is marked `failed` and will not auto-retry. Manual retry is available via `/admin/jobs`.

Failures that are not retryable — missing media item, wrong media type, provider/model not configured, credential resolution error — are detected early in `processMediaItem`, the status row is set to `failed` with `lastError`, and the function returns normally without throwing (so the worker marks the job `succeeded` and does not retry).

---

## 3. Data Model

### `tag_labels` — Global Vocabulary

The admin-managed list of labels the AI may assign. Unique globally (not per-circle).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | String UNIQUE | Case-sensitive canonical label |
| `description` | String? | Optional human description |
| `enabled` | Boolean | Default `true`; disabled labels are excluded from prompts |
| `created_at` | Timestamptz | |
| `updated_at` | Timestamptz | |

### `media_tag_status` — Per-Item Processing Status

One row per `media_item`, tracking where the item is in the pipeline.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `media_item_id` | UUID UNIQUE | FK → `media_items` (cascade delete) |
| `circle_id` | UUID | FK → `circles` (cascade delete) |
| `status` | `MediaTagStatusType` | See enum below |
| `provider_key` | String? | Provider that last processed this item |
| `model_version` | String? | Model that last processed this item |
| `tag_count` | Int | Number of tags assigned by the last successful run |
| `processed_at` | Timestamptz? | Timestamp of last successful completion |
| `last_error` | String? | Error message from the last failed attempt |
| `created_at` | Timestamptz | |
| `updated_at` | Timestamptz | |

**`MediaTagStatusType` enum values:**

| Value | Meaning |
|-------|---------|
| `not_processed` | No job has ever been enqueued (returned as a virtual default — no DB row exists) |
| `pending` | Job is in the queue waiting to run |
| `processing` | Worker has claimed the job and is actively running |
| `processed` | Completed successfully; `tag_count` reflects the result |
| `failed` | All attempts exhausted or non-retryable error; see `last_error` |

### `Circle.auto_tagging_enabled`

Boolean column on the `circles` table (default `false`). When `false`, `TaggingEnqueueListener` skips enqueueing for photos uploaded to that circle, and `POST /api/tagging/backfill` rejects the request with `400 Bad Request`.

### AI Tagging Feature Setting

Stored as a nested path in the `system_settings` JSONB column under the key `global`:

```json
{
  "ai": {
    "features": {
      "tagging": {
        "provider": "anthropic",
        "model": "claude-opus-4-5"
      }
    }
  }
}
```

Set via `PUT /api/ai/features/tagging`. Read by `AutoTaggingService` at job-processing time.

### Tag Storage

AI-assigned tags are stored as `tags` and `media_tags` rows. The `media_tags.source` column (`MediaTagSource` enum: `manual` | `ai`, default `manual`) distinguishes who applied the tag. The `tags.added_by_id` is set to the media item's `added_by_id` (the uploader), not a system account.

Tag name uniqueness is enforced per `(circle_id, name)`.

### Tag Sources and Reconciliation

Every `MediaTag` row carries a `source` value:

| Value | Set by | Protected from AI reconciliation? |
|-------|--------|----------------------------------|
| `ai` | Auto-tagging service | No — AI re-runs may remove it |
| `manual` | User tag operations (`attachTags`, `bulkTags` add) | Yes — never touched by AI |

**AI tagging is authoritative over its own tags.** Each auto-tagging run opens a transaction that:
1. Deletes all `source='ai'` `MediaTag` rows for the item whose tag name is no longer in the model's current output.
2. Upserts the current output labels with `source='ai'` — but never downgrades an existing `manual` tag to `ai` (the upsert `update` is a no-op on conflict).

This means:
- Re-running auto-tagging reflects the model's current judgment exactly: stale AI labels are removed, new ones are added.
- An empty model response removes all AI tags from the item.
- Vocabulary deletes/renames are reflected on the next re-run (AI tags for the old name are pruned when the name no longer appears in the output).

**Manual operations promote AI tags.** When a user manually adds a tag that already exists as `source='ai'` on the same item, `attachTags` and `bulkTags` set `source='manual'` on the existing row. The tag is then permanently protected from future AI reconciliation, even if the model stops returning that label.

**Deleting a vocabulary label strips its AI-applied instances immediately.** `TagLabelsService.remove` runs a transaction that deletes the `TagLabel` row, then deletes all `source='ai'` `MediaTag` rows matching the label name (case-insensitive) across all circles, then cleans up any now-empty `Tag` rows. Manual instances of that same name are preserved.

---

## 4. Provider and Vision Integration

### `AiProvider.analyzeImage`

```typescript
interface AnalyzeImageRequest {
  model: string;
  system?: string;
  prompt: string;
  /** Raw base64-encoded image data — no `data:` URI prefix. */
  imageBase64: string;
  /** MIME type, e.g. 'image/jpeg' */
  mimeType: string;
}

interface AiProvider {
  analyzeImage(creds: AiProviderCredentials, req: AnalyzeImageRequest): Promise<string>;
}
```

`analyzeImage` is a non-streaming, single-turn vision call. It returns the model's full text response as a string. The caller is responsible for JSON-parsing the response.

### Provider Implementations

| Provider | Implementation |
|----------|---------------|
| `anthropic` | `client.messages.create` with `max_tokens: 1024`; image sent as `base64` source block; system prompt passed as top-level `system` field |
| `openai` | `client.chat.completions.create` with `max_tokens: 1024`; image sent as `image_url` with `data:` URI in the user message; system prompt as a `system` role message |

### Prompt Design

**System prompt** (fixed):
> You are an image analysis assistant. Your job is to identify which labels from a provided list apply to the given image. Respond with ONLY a JSON array of strings — no explanation, no code fences, no extra text. Each string must exactly match one of the labels in the provided list. Return an empty array if none apply.

**User prompt** (constructed per job):
```
Analyze this image and return a JSON array of applicable labels from the following allowed list.
Only choose labels that clearly apply. Return ONLY the JSON array.

Allowed labels:
<label1>
<label2>
...

Example response: ["label1", "label2"]
```

Only `enabled` tag labels are included in the allowed list, sorted alphabetically by name.

### Response Parsing and Validation

The raw response string is cleaned of any Markdown code fences, then the first JSON array (`[...]`) is extracted with a regex. The parsed array is filtered to strings only.

Validation is **case-insensitive**: each returned label is matched against the allowed set after lowercasing both sides. Unknown labels are silently dropped. Matching labels are then normalized back to their canonical casing as stored in `tag_labels.name`.

Duplicate labels in the model response are deduplicated before upsert.

### Image Preprocessing and Provider Limits

#### Preprocessing pipeline

Before calling the vision model, the downloaded image passes through three steps in order:

1. **EXIF-orientation correction** — `prepareImageForProcessing` calls `sharp().rotate()` so portrait photos stored sideways are upright before analysis.
2. **Downscale to fit `TAG_MAX_IMAGE_DIM`** — the long edge is constrained to `TAG_MAX_IMAGE_DIM` px (default **1568**) using `fit: 'inside'` with `withoutEnlargement: true`. Images already smaller than the limit are not upscaled.
3. **Re-encode to JPEG at quality 90** — the output is always `image/jpeg`, regardless of the original format.

This normalizes orientation, format, and dimensions before anything reaches the provider.

#### Provider image limits

The following are as-of-implementation provider constraints; verify against current provider documentation if exact numbers matter.

**Anthropic (Claude):**
- Supported formats: JPEG, PNG, GIF, WebP. HEIC and TIFF are not supported.
- Per-image data limit: approximately 5 MB.
- Images with a long edge exceeding 1568 px are auto-downscaled server-side, so 1568 px is the effective sweet spot — sending larger images costs more tokens without improving quality.
- Token cost scales roughly with pixel area (~(w × h) / 750 tokens).

**OpenAI (GPT vision models):**
- Supported formats: JPEG, PNG, WebP, non-animated GIF.
- Per-image byte cap is larger than Anthropic's; the 4.5 MB code constant provides a safe upper bound for both providers.
- OpenAI applies internal resizing depending on the `detail` mode; vision token cost scales with image size.

#### Hardening and failure handling

The service implements three safeguards that produce a non-retryable `failed` status rather than letting an unprocessable image occupy retry slots:

**Happy path:** `prepareImageForProcessing` succeeds (returns `width > 0`). The prepared JPEG buffer is sent as `image/jpeg`.

**Fallback path (sharp could not decode):** `prepareImageForProcessing` returns `width: 0`, indicating a sharp failure (e.g. HEIC, corrupt file, unsupported format). The original bytes' MIME type is sniffed via `detectImageMime`, which checks magic bytes for JPEG, PNG, GIF, and WebP.
- If the detected MIME is `null` (HEIC, TIFF, or unknown) → status is set to `failed` with a clear `lastError`; the job is **not** retried.
- If the detected MIME is a supported type → the original bytes are sent with the **detected** MIME type. This fixes a previous bug where the fallback always set `image/jpeg` regardless of actual content.

**Byte-size cap:** After selecting the buffer (prepared or fallback), if `buffer.length > MAX_IMAGE_BYTES` (4,500,000 bytes — roughly 4.5 MB, giving headroom under Anthropic's ~5 MB limit) → status is set to `failed` with a size error; the job is **not** retried. `MAX_IMAGE_BYTES` is a code constant and is not configurable via environment variables.

All of the above non-retryable failures surface as `media_tag_status = failed` with a human-readable `lastError`, and they appear in the `/admin/jobs` dashboard under `type=auto_tagging`.

---

## 5. Configuration and Environment Variables

### Auto-Tagging Specific

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_TAG_ENABLED` | `true` | Global kill-switch. Set to `false` to disable auto-enqueue on upload for all circles. Per-circle opt-in still applies when `true`. |
| `TAG_MAX_IMAGE_DIM` | `1568` | Maximum image long-edge in pixels before downscaling prior to the vision model call. 1568 matches Anthropic's auto-downscale threshold. |

`MAX_IMAGE_BYTES` (4,500,000) is a code constant — not an environment variable. It caps the byte size of the image buffer sent to the provider; items exceeding it are marked `failed` without retry.

### Shared Enrichment Worker Variables

These are also used by face detection and any future enrichment handlers:

| Variable | Default | Description |
|----------|---------|-------------|
| `ENRICHMENT_WORKER_ENABLED` | `true` | Set to `false` to disable the `EnrichmentJobWorker` entirely (useful in CI). Also respects legacy alias `FACE_WORKER_ENABLED`. |
| `ENRICHMENT_JOB_POLL_MS` | `5000` | Worker polling interval in milliseconds. Also respects legacy alias `FACE_JOB_POLL_MS`. |
| `ENRICHMENT_WORKER_CONCURRENCY` | `1` | Number of jobs to claim and process per tick. Also respects legacy alias `FACE_WORKER_CONCURRENCY`. |

### Admin Configuration Steps

1. Go to `/admin/ai-settings` and configure an AI provider credential (Anthropic or OpenAI API key).
2. In the "Tagging Feature" section of the same page, select the provider and model, then save. This writes to `system_settings.ai.features.tagging`.
3. Go to `/admin/tags` to manage the global tag vocabulary. Add labels, set descriptions, and toggle enabled/disabled state.
4. On the circle detail page, enable auto-tagging for the circles where it should run.
5. Optionally, go to `/admin/tags` and run a backfill to tag existing photos in a circle.

---

## 6. API Endpoints

All endpoints require JWT Bearer authentication unless stated otherwise.

### AI Settings — Tagging Feature (Admin only)

#### `PUT /api/ai/features/tagging`

Set the active AI provider and model for the tagging feature.

- **Auth**: Admin role + `ai_settings:write`
- **Request body**:
  ```json
  { "provider": "anthropic", "model": "claude-opus-4-5" }
  ```
  Both fields accept `null` to clear the setting.
- **Response** `200`:
  ```json
  { "provider": "anthropic", "model": "claude-opus-4-5" }
  ```

---

### Tag Label Vocabulary (Admin only)

#### `GET /api/tag-labels`

List all tag labels (enabled and disabled).

- **Auth**: `ai_settings:read`
- **Response** `200`:
  ```json
  {
    "data": [
      { "id": "...", "name": "beach", "description": "Sand and water scenes", "enabled": true, "createdAt": "...", "updatedAt": "..." }
    ]
  }
  ```

#### `POST /api/tag-labels`

Create a new tag label.

- **Auth**: `ai_settings:write`
- **Request body**:
  ```json
  { "name": "beach", "description": "Optional description" }
  ```
- **Response** `201`: `{ "data": { ...label } }`
- **Response** `409`: Name already exists.

#### `PATCH /api/tag-labels/:id`

Update an existing tag label.

- **Auth**: `ai_settings:write`
- **Request body** (all fields optional):
  ```json
  { "name": "beach", "description": "Updated description", "enabled": false }
  ```
- **Response** `200`: `{ "data": { ...label } }`
- **Response** `404`: Label not found.
- **Response** `409`: Name conflict.

#### `DELETE /api/tag-labels/:id`

Delete a tag label. Removes all AI-applied `MediaTag` instances for the label name (case-insensitive) across all circles and cleans up now-empty `Tag` rows. Manual tag instances of the same name are preserved.

- **Auth**: `ai_settings:write`
- **Response** `204`: No content.
- **Response** `404`: Label not found.

---

### Per-Item Tagging (Circle-scoped)

#### `POST /api/media/:id/tags/rerun`

Re-enqueue auto-tagging for a specific media item. Enqueues at priority 0 (highest). Sets `media_tag_status` to `pending`.

- **Auth**: `media:write` + per-circle `collaborator` role
- **Response** `201`:
  ```json
  { "data": { "jobId": "...", "status": "pending" } }
  ```
- **Response** `404`: Media item not found or soft-deleted.

#### `GET /api/media/:id/tags/status`

Get the current auto-tagging status for a media item.

- **Auth**: `media:read` + per-circle `viewer` role
- **Response** `200`:
  ```json
  {
    "data": {
      "status": "processed",
      "tagCount": 3,
      "providerKey": "anthropic",
      "modelVersion": "claude-opus-4-5",
      "processedAt": "2026-06-01T12:00:00Z",
      "lastError": null
    }
  }
  ```
  If no status row exists, returns `status: "not_processed"` with all other fields `null`.

---

### Backfill

#### `POST /api/tagging/backfill`

Queue auto-tagging jobs for photos in a circle that have not yet been processed (or all photos when `force: true`).

- **Auth**: `media:write` + per-circle `collaborator` role
- **Requirement**: `circle.autoTaggingEnabled` must be `true`, otherwise returns `400 Bad Request`.
- **Request body**:
  ```json
  {
    "circleId": "uuid",
    "from": "2025-01-01T00:00:00Z",
    "to": "2026-01-01T00:00:00Z",
    "force": false
  }
  ```
  `from`, `to`, and `force` are optional. `from`/`to` filter by the photo's date. When `force` is `false` (default), only items without a `processed` status are enqueued.
- **Response** `201`:
  ```json
  { "data": { "enqueued": 47 } }
  ```

---

### Circle Tagging Settings

#### `GET /api/circles/:id/tagging-settings`

Get the per-circle auto-tagging opt-in flag.

- **Auth**: `circles:read` + per-circle `viewer` role
- **Response** `200`:
  ```json
  { "autoTaggingEnabled": false }
  ```

#### `PUT /api/circles/:id/tagging-settings`

Enable or disable auto-tagging for a circle. Writes an audit event.

- **Auth**: `circles:write` + per-circle `circle_admin` role (or `circles:manage_any` for super-admin bypass)
- **Request body**:
  ```json
  { "enabled": true }
  ```
- **Response** `200`:
  ```json
  { "autoTaggingEnabled": true }
  ```

---

## 7. Operations

### Monitoring

The `auto_tagging` job type appears automatically in `/admin/jobs` queue stats under `byType` once the first job is enqueued. Use the existing job dashboard to:

- View counts by status (`pending`, `running`, `succeeded`, `failed`).
- Filter the job list to `type=auto_tagging`.
- Retry individual failed jobs or bulk-retry all failed `auto_tagging` jobs.
- Reset jobs stuck in `running` state past a configurable threshold.

### Failure Modes

| Cause | Behavior |
|-------|---------|
| `AUTO_TAG_ENABLED=false` | Listener skips enqueue silently at startup; no status row created |
| `circle.autoTaggingEnabled=false` | Listener skips enqueue silently; no status row created |
| Media item not found or soft-deleted | Status → `failed`; job succeeds (no retry) |
| Media item is not a photo | Status → `failed`; job succeeds (no retry) |
| Provider or model not configured in system settings | Status → `failed`; job succeeds (no retry) |
| Credential resolution error (provider not in DB or disabled) | Status → `failed`; job succeeds (no retry) |
| No enabled tag labels | Status → `processed` with `tagCount=0`; job succeeds |
| Provider API error (transient) | Status → `failed`; job rethrows; worker retries up to 3 attempts total |
| All labels returned by model fail vocabulary validation | Status → `processed` with `tagCount=0`; no tags assigned |
| Image preprocessing failed + MIME unrecognized (e.g. HEIC, TIFF, corrupt) | Status → `failed`; job succeeds (no retry) |
| Image preprocessing failed + MIME recognized (JPEG/PNG/GIF/WebP) | Original bytes sent with detected MIME; processing continues |
| Image buffer exceeds `MAX_IMAGE_BYTES` (4.5 MB) after preprocessing | Status → `failed`; job succeeds (no retry) |

### Adding New AI Providers

Any provider that implements `AiProvider` (including `analyzeImage`) is automatically available for selection in the tagging feature config. Register the provider in `AiProviderRegistry` following the same pattern as `anthropic` and `openai`.

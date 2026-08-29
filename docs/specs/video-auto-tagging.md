# Video AI Auto-Tagging — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Implemented (epic #452) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [The resource ceiling](#2-the-resource-ceiling)
3. [Why a separate job type](#3-why-a-separate-job-type)
4. [Pipeline](#4-pipeline)
5. [The prompt contract](#5-the-prompt-contract)
6. [Transcription](#6-transcription)
7. [Streaming input](#7-streaming-input)
8. [Enqueue paths](#8-enqueue-paths)
9. [Workflow integration](#9-workflow-integration)
10. [Node compute](#10-node-compute)
11. [Data model](#11-data-model)
12. [API surface](#12-api-surface)
13. [Settings reference](#13-settings-reference)
14. [RBAC](#14-rbac)
15. [Rejected alternatives](#15-rejected-alternatives)

**Related specs:** [AI Auto-Tagging](auto-tagging.md) (the photo path, whose persist half this shares) · [Semantic Search](semantic-search.md) · [Face Recognition](face-recognition.md) (video frame sampling) · [Workflow Automation](workflows.md) · [Distributed Nodes](distributed-nodes.md)

---

## 1. Overview

AI auto-tagging was photo-only. `AutoTaggingService.processMediaItem` hard-failed any video, and the consequences compounded:

- Videos carried no `description` and no AI tags.
- Videos never got a `media_item_embedding` row, so they were **invisible to semantic search** — `semanticQuery` could never return a video.
- Every workflow condition over `tags`, `untagged`, or description was permanently false for videos.
- `POST /api/media/bulk/tags/rerun` had no type filter, so selecting a video and choosing "Re-run AI tagging" — an action the UI offered — produced a failed job.

Videos are a large and growing share of a family library, and they are exactly the memories a text search is most likely to be reaching for ("the video where the kids sing happy birthday").

`video_auto_tagging` samples a bounded number of frames, optionally transcribes the opening seconds of audio, makes **one** multi-image AI call, and writes into the *existing* tag / description / embedding surfaces.

Gated behind `features.autoTagging` (master) **and** `autoTagging.video.enabled` (default **off**), with the `AUTO_TAG_ENABLED` env kill-switch overriding both. An existing deployment upgrading sees **zero new spend and zero new job rows** until an admin opts in.

---

## 2. The resource ceiling

**This is the load-bearing design constraint.** A 3-hour video must never cost thousands of frames or hours of transcription. Three independent costs, each separately bounded, **none scaling with video duration**:

| Cost | Bound | How |
|---|---|---|
| **Frames** | `autoTagging.video.maxFrames` (default 6) | `computeSeekTimestamps` uses `interval = max(sampleIntervalSeconds, durationSec / maxFrames)`, so six frames come out of a 30-second clip **and** a 3-hour video. |
| **Transcription** | `transcription.leadSeconds` (default 30) | ffmpeg `-t 30` on audio extraction — a fixed budget regardless of runtime, and always far under the transcription API's ~25 MB request cap. |
| **Bytes moved** | presigned-URL range seek | ffmpeg fetches only the ranges around each seek point, plus the file head for the audio lead. |

### Why spreading frames is free

The interval formula is what makes this work. For a 30-second clip at `maxFrames: 6`, `durationSec / maxFrames` is 5s, so the interval is the configured 5s and six frames come out. For a 3-hour video, `durationSec / maxFrames` is 1800s, which dominates, so the interval widens to 30 minutes — and six frames still come out, now spread across the whole recital.

Taking those same six frames from the *first thirty seconds* would cost identically and describe the video far worse. Spreading them is free.

### Degrade, never skip on duration

There is deliberately **no `maxDurationSeconds` skip gate**, unlike social-media detection.

The longest videos in a family library — a whole recital, a wedding ceremony — are often the most significant, and are exactly the ones a duration cap would silently leave undescribed. Since cost is already duration-independent, skipping them buys nothing. The only length-related guard is the shared `VIDEO_ENRICHMENT_MAX_BYTES`, and it now gates only the *fallback download path*.

---

## 3. Why a separate job type

`video_auto_tagging` is a distinct enrichment job type, not a branch inside `auto_tagging`. This follows the `face_detection` / `video_face_detection` precedent, and it is **required rather than stylistic**:

1. **Timeout bucket.** `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` (20 min) is applied via a set of job **types** (`VIDEO_JOB_TYPES`, `enrichment-job.worker.ts`). Branching inside `auto_tagging` would hand every photo-tagging job a 20-minute budget instead of the 10-minute global.
2. **Node requirements are per type.** `JOB_TYPE_REQUIREMENTS.auto_tagging` is `['sharp']`; the video type needs `['sharp','ffmpeg','ffprobe']`. A node without ffmpeg must not advertise the video type — and the requirements map is keyed by type.
3. **Per-type admin surfaces.** `/admin/settings/jobs` filtering, `job-type-labels.ts`, and per-type queue insights all key on type.

`ENRICHMENT_LEASE_MS` (30 min default) comfortably exceeds the 20-minute video job timeout, so a legitimate long run is never reaped mid-flight.

### What is shared

Everything downstream: the `tag_labels` vocabulary, `media_tag_status`, `media_items.description`, the `MediaTagSource.ai` reconcile semantics, and the `media_item_embedding` upsert.

`VideoAutoTaggingService` does **not** reimplement persistence. It delegates to `AutoTaggingService.persistAutoTagging`, which already reloads the media item, the enabled label vocabulary, and the assigned people names itself (it had to, for the node-result path). **Vocabulary validation therefore has exactly one implementation** — a drifted second copy would let video tagging emit tags outside the admin's vocabulary, which is precisely the failure that validation exists to prevent.

The photo path is byte-identical: `auto-tagging.service.ts` and its spec were not modified by this epic.

---

## 4. Pipeline

```
gates (features.autoTagging → AUTO_TAG_ENABLED → autoTagging.video.enabled
       → type/deleted/object → socialMediaSource → VIDEO_ENRICHMENT_MAX_BYTES)
  → resolve input   (presigned URL when range-seekable; download fallback)
  → extractFrames({ durationMs, sampleIntervalSeconds, maxFrames })
  → prepareImageForProcessing per frame (maxDim: TAG_MAX_IMAGE_DIM)
  → [optional] extractAudioLead(leadSeconds) → provider.transcribeAudio
  → buildVideoTaggingPrompt(labels, people, frame timestamps, transcript)
  → ONE analyzeImage call with N images
  → persist transcript row
  → AutoTaggingService.persistAutoTagging(job, { rawText })
```

**Gates are ordered cheapest-first**, mirroring `social-media-detection.handler.ts`. Every one of them returns before any download or AI call. The `socialMediaSource` gate exists so a TikTok/Instagram re-share never burns a vision call.

**Frame preparation** uses the same `prepareImageForProcessing` and `TAG_MAX_IMAGE_DIM` budget as the photo path, so EXIF-orientation handling and downscaling are identical. A frame sharp cannot decode is **skipped**, not fatal — the remaining frames still describe the video. A combined-payload cap drops frames from the **end** (keeping the earliest, which anchor the narrative) rather than failing.

**Rate limits** are classified exactly as the photo path does: a provider 429 or 529 becomes the queue's `RateLimitError`, so the job is *deferred* rather than counted as a failed attempt.

---

## 5. The prompt contract

`buildVideoTaggingPrompt` **extends** the photo prompt's contract rather than replacing it:

- **Same output envelope** — `{"tags": [...], "description": "..."}`. This is what lets the entire parse/persist half be reused verbatim.
- **Same** newline-joined `Allowed labels:` vocabulary block.
- **Same** named-people clause.

What it adds:

- A statement that the N images are **ordered stills sampled from a single video**, not unrelated photos, with an explicit instruction to describe the video as a whole.
- Each frame's timestamp, rendered `m:ss`.
- When present, a delimited transcript block flagged as *"may be incomplete or misheard — treat it as a hint, not as fact"*.

The output token budget is raised per-request to 2048 (from Anthropic's hardcoded 1024). A multi-frame description plus a tag list does not reliably fit in 1024, and a truncated response fails `parseAnalysisResult`'s JSON parse — an opaque failure mode.

Both the prompt builder and the system prompt live in `packages/enrichment-compute/src/ai`, **not** in the API app, so the server and a worker node compose byte-identical prompts. A prompt string duplicated across two executors is exactly the thing that drifts silently.

---

## 6. Transcription

The richest signal in a family video is usually **spoken**: a name being called, "happy birthday", where they are, what they're celebrating.

**Bounded by construction.** `extractAudioLead` takes the **first `leadSeconds`** of audio via ffmpeg `-t`, as **mono 16 kHz** — what the transcription models downsample to anyway, and small enough (~30s well under 1 MB) that the request is never near the provider's size cap.

**OpenAI-only.** `transcribeAudio?` is an **optional** method on `AiProvider`, implemented on OpenAI only. Anthropic has no audio capability, so the method is simply **absent** there rather than throwing — the same precedent as `embedText?` and `enhanceImage?`. Callers duck-type it.

**Best-effort by contract.** Every one of these degrades the video to **visual-only** and never fails the tagging job:

- transcription disabled
- `ai.features.transcription` unset
- the resolved provider has no `transcribeAudio`
- no audio track (ffmpeg exits non-zero or writes an empty file)
- any other transcription error

**One exception:** a rate-limit error is **rethrown**, so the queue's deferral path handles it. Swallowing it would silently produce a worse description on a throttled account — matching how `embedAndStore` already treats `RateLimitError`.

**Stored, not discarded.** `media_transcripts` holds the text so a re-run does not re-pay transcription, and so there is a record of *why* the AI described a video the way it did. `lead_seconds` records how much audio was actually transcribed, which is what makes a later re-run with a larger budget **detectable** rather than silently mixed in with older, shorter rows.

**Made searchable for free.** The transcript is appended to the text `AutoTaggingService.embedAndStore` already builds from description + tags + people names. That is the *entire* "make speech searchable" change — no new endpoint, index, search field, or UI — and `semanticQuery` starts matching spoken content immediately. The lookup has its own try/catch so a failed read costs the transcript, not the whole embedding.

**Privacy.** This stores recognized speech from family videos as queryable text. It is off by default, cascade-deleted with the media item and the circle, and never leaves the configured AI provider. The admin UI says so explicitly.

---

## 7. Streaming input

Every other video enrichment path downloads the **entire** file before touching it. For video auto-tagging that meant pulling a multi-gigabyte file to read six frames and thirty seconds of audio — and on a constrained VPS it is the single biggest driver of the disk pressure `assertDiskSpaceForDownload` and `TempFileJanitorTask` exist to contain.

ffmpeg speaks HTTP and issues Range requests, so `-ss` **input** seek (before `-i`) against a presigned URL fetches only the ranges around each seek point.

### The safety property

**The fallback is the existing, proven download path, unchanged.** `VideoInputResolver.tryStream` never throws; it returns `null` and the caller falls through. Every one of these routes to the download:

| Condition | Verdict |
|---|---|
| `moov` atom before `mdat` | `suitable` — stream it |
| `mdat` before `moov` (non-faststart) | `not-faststart` — the index is at the end of the file |
| HTTP 200 without `Content-Range` | `no-range-support` — seeks would re-download the file |
| Unrecognized container, network error, non-OK status | `unknown` |
| `autoTagging.video.streamInput = false` | never probed |

The worst case of this feature is therefore **exactly today's behavior plus one 64 KB read**.

### Two documented failure modes

**Non-faststart MP4.** A `moov` atom at the end of the file forces ffmpeg to fetch the tail before it can seek at all, collapsing the saving and doing it slowly. This is detected by **reading the top-level ISO-BMFF box order** over one ranged request — ffprobe's `-show_format` does not report atom order at all, so nothing in the persisted `_processing['video-probe']` blob could answer it. The same single request also proves the provider honors `Range`.

**Node engine pre-download.** `node-engine.ts` wrote `inputUrl` to a temp file *before* calling compute, and `INPUT_REQUIRED_TYPES` enforced a non-empty local path. Without an opt-out the node would keep downloading everything and the optimization would be server-side only. `URL_INPUT_TYPES` passes the URL straight through — while still failing cleanly when there is no URL at all.

### Other notes

`extractFrames` had **no ffmpeg timeout** (only `extractPosterFrame` did). Survivable against a local file; against a remote URL a stalled network read would hang a worker slot until the 20-minute job timeout. It is now bounded, with a longer default for network sources.

Presigned URLs expire, so the streamed URL's TTL (2 hours) comfortably exceeds the job's 20-minute budget; an expiry that somehow still bit surfaces as an ordinary ffmpeg failure the queue retries.

**Scope.** Only `video_auto_tagging` streams. `video_face_detection` and `social_media_detection` still download — this is proven on the new, off-by-default type first. All three now share one `downloadToTempFile` helper, so the fallback has a single implementation rather than three copies that could drift.

---

## 8. Enqueue paths

Four paths enqueue AI tagging. All four route by media type.

| Path | Behavior |
|---|---|
| **Upload** | Videos join the **post-social-media-detection fan-out** rather than being enqueued directly. `social_media_detection` withholds video enrichment until a video is classified, so a re-share is never sent to the vision model. When social detection is off, the direct fan-out call covers it. |
| **Per-item rerun** (`POST /api/media/:id/tags/rerun`) | Resolves the item's type and routes. Previously had **no type guard at all**. |
| **Bulk rerun** (`POST /api/media/bulk/tags/rerun`) | Fetches `{ id, type }` in one query and routes per item, mirroring `bulkRerunFaces`. Previously enqueued `auto_tagging` for every id with no filter — a **live bug** that predates this epic. |
| **Admin backfill** (`POST /api/admin/tagging/backfill`) | Optional `mediaTypes`, defaulting to **photos only**. |

`MediaEnrichmentService.enqueueTagRerun` takes an optional `type` so a caller that already knows it avoids a lookup, and **resolves it itself when absent** — which keeps every call site correct by default rather than correct only if it remembered to pass one.

### Why backfill makes videos opt-in

An admin used to running photo backfills would otherwise, on their first run after upgrading, dispatch an AI call for **every video in the library** — a large, unexpected bill from a command whose behavior they thought they understood. The admin UI's "Include videos" toggle names the per-video cost and is disabled until video tagging is on.

---

## 9. Workflow integration

The epic's headline use case is *"for videos captured between date A and date B, re-run AI tagging."*

That workflow was **already expressible** — `rerun_enrichment` is a shipped action, and `mediaType` (enum) and `capturedAt` (date-range) are registered condition fields. It just didn't work: `enrichmentJobTypeForKind` returned `'auto_tagging'` unconditionally for `case 'tagging'`, while its `faces` sibling *on the very next line* already branched on `MediaType.video`. Every matched video produced a failed job.

Three changes:

1. **Video routing** for `kind: 'tagging'`, with `needsType` widened to cover it.
2. **`rerun_ai_tagging`** — a one-click shortcut. It dispatches through the *same* `rerunEnrichment` executor path with `kinds: ['tagging']`, so it is a **preset, not a second implementation**: video routing and the status upsert cannot drift.
3. **`MediaTagStatus → pending`** on a workflow tagging re-run. `rerunEnrichment` enqueued raw and never did this, unlike `enqueueTagRerun`. The UI badge never moved — and, more seriously, `buildDependencyState` in `workflow-trigger.listener.ts` read a stale `processed`, letting an `on_media_enriched` workflow fire against tags actively mid-rebuild. Best-effort, so a cosmetic miss never fails a run item.

**Loop protection is unchanged:** enrichment-enqueuing actions use `reason: JobReason.rerun`, and `workflow-trigger.listener.ts` only reacts to `JobReason.upload`, so a re-enqueue cannot re-trigger the workflow that caused it. An enrichment-enqueuing action must never use `upload`.

**Authorization is unchanged:** `BASE_ACTION_PERMISSION` (`media:write` + circle `collaborator`), `triggerCompatibility: 'all'`, not destructive — so `isGatedAction` stays false and both actions remain approval-bypass eligible for unattended runs.

### `paramsSchema` is now wired in

`WorkflowActionDescriptor.paramsSchema` was declared on all 22 actions and **never invoked anywhere**. `actionSchema` is `z.object({ type }).passthrough()`, so action params were structurally unvalidated at create and run time and the executor blind-cast `action.params['kinds']`. A malformed value reached the executor and failed at runtime, *per item, inside a batch job*.

`WorkflowDefinitionValidator.validate()` now checks each action's params against its declared schema as a fifth step, hardening all 22 actions retroactively and **normalizing** defaults so the executor reads real values rather than `undefined`.

> **Shape note.** An action is stored **flat** — `{ type, ...params }`, each param a top-level sibling of `type`, never nested under a `params` key. `WorkflowExecuteBatchHandler` rebuilds the executor's bag with `const { type, ...params } = a`. The validator reads and writes siblings accordingly.

---

## 10. Node compute

`video_auto_tagging` is node-claimable. It is per-item media compute with an established transient-credential path — precisely the profile nodes exist for — and server-only would make it unavailable entirely under `ENRICHMENT_WORKER_MODE=off`.

**Requirements:** `['sharp', 'ffmpeg', 'ffprobe']`. A node without ffmpeg never claims it. The worker image already carries ffmpeg/ffprobe for `video_face_detection`, so no image change was needed.

**The compute/persist split:**

- The node fetches **transient, per-job credentials**, holds the plaintext key in a local variable for one compute call, and never persists it to disk, config, or logs. (The originally-proposed "AI-proxy" design was rejected for `auto_tagging`; re-introducing it here would mean uploading N frames per video just to call an API the node can call directly.)
- `getJobCredentials` hands over the **vocabulary and people rather than a finished prompt**: the user prompt embeds frame timestamps only the node knows, while `tag_labels` needs DB access the node lacks. The node composes the prompt with the shared builder.
- Transcription rides along as a **second, independent credential**. Absent, unconfigured, or unresolvable all degrade the video to visual-only.
- `resolveJobParams` merges `autoTagging.video.*` plus `durationMs` into the claim params — same rationale as `video_face_detection` (no payload, settings read fresh at process time, no DB access on the node).
- **Parsing stays server-side.** A node cannot validate tags against a vocabulary it cannot read, so it returns raw text plus frame/transcript provenance (`videoAutoTaggingResultSchema`).
- An unsupported tagging provider **declines** with `CapabilityUnavailableError`, leaving the job server-only rather than failing it.

**Parity is the acceptance bar.** Frame timestamps (`computeSeekTimestamps`), image preparation (`prepareImageForProcessing` at `TAG_MAX_IMAGE_DIM`), the prompt, and the vision request body all come from `packages/enrichment-compute` — the same code the server runs.

---

## 11. Data model

### `media_transcripts`

| Column | Notes |
|---|---|
| `media_item_id` | `@unique`, FK → `media_items`, **Cascade** |
| `circle_id` | FK → `circles`, **Cascade** |
| `text` | the transcript |
| `language` | detected/declared, nullable |
| `provider` / `model` | audit of what produced it |
| `lead_seconds` | how much audio was actually transcribed |
| `created_at` / `updated_at` | |

Upserted on `media_item_id` so a re-run replaces rather than duplicates. Index on `(circle_id)`.

Deliberately **its own table**, not a column on `media_tag_status`: that is a status table wiped on every tagging reset, and losing the transcript with a status reset would re-pay the transcription bill.

Both FKs cascade — a transcript is speech recognized from one video in one circle and must not outlive either.

### Reused, unchanged

`media_tag_status`, `tag_labels`, `media_tags` (`source: 'ai'`), `media_items.description`, `media_item_embedding`. Videos now produce embedding rows, which is what makes them reachable by `semanticQuery`.

---

## 12. API surface

No new endpoints for the tagging itself — the existing per-item and bulk rerun routes now route videos correctly. New and changed surfaces:

| Endpoint | Change |
|---|---|
| `PUT /api/ai/features/transcription` | **New.** `{ provider, model } \| null`; validated against the credential store up front (400 for an unconfigured or disabled provider). `ai_settings:write` |
| `GET /api/ai/models?capability=transcription` | **New branch.** Curated OpenAI transcription models; other providers return empty. `ai_settings:read` |
| `POST /api/admin/tagging/backfill` | **New param** `mediaTypes?: ('photo'\|'video')[]`, defaulting to `['photo']`. `system_settings:write` |
| `POST /api/media/:id/tags/rerun` | Routes videos to `video_auto_tagging` |
| `POST /api/media/bulk/tags/rerun` | Routes per item (bug fix) |
| `POST /api/admin/doctor/run` | New `ai.videoTagging` check |
| `POST /api/nodes/:id/jobs/:jobId/credentials` | New `video_auto_tagging` branch |

---

## 13. Settings reference

### `autoTagging.video.*`

Mirrors `face.video.*`. Deliberately **not coupled** to it even though both sample frames: face detection wants ~60 frames to catch everyone who appears, AI tagging wants ~6 because each frame is a *billed* image. One shared knob would make one of the two wrong.

There is **no new env kill-switch** — video tagging rides on `AUTO_TAG_ENABLED`, exactly as video face detection rides on `FACE_AUTO_DETECT`.

| Key | Type / range | Default | Purpose |
|---|---|---|---|
| `autoTagging.video.enabled` | boolean | **`false`** | Sub-feature switch. `features.autoTagging` remains master. |
| `autoTagging.video.maxFrames` | int 1–20 | `6` | The dominant cost lever. Duration-independent. |
| `autoTagging.video.sampleIntervalSeconds` | int 1–60 | `5` | Feeds `computeSeekTimestamps`' mid-interval math. |
| `autoTagging.video.transcription.enabled` | boolean | `false` | Second cost lever, independently switchable. |
| `autoTagging.video.transcription.leadSeconds` | int 5–600 | `30` | First N seconds of audio only. |
| `autoTagging.video.streamInput` | boolean | `true` | Whether ffmpeg range-seeks a presigned URL instead of downloading. A revert switch — the download path is the fallback for every failure. No admin UI. |

### `ai.features.transcription`

`{ provider, model } | null`, default `null`. Same nullable-object shape as `ai.features.enhance`/`memories` — a half-filled pair is not a valid selection. Unset means video tagging runs visual-only.

> **Registration pitfall.** Per CLAUDE.md, each namespace is a hand-maintained copy in five places: `systemSettingsSchema`, `systemSettingsPatchSchema`, **`patchSystemSettingsSchema` (the wire DTO, which strips unknown keys)**, the by-hand merge in `SystemSettingsService.patchSettings`, and the interface + defaults in `settings.types.ts`. A namespace present only in the first two validates perfectly in unit tests while every real `PATCH` silently no-ops — which is why the specs drive a body through the *real* DTO.

### Doctor: `ai.videoTagging`

The status ladder encodes the asymmetry between the two levers — the visual pass is **required**, transcription is an optional enrichment:

| Condition | Status |
|---|---|
| `features.autoTagging` or `autoTagging.video.enabled` off | `skipped` |
| `AUTO_TAG_ENABLED=false` overrides the setting | `warning` |
| Enabled, no `ai.features.tagging` provider/model | `error` |
| Enabled, tagging provider has no enabled credential | `error` |
| Transcription on, `ai.features.transcription` unset | `warning` — runs visual-only |
| Transcription on, its provider has no credential | `warning` — runs visual-only |
| Transcription provider has no `transcribeAudio` (e.g. Anthropic) | `warning` — runs visual-only |
| All configured | `ok` |

Reporting a transcription gap as an `error` would send an admin chasing a credential to fix a feature that is already working.

---

## 14. RBAC

**No new permission.** Video tagging is the same operation on a different media type, so it reuses `media:read` / `media:write` plus the per-circle `viewer` / `collaborator` roles, and the admin surfaces reuse `system_settings:*` / `ai_settings:*` exactly as photo tagging does. Node registration and claiming reuse the owner's `jobs:write`.

---

## 15. Rejected alternatives

Recorded explicitly, because each is the kind of thing a future contributor would otherwise reintroduce.

**Transcribing the whole audio track.** ~180 billable minutes for a 3-hour video, and a hard failure against the transcription API's ~25 MB request cap. Rejected outright in favor of a first-N-seconds budget.

**Sampled transcription windows** (e.g. 4 × 30s spread across the video). Better coverage for the same token cost, and it would mirror how frames are sampled — but materially more ffmpeg work and prompt complexity. Deliberately deferred; `lead_seconds` on the table means a later move to windows is detectable and re-runnable rather than silently mixed with old rows.

**One AI call per frame, merged.** Works with single-image-only providers and is more robust for long videos, but N times the cost and latency, and merging N descriptions into one coherent paragraph is its own hard problem.

**Frames from the first 30 seconds only.** Cheaper to reason about, but strictly worse for the same money: spreading the same frame budget across the full runtime costs identically and describes the video far better.

**A `maxDurationSeconds` skip gate.** Cost is already duration-independent, so skipping long videos buys nothing — and the longest videos are often the most significant. See §2.

**Branching inside `auto_tagging`.** Rejected for the three concrete reasons in §3 — timeout bucket, node requirements, and per-type admin surfaces are all keyed on job type.

**Duplicating the persist logic into the video service.** Faster to write, but vocabulary validation drifting between the photo and video paths would produce tags outside the admin's vocabulary — the exact failure the validation exists to prevent.

**Node-side parsing.** The node has no access to `tag_labels` and cannot validate that returned tags are in-vocabulary.

**An "AI-proxy" node design** (node uploads frames, server makes the call). Already rejected for `auto_tagging`/`geocode` in favor of transient credentials; here it would mean uploading N frames per video just to call an API the node could call directly.

**Streaming input with no download fallback.** The non-faststart case is common enough in real phone and camera output that it would silently degrade a meaningful share of the library.

**Asking storage for an explicit byte range** and handing ffmpeg a slice. Requires knowing the frames' byte offsets in advance, which requires parsing the container index — reimplementing what ffmpeg already does correctly.

**Server-side transcoding to a small proxy file on upload.** Would make all downstream video work cheap, not just tagging, but it is a much larger feature (storage cost, a new processor, backfill for the existing library) and belongs in its own epic.

**Defaulting `autoTagging.video.enabled` to true.** Would give the feature immediate value, but silently starts billing on upgrade for every video in an actively-importing library.

**Including videos in the admin backfill by default.** See §8.

**Reusing `face.video.*` for the frame budget.** See §13 — the right values are an order of magnitude apart.

**Full-text search over transcripts.** Out of scope: the transcript folds into the *existing* `media_item_embedding` text, so it becomes semantically searchable for free. A dedicated search field, index, and UI is a clean follow-up.

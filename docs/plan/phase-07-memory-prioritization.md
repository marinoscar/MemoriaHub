# Phase 07 — Memory Prioritization

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 02 — Metadata Extraction](phase-02-metadata-extraction.md) · [Phase 03 — Web Media Library](phase-03-web-library.md)
**Next Phase:** [Phase 08 — Android Sync](phase-08-android-sync.md)
**Status:** Removed

> **This feature has been removed.** The `MediaClassification` enum (`memory | low_value | unreviewed`) and the `media_items.classification` column that were partially implemented (Phase 01 schema, bulk-edit and review-queue UI surfaces) have been dropped from the codebase. The automatic heuristic processors, dedicated review endpoint, and full review mode described below were never built. This document is retained as historical reference only.

---

## 1. Goal

Help users separate meaningful family memories from low-value media files — screenshots, downloaded TikTok videos, memes, temporary images — by automatically classifying uploads using heuristic `ObjectProcessor` implementations. The web app gains a review UI where users confirm, override, or act on the classifications. **Critically: the application never auto-deletes anything.** Every action is a user decision made with full context.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #14 — Distinguish meaningful memories from low-value media | "Memory Prioritization", "Filtering Low-Value Media" |
| #11 — Allow future processors to enrich photos and videos | "Media Processing and Enrichment" — heuristic processors are concrete examples of extensible enrichment |

From the vision: _"MemoriaHub should help users identify and separate meaningful family memories from media that may not need to be preserved long term... The user should stay in control, but the application should help surface what matters most."_

The vision explicitly lists the low-value media types to detect:
- Screenshots (tall aspect ratio, OS UI indicators, missing EXIF camera info)
- Downloaded TikTok/social media videos (watermarks, aspect ratio, metadata patterns)
- Memes and random saved images (small dimensions, missing EXIF)
- Temporary downloads and receipts (filename patterns, PDF-derived images)

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/storage/processing/object-processor.interface.ts` | `LowValueProcessor` and `ScreenshotProcessor` are new `ObjectProcessor` implementations |
| `apps/api/src/storage/processing/object-processing.service.ts` | Orchestrator unchanged; processors registered via DI |
| `apps/api/src/media/media.service.ts` (Phase 01) | `updateClassification()` helper; classification is a `MediaItem` column |
| Phase 02 typed columns | `width`, `height`, `durationMs`, `cameraMake` are the primary heuristic inputs |
| Phase 03 `MediaDetailDrawer` | Extended with classification badge and "Keep / Mark Low-Value / Delete" action buttons |
| Phase 03 `MediaLibraryPage` | Filter by `classification` already wired; review mode is a new route/view |

---

## 4. Scope / Deliverables

**Backend — heuristic processors:**
- `ScreenshotProcessor` (`ObjectProcessor`, priority 40): detects screenshots based on:
  - Aspect ratio matching common device screen ratios (9:19.5, 9:20, etc.) within 2% tolerance
  - Missing EXIF `cameraMake` / `cameraModel` (screenshots have no camera info)
  - `originalFilename` matching patterns: `Screenshot_*`, `Screen Shot*`, `IMG_E*` (iOS edited)
  - If all signals present: sets `MediaItem.classification = low_value`; writes `metadata.classificationReason = 'screenshot'`
- `LowValueProcessor` (`ObjectProcessor`, priority 50): detects other low-value media:
  - Very small dimensions (width or height < 200 px) → likely meme or icon
  - Video `durationMs` < 4000 ms AND missing EXIF → likely a GIF-replacement clip
  - `originalFilename` matching download patterns: `VID_`, `download`, `temp`, `received_`, social platform patterns
  - Sets `MediaItem.classification = low_value`; writes `metadata.classificationReason`
- A file classified as `memory` by explicit user action is never reclassified by processors (processors skip items with `classification = memory`)

**Backend — API:**
- `POST /api/media/review` bulk action endpoint accepting an array of `{ id, action: 'keep' | 'mark_low_value' | 'delete' }` — applies classification changes and queues deletions (deletion goes through the normal delete flow, not immediate)
- Audit event written for each classification change

**Frontend — review UI:**
- `ClassificationBadge` component: displays `memory` / `low_value` / `unreviewed` with color coding (green / amber / grey)
- Review mode in `MediaLibraryPage`: toggled by "Review" button in toolbar; shows only `unreviewed` and `low_value` items; each card shows classification reason
- `BulkReviewPanel`: select multiple items; apply Keep / Mark Low-Value / Delete to selection
- `MediaDetailDrawer` (Phase 03 extension): adds classification section with `ClassificationBadge`, reason text, and three action buttons

---

## 5. Data Model Changes

No new Prisma models. `MediaItem.classification` (enum: `memory | low_value | unreviewed`) and `MediaItem.metadata` (JSONB, holds `classificationReason`) are already in the Phase 01 schema.

The `classificationReason` field shape written by processors:

```json
{
  "classificationReason": "screenshot",
  "classificationSignals": {
    "aspectRatio": "9:20",
    "missingCameraExif": true,
    "filenamePattern": "Screenshot_*"
  }
}
```

---

## 6. API Endpoints

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `POST` | `/api/media/review` | `media:write` | Bulk classify: keep, mark low-value, or delete |
| `GET` | `/api/media?classification=low_value` | `media:read` | Already supported by Phase 01 filter |

**Bulk review request body:**

```json
{
  "actions": [
    { "id": "uuid-1", "action": "keep" },
    { "id": "uuid-2", "action": "mark_low_value" },
    { "id": "uuid-3", "action": "delete" }
  ]
}
```

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Implement `ScreenshotProcessor` with aspect-ratio, EXIF-absence, and filename-pattern heuristics; register in `storage.module.ts`; skip items already classified as `memory` | `backend-dev` |
| 2 | Implement `LowValueProcessor` with small-dimension, short-video, and download-filename heuristics; register in `storage.module.ts`; skip items already classified as `memory` | `backend-dev` |
| 3 | Implement `POST /api/media/review` in `MediaController`; validate ownership of all IDs in the batch; apply classification changes; queue deletes via existing delete flow; write audit events | `backend-dev` |
| 4 | Ensure `MediaMetadataSyncService` (Phase 02) also syncs `classification` and `metadata.classificationReason` from processor output | `backend-dev` |
| 5 | Implement `ClassificationBadge` MUI component with color-coded chip | `frontend-dev` |
| 6 | Add review mode toggle to `MediaLibraryPage` toolbar; filter grid to `classification=unreviewed,low_value` when review mode is active | `frontend-dev` |
| 7 | Implement `BulkReviewPanel`: checkbox selection on grid cards; floating action bar with Keep / Mark Low-Value / Delete buttons; calls `POST /api/media/review` | `frontend-dev` |
| 8 | Extend `MediaDetailDrawer` with classification section: badge, reason text (from `metadata.classificationReason`), and three individual action buttons | `frontend-dev` |
| 9 | Write unit tests for `ScreenshotProcessor` and `LowValueProcessor` (fixture images/videos with known characteristics) | `testing-dev` |
| 10 | Write integration test for `POST /api/media/review`: verify classification updates, ownership enforcement, and audit event creation | `testing-dev` |
| 11 | Write frontend tests for `BulkReviewPanel` (selection, bulk action, API call) and `ClassificationBadge` (renders correct color per classification) | `testing-dev` |
| 12 | Update `docs/plan/ROADMAP.md` status for Phase 07 | `docs-dev` |

---

## 8. Acceptance Criteria

- A JPEG screenshot (tall aspect ratio + no camera EXIF + `Screenshot_` filename) is classified `low_value` with `classificationReason = 'screenshot'` after upload.
- An image explicitly marked `keep` by the user retains `classification = memory` even after re-processing or a new processor run.
- `POST /api/media/review` with `action = delete` removes the item via the normal delete flow (not an immediate hard delete without confirmation).
- A user cannot bulk-review items owned by another user (403 for any cross-ownership ID in the batch).
- `BulkReviewPanel` disables the Delete button if zero items are selected; shows a confirmation dialog before deletion.
- `MediaLibraryPage` in review mode shows only `unreviewed` and `low_value` items.
- `ScreenshotProcessor.canProcess()` returns `true` only for `image/*` MIME types.
- `LowValueProcessor` does not modify items already classified as `memory`.
- All unit and integration tests pass; `npm run typecheck` is clean.

---

## 9. Out of Scope / Deferred

- AI/ML-based content classification (Phase 09)
- Face recognition for person-based prioritization (Phase 09)
- Object and scene detection (Phase 09)
- Duplicate detection and review UI (Phase 09 — content hash exists from Phase 02)
- Auto-deletion rules or schedules (explicitly out of scope per VISION.MD — user must always review)

## 10. Circle Integration

Family Circles (phase FC) is a prerequisite for this phase. The review actions in this phase (`POST /api/media/review`, `BulkReviewPanel`) operate on media belonging to the active circle. The `POST /api/media/review` endpoint requires `collaborator` role or higher for the item's circle (per the circle authorization rules). The acceptance criteria for cross-user review no longer applies: any collaborator in the circle can classify any item in that circle — the previous "owner-only" check is replaced by the per-circle role check.

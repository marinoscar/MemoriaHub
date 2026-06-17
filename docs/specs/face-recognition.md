# Face Detection and Recognition Specification

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | June 2026 |
| **Status** | All 4 phases implemented |
| **Branch** | `feat/face-recognition` |

---

## Table of Contents

1. [Motivation and Vision Alignment](#1-motivation-and-vision-alignment)
2. [Provider Model](#2-provider-model)
3. [Data Model](#3-data-model)
4. [Four-Phase Roadmap](#4-four-phase-roadmap)
5. [Phase 1: Settings — What Is Implemented Now](#5-phase-1-settings--what-is-implemented-now)
6. [Security and Privacy](#6-security-and-privacy)
7. [Infrastructure: CompreFace Sidecar](#7-infrastructure-compreface-sidecar)
8. [Endpoint and Permission Reference](#8-endpoint-and-permission-reference)

---

## 1. Motivation and Vision Alignment

[VISION.MD](../../VISION.MD) identifies face recognition and family-member identification as core enrichment goals: users should be able to find "photos of Lucia" or confirm "the whole family is in this photo." This feature delivers that capability through a background enrichment pipeline with a pluggable provider architecture.

**Core requirements (confirmed with product owner):**

- Detect faces in photos and recognize the same person across photos.
- Label people (Oscar, Pamela, Joe…).
- Merge two clusters when a model splits one real person into two — future photos are then treated as a single person.
- Pluggable providers (cloud + on-prem), switchable in the UI, to manage cost.
- Provider credentials configured in the Admin UI, encrypted at rest, mirroring the existing AI Settings feature.
- Runs in the background; track which media items have been processed and by which provider/model.
- Ability to re-run detection on a given photo.

---

## 2. Provider Model

The face domain uses a `FaceProvider` interface that abstracts detection, embedding generation, and (for cloud providers) delegated recognition. Two providers ship with Phase 1:

### CompreFace (default — self-hosted sidecar)

- **Type:** Self-hosted Docker sidecar running on the same compose network.
- **Capabilities:** `{ detect: true, embed: true, delegatedRecognize: false }`
- **Embeddings:** Returns 512-dimensional ArcFace embeddings (`arcface-r100-v1`). The app stores these vectors in its own PostgreSQL database and owns them entirely.
- **Privacy:** No data leaves the server. GPS coordinates, photos, and biometric vectors stay on-premise.
- **Cost:** Free.
- **Default:** Yes. The sidecar's base URL defaults to `http://compreface:8000` and can be overridden via `FACE_COMPREFACE_URL`.

### AWS Rekognition (opt-in — delegated)

- **Type:** AWS managed cloud API.
- **Capabilities:** `{ detect: true, embed: false, delegatedRecognize: true }`
- **Embeddings:** None returned. AWS performs matching against a collection indexed by the app; the app stores only an `externalFaceId` per face.
- **Privacy:** Photos are sent to AWS for processing. Operators must comply with applicable biometric data regulations.
- **Cost:** Per-image pricing applies.
- **Default:** No. Requires explicit credential configuration.

### Adding a New Provider

Implement the `FaceProvider` interface (under `apps/api/src/face/providers/`) and add one entry to `FaceProviderRegistry`. CompreFace-compatible self-hosted models can reuse the `compreface` provider key with a custom `baseUrl`.

**Important:** Do not mix providers across the same library. Face embeddings are model-specific and cannot be compared across providers or model versions. Switching providers requires re-processing all photos from the original S3 blobs.

---

## 3. Data Model

Five new Prisma models were added in Phase 1. The tables are created by migration in all phases; only `face_provider_credentials` is actively used in Phase 1 — the others are scaffolded for upcoming phases.

### `face_provider_credentials` (Phase 1 active)

Mirror of `ai_provider_credentials`. One row per provider.

| Column | Type | Description |
|--------|------|-------------|
| `provider` | String (unique) | Provider key: `compreface` or `rekognition` |
| `encryptedKey` | String | AES-256-GCM encrypted API key |
| `baseUrl` | String? | Override URL (CompreFace only) |
| `region` | String? | AWS region (Rekognition only) |
| `last4` | String | Last 4 chars of plaintext key (display only) |
| `enabled` | Boolean | Whether this provider is active |
| `updatedByUserId` | String? | FK to `users` |

### `people` (scaffolded; Phase 3)

Per-circle identity records for recognized individuals.

| Column | Type | Description |
|--------|------|-------------|
| `circleId` | String | Circle this person belongs to |
| `name` | String? | Display name (null until labeled) |
| `addedById` | String | User who created this record |
| `coverFaceId` | String? | FK to `faces` used as the cover thumbnail |
| `mergedIntoId` | String? | Self-FK — audit breadcrumb when two clusters are merged |
| `deletedAt` | DateTime? | Soft-delete timestamp |

### `faces` (scaffolded; Phase 2)

One row per detected face in a media item.

| Column | Type | Description |
|--------|------|-------------|
| `mediaItemId` | String | FK to `media_items` (cascade delete) |
| `circleId` | String | Denormalized for RBAC and fast queries |
| `personId` | String? | FK to `people` (null = unknown face) |
| `boundingBox` | Json | `{ x, y, width, height }` as fractions of image dimensions |
| `confidence` | Float? | Detection confidence score |
| `landmarks` | Json? | Facial landmark coordinates |
| `embedding` | Float[] | 512-d ArcFace embedding (CompreFace path); empty for Rekognition |
| `externalFaceId` | String? | AWS Rekognition face ID (Rekognition path only) |
| `providerKey` | String | Which provider produced this face |
| `modelVersion` | String | Which model version produced this face |
| `manuallyAssigned` | Boolean | `true` = user assigned; protected from re-clustering |

**Vector backend:** The `embedding Float[]` column is the default. When `FACE_VECTOR_BACKEND=pgvector` and the pgvector extension is available, an optional follow-up migration converts it to a `vector(512)` column with an `hnsw vector_cosine_ops` index for accelerated similarity search.

### `face_jobs` (scaffolded; Phase 2)

Async job queue for face detection. No external queue dependency (BullMQ not required in Phase 1).

| Column | Type | Description |
|--------|------|-------------|
| `mediaItemId` | String | Target media item (cascade delete) |
| `circleId` | String | Scoping for RBAC |
| `status` | Enum | `pending`, `running`, `succeeded`, `failed` |
| `reason` | Enum | `upload`, `rerun`, `backfill` |
| `providerKey` | String | Provider to use for this job |
| `modelVersion` | String? | Model to use |
| `attempts` | Int | Retry counter |
| `lastError` | String? | Last error message |

### `media_face_status` (scaffolded; Phase 2)

One row per media item — answers "has this item been processed, by whom, and when?"

| Column | Type | Description |
|--------|------|-------------|
| `mediaItemId` | String (unique) | FK to `media_items` (cascade delete) |
| `status` | Enum | `not_processed`, `pending`, `processing`, `processed`, `failed`, `no_faces` |
| `providerKey` | String? | Provider that processed the item |
| `modelVersion` | String? | Model that processed the item |
| `faceCount` | Int | Number of faces detected (0 = no faces found) |
| `processedAt` | DateTime? | When processing completed |
| `lastError` | String? | Error message on failure |

---

## 4. Four-Phase Roadmap

| Phase | Shippable outcome | Status |
|-------|-------------------|--------|
| **Phase 1** | Admins configure and test face providers in the Admin UI | Implemented |
| **Phase 2** | Faces detected in background; boxes visible on photos; re-runnable | Implemented |
| **Phase 3** | Same person recognized across photos; unknown clusters surfaced | Implemented |
| **Phase 4** | Full label/merge/search + biometric safeguards | Implemented |

---

## 5. What Is Implemented

All four phases are fully implemented on the `feat/face-recognition` branch.

### Phase 1 — Settings and Provider Abstraction

- **Database tables:** All five tables created by migration and active.
- **Permissions:** `face_settings:read` and `face_settings:write` seeded to the Admin role.
- **Settings API** (`FaceSettingsController` under `apps/api/src/face/`): six endpoints mirroring the AI Settings API.
- **Provider abstraction:** `FaceProvider` interface, `FaceProviderRegistry`, `ComprefaceProvider`, `RekognitionProvider`.
- **Admin UI:** `FaceSettingsPage` at `/admin/face-settings` with per-provider credential form, test button, model selector, and active-detection selector. Gated by `face_settings:read`.
- **CompreFace sidecar:** Added to `infra/compose/base.compose.yml` with its own bundled Postgres container.

### Phase 2 — Background Detection

The detection pipeline runs entirely outside the synchronous upload path via a polling worker:

1. **`FaceEnqueueListener`** (`apps/api/src/face/processing/`) listens for `OBJECT_PROCESSED_EVENT`. If the media item's circle has `faceRecognitionEnabled=true` and `FACE_AUTO_DETECT` is not `false`, it inserts a `FaceJob(reason:upload)` and upserts `MediaFaceStatus(pending)`.
2. **`FaceJobWorker`** polls the `face_jobs` table on a configurable interval (`FACE_JOB_POLL_MS`, default 5 s). It claims the oldest `pending` job via `UPDATE … RETURNING`, runs `FaceDetectionService.processMediaItem`, and updates job status. Claims are atomic (no concurrent double-processing). Max 3 attempts before marking `failed`. Disabled via `FACE_WORKER_ENABLED=false`.
3. **`FaceDetectionService.processMediaItem`**: resolves the active provider/credentials from system settings → streams the image bytes from S3 → calls `provider.detect()` → deletes prior non-`manuallyAssigned` Face rows (re-run idempotency) → persists new Face rows (box, confidence, embedding/externalFaceId, providerKey, modelVersion) → updates `MediaFaceStatus`.

New endpoints: `GET /media/:id/faces`, `GET /media/:id/faces/status`, `POST /media/:id/faces/rerun`, `POST /face/backfill`.

### Phase 3 — Embedding Matching and People

After detection, `FaceDetectionService` attempts to assign each face to a known `Person` in the circle:

- Embeddings are L2-normalized 512-d vectors (CompreFace/ArcFace path).
- In-app cosine similarity is computed against per-person centroids (`FACE_VECTOR_BACKEND=app`, the default). When `FACE_VECTOR_BACKEND=pgvector` and the pgvector extension is installed, the `<=>` cosine distance operator and an `hnsw` index are used instead.
- If the best similarity is ≥ `FACE_MATCH_THRESHOLD` (default 0.38), the face is assigned to that person and the centroid is recomputed as the mean of all normalized member embeddings.
- Faces below threshold remain unknown (`personId=null`).

**Rekognition path (delegated):** `provider.recognize()` calls `SearchFacesByImage` against the AWS collection. Matched faces receive the corresponding `personId`; unmatched faces get `externalFaceId` only.

**Unknown clustering** (`POST /people/cluster`): greedy union-find over all unassigned faces using `FACE_CLUSTER_THRESHOLD` (default 0.45). Clusters with ≥ `FACE_CLUSTER_MIN_SIZE` (default 2) faces create unlabeled `Person` records. Singletons remain unassigned. Requires circle_admin role and circle opt-in.

New endpoints: `GET /people`, `GET /people/:id`, `POST /people`, `PATCH /people/:id`, `POST /people/:id/faces`, `DELETE /people/:id/faces/:faceId`, `POST /people/cluster`. Also extends `GET /media` with `?personId=` filter.

### Phase 4 — Merge, Lifecycle, and Biometric Safeguards

- **Merge** (`POST /people/merge`): In a single database transaction, reassigns all `Face.personId` from source to target, sets `source.mergedIntoId=targetId` (audit breadcrumb), soft-deletes source, recomputes the target centroid. Eager face reassignment means `WHERE personId=target` always returns the full merged person without chain resolution. Emits `person:merge` audit event.
- **Delete person** (`DELETE /people/:id`): Soft-deletes the person; sets `personId=null` and `manuallyAssigned=false` on all associated faces. Face rows and embeddings are retained. Emits `person:delete` audit event.
- **Per-circle opt-in** (`GET/PUT /circles/:id/face-settings`): `faceRecognitionEnabled` column on `circles` (default `false`). Auto-enqueue, backfill, and clustering all check this flag. Emits `circle:face_settings_update` audit event.
- **Biometric erase** (`DELETE /face/biometrics?circleId=`): Permanently deletes all Face, Person, MediaFaceStatus, and FaceJob rows for a circle in a single transaction; sets `faceRecognitionEnabled=false`. Requires system Admin or circle_admin. Emits `face:biometrics_delete` audit event. This action is irreversible.

New endpoints: `POST /people/merge`, `DELETE /people/:id`, `GET /circles/:id/face-settings`, `PUT /circles/:id/face-settings`, `DELETE /face/biometrics`.

---

## 6. Security and Privacy

### Credential security

Face provider credentials use the same encryption path as AI provider credentials: AES-256-GCM with the `SECRETS_ENCRYPTION_KEY` (base64-encoded 32-byte key). The API fails to start if the variable is missing or incorrectly sized. The plaintext key is never stored, logged, or returned from any endpoint — only `last4` is exposed for display purposes.

### Biometric data

Face embeddings are biometric data and require careful handling:

- **Per-circle opt-in (default off):** The `faceRecognitionEnabled` flag on the `circles` table defaults to `false`. Auto-enqueue (on upload), backfill, and clustering all check this flag. Operators must explicitly enable face recognition per circle.
- **Delete all biometrics:** `DELETE /api/face/biometrics?circleId=` permanently deletes all `Face`, `Person`, `MediaFaceStatus`, and `FaceJob` rows for a circle and resets `faceRecognitionEnabled=false`. This is the designated GDPR right-to-erasure action for biometric data. Operators should document this capability in their privacy policies.
- **Model version pinning:** Each `Face` row records `providerKey` and `modelVersion`. Embeddings from different model versions are not cross-comparable. Switching providers or model versions requires re-processing all photos from the original S3 blobs.
- **No cross-provider matching:** The CompreFace embedding space and the Rekognition collection are independent. A library must use one provider consistently.
- **`manuallyAssigned` protection:** Faces explicitly labeled by users (`manuallyAssigned=true`) are not overwritten by subsequent auto-detection runs or re-clustering.

### Audit events

All sensitive face operations emit records to the `audit_events` table:

| Event | Trigger |
|-------|---------|
| `person:merge` | `POST /people/merge` |
| `person:delete` | `DELETE /people/:id` |
| `face:biometrics_delete` | `DELETE /face/biometrics` |
| `circle:face_settings_update` | `PUT /circles/:id/face-settings` |

### Access control

| Operation | System permission | Per-circle role |
|-----------|-------------------|-----------------|
| View face settings / test / list models | `face_settings:read` (Admin) | — |
| Configure credentials / set active provider | `face_settings:write` (Admin) | — |
| Backfill / biometric erase | `face_settings:write` (Admin) | `circle_admin` (biometric erase only) |
| Read faces, status, list people | `media:read` | viewer |
| Rerun detection, create/update/assign people | `media:write` | collaborator |
| Cluster unknowns, manage circle face settings | `media:write` | circle_admin |
| Filter media by personId | `media:read` | viewer |

---

## 7. Infrastructure: CompreFace Sidecar

CompreFace runs as a Docker service in `infra/compose/base.compose.yml`. Key decisions:

- **Own Postgres:** CompreFace is configured with its own bundled Postgres container (`COMPREFACE_DB_PASSWORD`). The app's Postgres is not shared with the sidecar — this avoids schema pollution, version coupling, and credential exposure.
- **Embedding mode:** The app calls CompreFace for detection and embedding only. The 512-d vectors are stored in the app's own database. CompreFace's internal face collection/recognition features are not used.
- **VPS tuning (x86/AVX2, CPU-only):** The Mobilenet build is used (fastest CPU model, ~99.5% accuracy). Recommended settings: `uwsgi_processes=1`, JVM heap capped at `-Xmx2g`. Swap is recommended to handle peak load.
- **Image tag:** The operator must pin the CompreFace image tag. The current default is `exadel/compreface:latest` — pin to a specific version before production deployment.

**New environment variables (add to `infra/compose/.env`):**

| Variable | Default | Description |
|----------|---------|-------------|
| `FACE_COMPREFACE_URL` | `http://compreface:8000` | CompreFace sidecar base URL |
| `FACE_AUTO_DETECT` | `true` | Global kill-switch for auto-enqueue on upload; per-circle opt-in still applies |
| `FACE_JOB_POLL_MS` | `5000` | Face worker poll interval in ms |
| `FACE_WORKER_ENABLED` | `true` | Set to `false` to disable the background worker (useful in test/CI) |
| `FACE_MATCH_THRESHOLD` | `0.38` | Cosine similarity threshold for assigning a face to a known person |
| `FACE_CLUSTER_THRESHOLD` | `0.45` | Cosine similarity threshold for grouping unknown faces during clustering |
| `FACE_CLUSTER_MIN_SIZE` | `2` | Minimum faces in a cluster to create a provisional Person; singletons stay unknown |
| `FACE_VECTOR_BACKEND` | `app` | `app` (Float[] + in-process cosine) or `pgvector` (native index via pgvector extension) |
| `COMPREFACE_DB_PASSWORD` | — | Password for CompreFace bundled Postgres |

---

## 8. Endpoint and Permission Reference

| Method | Path | Permission | Per-circle role | Phase | Description |
|--------|------|------------|-----------------|-------|-------------|
| `GET` | `/api/face/settings` | `face_settings:read` | — | 1 | Get providers, capabilities, active detection feature |
| `PUT` | `/api/face/credentials/:provider` | `face_settings:write` | — | 1 | Upsert encrypted credentials |
| `DELETE` | `/api/face/credentials/:provider` | `face_settings:write` | — | 1 | Remove credentials |
| `POST` | `/api/face/test` | `face_settings:read` | — | 1 | Test provider connectivity |
| `GET` | `/api/face/models` | `face_settings:read` | — | 1 | List models for a provider |
| `PUT` | `/api/face/features/detection` | `face_settings:write` | — | 1 | Set active detection provider/model |
| `GET` | `/api/media/:id/faces` | `media:read` | viewer | 2 | List faces on a media item |
| `GET` | `/api/media/:id/faces/status` | `media:read` | viewer | 2 | Get face detection status |
| `POST` | `/api/media/:id/faces/rerun` | `media:write` | collaborator | 2 | Re-enqueue face detection |
| `POST` | `/api/face/backfill` | `face_settings:write` | — | 2 | Bulk-enqueue a circle for detection (requires opt-in) |
| `GET` | `/api/people` | `media:read` | viewer | 3 | List people in a circle |
| `GET` | `/api/people/:id` | `media:read` | viewer | 3 | Get a person with their faces |
| `POST` | `/api/people` | `media:write` | collaborator | 3 | Create a person |
| `PATCH` | `/api/people/:id` | `media:write` | collaborator | 3 | Rename person or set cover face |
| `POST` | `/api/people/:id/faces` | `media:write` | collaborator | 3 | Assign faces to a person |
| `DELETE` | `/api/people/:id/faces/:faceId` | `media:write` | collaborator | 3 | Unassign a face |
| `POST` | `/api/people/cluster` | `media:write` | circle_admin | 3 | Cluster unknown faces (requires opt-in) |
| `GET` | `/api/media` (`?personId=`) | `media:read` | viewer | 3 | Filter media by person |
| `POST` | `/api/people/merge` | `media:write` | collaborator | 4 | Merge two person clusters |
| `DELETE` | `/api/people/:id` | `media:write` | collaborator | 4 | Delete person (faces become unknown) |
| `GET` | `/api/circles/:id/face-settings` | `circles:read` | viewer | 4 | Get per-circle face recognition opt-in |
| `PUT` | `/api/circles/:id/face-settings` | `circles:write` | circle_admin | 4 | Enable/disable face recognition for circle |
| `DELETE` | `/api/face/biometrics` | `face_settings:write` | circle_admin | 4 | Permanently erase all biometric data for a circle |

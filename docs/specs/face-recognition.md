# Face Detection and Recognition Specification

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Phase 1 implemented |
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

| Phase | Shippable outcome | Key components |
|-------|-------------------|----------------|
| **Phase 1** (current) | Admins configure and test face providers in the Admin UI | Settings API, provider abstraction, CompreFace sidecar, DB schema scaffold |
| **Phase 2** | Faces detected in background; boxes visible on photos; re-runnable | `FaceJob` worker, `FaceDetectionService`, re-run + backfill endpoints, face thumbnails UI |
| **Phase 3** | Same person recognized across photos; unknown clusters surfaced | Embedding matching + cosine similarity, `PeopleController`, cluster review UI |
| **Phase 4** | Full label/merge/search + biometric safeguards | Cluster merge, `DELETE /face/biometrics`, per-circle opt-in, search-by-person |

---

## 5. Phase 1: Settings — What Is Implemented Now

Phase 1 delivers everything needed for an admin to configure a face provider and verify connectivity before detection work begins. No photos are processed in Phase 1.

### What is active

- **Database tables:** All five tables above are created by migration. Only `face_provider_credentials` is written to in Phase 1.
- **Permissions:** `face_settings:read` and `face_settings:write` are seeded to the Admin role.
- **Settings API** (`FaceSettingsController` under `apps/api/src/face/`): six endpoints mirroring the AI Settings API.
- **Provider abstraction:** `FaceProvider` interface, `FaceProviderRegistry`, `ComprefaceProvider`, `RekognitionProvider` (stubs for Phase 2 detection methods).
- **Admin UI:** `FaceSettingsPage` at `/admin/face-settings` with per-provider credential form, test button, model selector, and active-detection selector. Gated by `face_settings:read`.
- **CompreFace sidecar:** Added to `infra/compose/base.compose.yml` with its own bundled Postgres container.

### What is scaffolded but not yet active

- The `people`, `faces`, `face_jobs`, and `media_face_status` tables exist in the schema but no API endpoints read or write them in Phase 1.
- `FaceEnqueueListener`, `FaceJobWorker`, and `FaceDetectionService` are not yet wired.

---

## 6. Security and Privacy

### Credential security

Face provider credentials use the same encryption path as AI provider credentials: AES-256-GCM with the `SECRETS_ENCRYPTION_KEY` (base64-encoded 32-byte key). The API fails to start if the variable is missing or incorrectly sized. The plaintext key is never stored, logged, or returned from any endpoint — only `last4` is exposed for display purposes.

### Biometric data

Face embeddings are biometric data and require careful handling:

- **Per-circle opt-in (Phase 4):** Face detection defaults to off per circle. Admins must explicitly enable it.
- **Delete all biometrics (Phase 4):** `DELETE /api/face/biometrics?circleId=` will cascade-delete all `Face`, `Person`, and `MediaFaceStatus` rows for a circle. Operators should document this capability in their privacy policies.
- **Model version pinning:** Each `Face` row records `providerKey` and `modelVersion`. Embeddings from different model versions are not cross-comparable. Switching providers or model versions requires re-processing all photos.
- **No cross-provider matching:** The CompreFace embedding space and the Rekognition gallery are independent. A library must use one provider consistently.

### Access control

All `/api/face/*` settings endpoints require:
- System role: `Admin`
- Permission: `face_settings:read` (GET, POST/test) or `face_settings:write` (PUT, DELETE)

People management and face browsing in later phases will use `media:read`/`media:write` system permissions combined with per-circle `viewer`/`collaborator` role checks, consistent with the rest of the media domain.

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
| `FACE_JOB_POLL_MS` | `5000` | Face worker poll interval (Phase 2+) |
| `FACE_MATCH_THRESHOLD` | `0.38` | Cosine similarity threshold (Phase 3+) |
| `FACE_VECTOR_BACKEND` | `app` | `app` or `pgvector` (Phase 3+) |
| `COMPREFACE_DB_PASSWORD` | — | Password for CompreFace bundled Postgres |

---

## 8. Endpoint and Permission Reference

All endpoints require the `Admin` system role.

| Method | Path | Permission | Phase | Description |
|--------|------|------------|-------|-------------|
| `GET` | `/api/face/settings` | `face_settings:read` | 1 | Get providers, capabilities, active detection feature |
| `PUT` | `/api/face/credentials/:provider` | `face_settings:write` | 1 | Upsert encrypted credentials |
| `DELETE` | `/api/face/credentials/:provider` | `face_settings:write` | 1 | Remove credentials |
| `POST` | `/api/face/test` | `face_settings:read` | 1 | Test provider connectivity |
| `GET` | `/api/face/models` | `face_settings:read` | 1 | List models for a provider |
| `PUT` | `/api/face/features/detection` | `face_settings:write` | 1 | Set active detection provider/model |
| `GET` | `/api/media/:id/faces` | `media:read` + viewer | 2 | List faces on a media item |
| `GET` | `/api/media/:id/faces/status` | `media:read` + viewer | 2 | Get face detection status |
| `POST` | `/api/media/:id/faces/rerun` | `media:write` + collaborator | 2 | Re-enqueue face detection |
| `POST` | `/api/face/backfill` | `face_settings:write` | 2 | Bulk-enqueue a circle for detection |
| `GET` | `/api/people` | `media:read` + viewer | 3 | List people in a circle |
| `GET` | `/api/people/:id` | `media:read` + viewer | 3 | Get a person with their faces |
| `PATCH` | `/api/people/:id` | `media:write` + collaborator | 3 | Rename person or set cover face |
| `POST` | `/api/people/merge` | `media:write` + collaborator | 4 | Merge two person clusters |
| `DELETE` | `/api/people/:id` | `media:write` + collaborator | 4 | Delete person (faces become unknown) |
| `DELETE` | `/api/face/biometrics` | `face_settings:write` | 4 | Delete all biometric data for a circle |

# face

Face detection, matching, clustering, people and auto-archive, moved onto the host ports (RETRO-J6, #615). The slice detects faces in photos and in videos, matches each face to a person with a vector search, clusters the unknown ones, manages people (create, rename, assign, merge, hide, purge) and hides a new face that matches one an administrator already archived.

## Purpose and scope

Everything about faces that does not depend on the HTTP layer, written against `@marinoscar/memoriahub-api/ports` only (no platform import, no generated database client, no AI provider SDK: the CompreFace sidecar is reached over HTTP through `@marinoscar/memoriahub-compute/face-compreface`).

- **Detection.** `FaceDetectionService` (photos), `VideoFaceDetectionService` (frame sampling, cross-frame de-duplication, one representative frame per identity) and their handlers `face_detection` and `video_face_detection`. Both are node-eligible: a worker node computes with its own sidecar and the server only persists (`persistNodeResult`). `FaceDetectionCore` is the shared persist-and-match half.
- **Matching.** `FaceMatchingService`: the indexed pgvector search on `faces.embedding_vec` (`FACE_VECTOR_BACKEND=pgvector`, the default) or the in-process cosine scan (`app`), with the person-centroid cache and the archived-face match used by auto-archive.
- **Clustering and people.** `FaceClusteringService` groups unknown, live faces into provisional people; `PeopleService` is the people API (list, get, create, update, assign, unassign, merge, delete, hide, unhide, purge, manual association, archive and purge of single faces).
- **Auto-archive.** The `face_auto_archive_sweep` handler (server-only, one job per circle) and `FaceBackfillService` (the admin backfills of detection and of the sweep).
- **Settings.** `FaceSettingsService`: the provider list, the CompreFace base URL override (a `face.providers.*` setting plus the `face_provider` secret purpose), the detection feature and the connection test.
- **Upload fan-out.** `FaceUploadEnrichment` registers `face_detection` for photos with the media slice's `UploadEnrichmentRegistry`.

The job type strings (`face_detection`, `video_face_detection`, `face_auto_archive_sweep`), their execution profiles, the secret purpose `face_provider`, the settings (`features.faceRecognition`, `features.faceAutoArchive`, `face.*`) and the environment variable names are permanent: stored rows and deployments name them.

**What is in the slice and what is left in the web app.** In the slice: every service, handler and the provider adapter above, the four controllers (`FaceSettingsController`, `FaceDetectionController`, `PeopleController`, `AdminFaceBackfillController`, written over `@MemoriahubAuth` of the core slice, with their `nestjs-zod` DTO classes and `FACE_PERMISSIONS`), `describeFaceSliceConformance` and an in-memory face store for the conformance run. Left in `apps/api/src/face` (the host binding): `FaceModule`, which imports `FaceModule.forRoot` with the three host tokens and lists the four controllers so the routes, the OpenAPI document and the permission matrix are unchanged.

## Entry point

`@marinoscar/memoriahub-api/face` (the module, the services, the handlers, the host tokens and `FaceModule`) and `@marinoscar/memoriahub-api/face/testing` (`describeFaceSliceConformance`, `FakeFaceStore`). It imports the `ports`, `core` and `media` slices through their `index.ts` and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `nestjs-zod` and `zod` (the controllers and their DTO classes), plus `@marinoscar/memoriahub-compute` (the sidecar client, frame sampling and image preparation) and `@marinoscar/memoriahub-contract` (the people and credential wire schemas). The core and media slices' own peers come with it. The compute libraries (`sharp`, `onnxruntime-node`) are `@marinoscar/memoriahub-compute` dependencies, exact-pinned, never peers of this package.

## Configuration

`FaceModule.forRoot({ providers, imports?, videoJobTimeoutMs? })`. Import it once in the host, and list the four controllers in the host module that serves the routes (`/api/face/*`, `/api/people/*`, `/api/media/:id/faces*`, `/api/media/:id/people*`, `/api/admin/face/*`).

- `providers` binds the three tokens that are not ports. `FACE_CONFIG`: a reader over the deployment configuration (structurally Nest's `ConfigService`; `ENV_FACE_CONFIG` reads the process environment). It supplies `FACE_MATCH_THRESHOLD` (0.38), `FACE_CLUSTER_THRESHOLD` (0.45), `FACE_CLUSTER_MIN_SIZE` (2), `FACE_VECTOR_BACKEND` (`pgvector` or `app`), `FACE_MATCH_KNN_CANDIDATES` (40), `FACE_ARCHIVE_MATCH_THRESHOLD` (0.45) and `FACE_ARCHIVE_MAX_CANDIDATES` (5000). `FACE_PERSON_AVATARS`: the host's account-avatar code (an account can be linked to a person and show that person's picture). `FACE_STORAGE_ORG`: the organization a video face frame is stamped with.
- `videoJobTimeoutMs` is the execution budget of `video_face_detection` (default 20 minutes).
- The switches `FACE_AUTO_ARCHIVE`, `FACE_AUTO_DETECT` and `FACE_MAX_IMAGE_DIM`, `VIDEO_ENRICHMENT_MAX_BYTES` and `FACE_COMPREFACE_URL` are read from the process environment where they always were (a kill switch is `false`). The platform freezes its registries before the container starts, so the settings namespaces, the notification events and the key prefixes stay declared in the host's `app-registrations`.

## Extension-point catalog

`FaceProviderRegistry` is the provider extension point: `FaceProvider` (`detect`, `testConnection`, `listModels`) is what an adapter implements; CompreFace is the only one today and a keyed provider reaches its key through `MEMORIAHUB_SECRETS` (`face_provider/<provider>`). `FACE_PERSON_AVATARS` and `FACE_STORAGE_ORG` are the two hooks above. `FaceDetectionHandler`, `VideoFaceDetectionHandler` (node-eligible: the node result schema plus `persistNodeResult`) and `FaceAutoArchiveSweepHandler` (server-only) register with `MEMORIAHUB_JOBS` when the module starts; a host never registers them itself. The upload fan-out is the media slice's `UploadEnrichmentRegistry`. `describeFaceSliceConformance` (in `face/testing`) is run by the package over fakes and by the web app over its adapters and a real pgvector database.

**Security notes.** Face embeddings are biometric data: no log line, span or error carries one, purging a face reclaims its embedding column, and the erase-biometrics route keeps its administrator permission in the host. A person or face of a library the caller is not a member of is a 404, never a 403 (the access port). A video face frame is stored under `video-faces/` and read through a signed URL, never a bucket URL.

**Diagnostics (RETRO-J10, #624).** The slice registers the `memoriahub.face.detection`, `memoriahub.face.flag-consistency` and `memoriahub.face.pgvector` checks through the `MEMORIAHUB_DOCTOR` port from `forRoot()`. Read-only; the id and the statuses are the ones the app declared before the move.

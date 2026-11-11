# @marinoscar/memoriahub-api

The NestJS side of the MemoriaHub domain: the **host ports** (injection tokens and interfaces) every domain slice reaches the outside world through, the module that binds them, and in-memory fakes with a conformance kit. Host-neutral: it imports no `@marinoscar/platform-*` package and no application workspace. CommonJS.

## Purpose and scope

MemoriaHub's domain (media, faces, tagging, search, memories, workflows, review runs, location, dedup, burst, social media, enhancement, insights) lives in this package, slice by slice (RETRO-J5 to J10); `media`, `face`, `insights`, `location`, `dedup`, `tagging`, `search`, `memories`, `review-runs`, `workflows` and `burst` are moved so far (media, location and dedup partly). A domain slice may not import the platform: everything outside the domain (the queue, the model runtime, object storage, notifications, settings, credentials, access policy, the database client, the event bus, audit, webhooks, metrics) is a **port**, an injection token plus an interface declared here and bound by each host. The web app binds the ports to the platform in `apps/api/src/platform-memoriahub/`; a bare host binds its own. Moving a slice therefore never moves a platform import with it ([ADR 0001](../../docs/decisions/0001-packages-first.md)).

The package carries the ports, the module, the testing kit and the `media` slice (the upload fan-out registry, the sidecar touch service, the `upload_completed` producer, the thumbnail signer, the Media Sync device service and the trash purge job), the `face` slice (detection in photos and videos, matching, clustering, people, auto-archive), the `tagging` slice (photo and video auto-tagging, the transcript, the tag vocabulary and the backfill) and the `search` slice (deterministic, semantic and agentic search). The web app behaves exactly as before; the port design is in [the ports spec](../../docs/specs/memoriahub-ports.md).

Status: experimental. It is `"private": true` until the owner opens the publish gate ([release runbook](../../docs/runbooks/release-memoriahub-packages.md)).

Entry points (a slice README per folder):

- `@marinoscar/memoriahub-api/ports`: the thirteen ports (tokens, interfaces, option and result shapes) and the two classes a slice throws across them ([slice README](src/ports/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/core`: `MemoriahubPortsModule.forRoot`, the optional-port defaults, the `Prisma` SQL helper, the domain error base class and the AI-to-job error helpers ([slice README](src/core/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/testing`: an in-memory fake of every port and `describeMemoriahubPortsConformance`, the kit a binding must pass ([slice README](src/testing/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/media`: the media slice, `MediaModule.forRoot` and `UploadEnrichmentRegistry` ([slice README](src/media/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/media/testing`: `describeMediaSliceConformance`, the kit the media slice's guarantees are checked with ([slice README](src/media/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/insights`: the storage insights slice, `InsightsModule.forRoot` and `InsightsService` ([slice README](src/insights/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/insights/testing`: `describeInsightsSliceConformance` ([slice README](src/insights/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/location`: the location slice (location grouping so far), `LocationModule.forRoot` and `LocationGroupResolverService` ([slice README](src/location/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/location/testing`: `describeLocationSliceConformance` ([slice README](src/location/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/dedup`: the dedup slice (near-duplicate detection and the review queue), `DedupModule.forRoot`, `DuplicateDetectionService`, `DuplicateService` and the three dedup controllers ([slice README](src/dedup/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/dedup/testing`: `describeDedupSliceConformance` ([slice README](src/dedup/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/burst`: the burst slice, `BurstModule.forRoot`, `BurstService`, `BurstDetectionService`, `BurstGroupReviewStrategy` and the two burst controllers ([slice README](src/burst/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/burst/testing`: `describeBurstSliceConformance` ([slice README](src/burst/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/review-runs`: the review-runs slice, `ReviewRunsModule.forRoot`, `ReviewRunService`, `ReviewRunSubjectRegistry` and the review-run controller ([slice README](src/review-runs/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/review-runs/testing`: `describeReviewRunsSliceConformance` and `FakeReviewRunsDb` ([slice README](src/review-runs/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/workflows`: the workflows slice, `WorkflowsModule.forRoot`, the run service, the condition compiler, the field and action registries and the three workflow controllers ([slice README](src/workflows/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/workflows/testing`: `describeWorkflowsSliceConformance` and `FakeWorkflowsDb` ([slice README](src/workflows/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/face`: the face slice, `FaceModule.forRoot`, `PeopleService`, `FaceMatchingService` the four face controllers and the three face job handlers ([slice README](src/face/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/face/testing`: `describeFaceSliceConformance`, the kit the face slice's guarantees are checked with ([slice README](src/face/README.md#extension-point-catalog)).
- `@marinoscar/memoriahub-api/tagging`: the tagging slice, `TaggingModule.forRoot`, the two server-only AI job handlers (`auto_tagging`, `video_auto_tagging`), the tag vocabulary and the backfill ([slice README](src/tagging/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/tagging/testing`: `describeTaggingSliceConformance` and the in-memory store behind it ([slice README](src/tagging/README.md#entry-point)).
- `@marinoscar/memoriahub-api/search`: the search slice, `SearchModule.forRoot`, deterministic, semantic and agentic search and the `SEARCHABLE_FIELDS` registry ([slice README](src/search/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/search/testing`: `describeSearchSliceConformance` and the in-memory store behind it ([slice README](src/search/README.md#entry-point)).
- `@marinoscar/memoriahub-api/memories`: the memories slice, `MemoriesModule.forRoot`, the curators, AI titles, the generation and digest jobs and the read API ([slice README](src/memories/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-api/memories/testing`: `describeMemoriesSliceConformance` ([slice README](src/memories/README.md#extension-point-catalog)).

## Install and peer dependencies

```bash
npm install @marinoscar/memoriahub-api@next
```

| Package | Range | Needed by |
|---|---|---|
| `@nestjs/common` | `^11.1.12` | `ports`, `core`, `testing` |
| `zod` | `^4.4.3` | `ports`, `testing` |
| `@prisma/client-runtime-utils` | `^7.8.0` (optional) | `core`, only when a slice builds raw SQL with `Prisma.sql` |
| `@marinoscar/memoriahub-contract` | any (optional) | the domain slices: `media`, `tagging`, `search` |
| `@marinoscar/memoriahub-compute` | any (optional) | `tagging` (image preparation, frame and audio extraction, the result schema); `search` through it |
| `csv-parse`, `csv-stringify` | `^5.6.0`, `^6.5.1` (optional) | `tagging` (the tag vocabulary CSV import and export); `search` through it |

The package has no dependency on `@marinoscar/platform-api`: a port is declared structurally, so a binding adapts the platform's types in the host. The per-slice data is `packages/memoriahub-slice-peers.json`; `node scripts/memoriahub-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
// A slice asks for a port by its token and never imports the platform.
import { Inject, Injectable } from '@nestjs/common';
import { MEMORIAHUB_JOBS, type MemoriahubJobsPort } from '@marinoscar/memoriahub-api/ports';

@Injectable()
export class ExampleScheduler {
  constructor(@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort) {}

  async queue(mediaItemId: string): Promise<void> {
    await this.jobs.enqueue({ type: 'example.job', subjectType: 'media_item', subjectId: mediaItemId, payload: { mediaItemId } });
  }
}

// The host binds the ports once, before any domain module.
// MemoriahubPortsModule.forRoot({ ports: { prisma: { useExisting: PrismaService }, jobs: { useClass: JobsAdapter }, ... } })

// A slice's unit test needs neither a platform nor a database.
// const fakes = createFakeMemoriahubPorts();
// Test.createTestingModule({ imports: [MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) })], ... })
```

## Configuration

`MemoriahubPortsModule.forRoot({ ports })` takes one binding per port (`useClass`, `useExisting`, `useValue` or `useFactory`, the four shapes of a Nest custom provider) and an optional `imports` list for the modules the bindings' providers need. The nine required ports are `prisma`, `jobs`, `ai`, `objectStore`, `access`, `identity`, `notify`, `settings` and `secrets`; `events`, `audit`, `webhooks` and `metrics` are optional and default to an in-process emitter and three no-ops. `forRoot` throws, naming every missing required port, so a forgotten binding stops the boot and not the first request. The package reads no environment variable.

## Extension-point catalog

Every token below is an extension point: a host binds it, a slice injects it. The description string of each token is permanent.

| Extension point | Kind | What a host provides |
|---|---|---|
| `MEMORIAHUB_PRISMA`, `MemoriahubPrismaClientLike` | token | the database client, plus `runInOrg` for row-level security |
| `MEMORIAHUB_JOBS`, `MemoriahubJobsPort`, `MemoriahubJobHandler` | token, hook | the queue: enqueue, dedup, handler registration, settled events |
| `MEMORIAHUB_AI`, `MemoriahubAiPort`, `MemoriahubAiClient` | token | the model runtime, feature-scoped, keys resolved per call |
| `MEMORIAHUB_OBJECT_STORE`, `MemoriahubObjectStorePort`, `MemoriahubObjectStore`, `MemoriahubObjectProcessor` | token, hook | object storage and the post-upload processors |
| `MEMORIAHUB_ACCESS`, `MemoriahubAccessPort` | token | owner-scope roles, record grants, scope sweeps |
| `MEMORIAHUB_IDENTITY`, `MemoriahubIdentityPort` | token | the normalised request principal (and the credential kind it authenticated with) |
| `MemoriahubAuthGuard`, `MemoriahubAuth` | guard | none: a slice's controllers declare `@MemoriahubAuth({ permissions, roles, credentials })` and the guard decides over the identity port; a host proves its binding with `describeMemoriahubAuthGuardConformance` |
| `MEMORIAHUB_NOTIFY`, `MemoriahubNotifyPort` | token | notification events, counted and state rows, email templates |
| `MEMORIAHUB_SETTINGS`, `MemoriahubSettingsPort` | token | system and user settings namespaces |
| `MEMORIAHUB_SECRETS`, `MemoriahubSecretsPort` | token | the encrypted credential store |
| `MEMORIAHUB_EVENTS`, `MemoriahubEventsPort` | token | in-process domain events |
| `MEMORIAHUB_AUDIT`, `MemoriahubAuditPort` | token | the audit sink |
| `MEMORIAHUB_WEBHOOKS`, `MemoriahubWebhooksPort` | token | outbound webhook events |
| `MEMORIAHUB_METRICS`, `MemoriahubMetricsPort` | token | counters and histograms by registered name |
| `MemoriahubPortsModule`, `MemoriahubPortBindings` | token | the global module that binds all of the above |
| `UploadEnrichmentRegistry` | registry | the media slice's upload fan-out: each slice registers its enrichment job and its gate |
| `registerWorkflowField`, `registerWorkflowAction`, `WorkflowActionHandlerRegistry`, `WORKFLOW_RUN_OBSERVER`, `WorkflowRunObserver`, `WorkflowTriggerService` | registry, token, service | the workflows slice's catalog, action implementation, run side channels (`WorkflowRunObserver`) and settlement entry point (`WorkflowTriggerService.evaluateSettlement`) a host supplies ([slice README](src/workflows/README.md#extension-point-catalog)) |
| `DUPLICATE_OBSERVER`, `DuplicateObserver` | token, interface | the dedup slice's optional side channel: the `media.item.trashed` webhook after a trash resolve commits |
| `BURST_OBSERVER`, `BurstObserver` | token, interface | the burst slice's optional side channel: the `media.item.trashed` webhook after a trash resolve commits |
| `ReviewRunSubjectRegistry`, `ReviewRunSubjectStrategy` | registry, interface | the review-runs slice's per-queue behaviour: the owner of a review queue registers what is eligible, how to apply the action and how to show a subject |
| `MEDIA_ITEM_PURGER`, `MediaItemPurger` | token | the batched hard delete of trashed media items (the host binds `MediaService`), called by the trash purge job |
| `MEDIA_GEO_LOCATION_PROVIDER`, `MediaGeoLocationProvider` | token | reverse geocoding through the deployment's active provider, used by the gallery service's location writes |
| `MEDIA_FORWARD_GEOCODER`, `MediaForwardGeocoder` | token | place search by typed text for `GET /api/media/geo/search` |
| `MEDIA_ENRICHMENT`, `MediaEnrichment` | token | the upload-time enrichment jobs of a new item and the per-item tagging, face and thumbnail reruns of the bulk actions |
| `MEDIA_WEBHOOK_EVENTS`, `MediaWebhookEvents` | token | optional: the `media.item.created`, `.trashed` and `.deleted` webhook events of the media lifecycle |
| `MEDIA_CSV_STRINGIFIER`, `MediaCsvStringifier` | token | optional: the streaming RFC 4180 writer the CSV export pipes through |
| `MEDIA_LOCATION_RESOLVER`, `MediaLocationResolver` | token | the canonical place-name resolver of the location slice (`location` depends on `media`, so `media` cannot import it), used by `MediaMetadataSyncService` |
| `MEDIA_REVERSE_GEOCODER`, `MediaReverseGeocoder` | token | reverse geocoding with the deployment's configured provider and credential, called from the server-only persist half of the `metadata_extraction` job |
| `MEDIA_OBJECT_REPROCESSOR`, `MediaObjectReprocessor` | token | re-runs the post-upload processors for one stored object, now (the thumbnail jobs call it from inside a job) |
| `MEDIA_THUMBNAIL_PRUNER`, `MediaThumbnailPruner` | token | deletes the thumbnails a source object no longer points at (best-effort; after the media item sync, issue #434) |
| `MEDIA_SYSTEM_ACCESS`, `MediaSystemAccess` | token | the cross-organization database client for the global `thumbnail_repair` scan, bound under the host's media housekeeping reason |
| `FACE_CONFIG`, `FACE_PERSON_AVATARS`, `FACE_STORAGE_ORG` | token | the face slice's three host hooks: the configuration reader, the account-avatar code and the organization of a derived storage row |
| `MEMORIES_OPTIONS`, `MEMORIES_ALBUMS`, `MEMORIES_EMAIL_READINESS`, `MEMORIES_GENERATION_HOOK` | token | the memories slice's host hooks: the resolved options (digest signing key), save-as-album over the host's album code, e-mail readiness, and the after-generation hook |

## Data

None of its own. The package ships no schema (the domain's Prisma fragments are `@marinoscar/memoriahub-db`). The media slice reads and writes `media_items`, `storage_objects`, `media_sync_devices`, `media_sync_runs`, `media_sync_diagnostic_reports`, `android_app_releases`, `personal_access_tokens` (the device's token state), `audit_events` and `users`, through narrow structural delegates (`MediaModels`) and never a generated client. The face slice reads and writes `faces`, `people`, `media_face_status`, `media_items`, `storage_objects` (the video face frames) and `audit_events` the same way. A `BigInt` column (`bytes_uploaded`) leaves the slice as a string; `captured_at` is a civil timestamp the slice never converts.

## Permissions and settings

None. The ports carry permission strings and settings namespaces as data: a slice declares the namespaces it owns through `MEMORIAHUB_SETTINGS.registerNamespace`, and the host verifies the declaration exists in its registry before the application starts.

## UI

None. The package has no UI.

## Infra

None. An image that installs the package must build it (`npm run build -w @marinoscar/memoriahub-api`) because `.dockerignore` drops every `dist/`.

## Observability

The package imports no OpenTelemetry API. `MEMORIAHUB_METRICS` writes through the host's registered metric names (labels are enums, never an organization, user or media id), and the host's jobs adapter keeps the platform's job spans: a slice never creates its own tracer.

## Security notes

A key never crosses a port: the AI port resolves the credential on the host's side and drops it when the call returns, and `MEMORIAHUB_SECRETS.status` never returns material. Access is decided only through `MEMORIAHUB_ACCESS`, which answers not-found (never forbidden) to a non-member of a scope. AI jobs are server-only: the jobs binding refuses a handler that declares `usesAi` and the node-result pair together. The conformance kit asserts each of these.

## Conformance suite

`describeMemoriahubPortsConformance(name, factory, harness, options)` from `@marinoscar/memoriahub-api/testing`: test-runner neutral, one section per port. The package runs it against its own fakes (`test/ports-conformance.spec.ts`); the web app runs it against the platform adapters (`apps/api/test/platform-memoriahub/`). A host adding a binding runs the same kit against it.

`describeMediaSliceConformance(harness, { name, create })` from `@marinoscar/memoriahub-api/media/testing`: the media slice's guarantees (touch de-duplication and chunking, the fan-out registry's order and fallbacks, `upload_completed` folding for every role, PAT-only Media Sync registration and 404 for another user's device). The package runs it over the fakes with the services resolved from the real Nest module (`test/media-conformance.spec.ts`); the web app runs it with the notification port bound to the real adapter (`apps/api/test/media/media-slice-conformance.spec.ts`).

`describeTaggingSliceConformance(harness, { name, create })` from `@marinoscar/memoriahub-api/tagging/testing`: the single vocabulary validator both job types share (only vocabulary labels, case normalised, a re-run never touches a manual tag, the description only for an answer that parses), both job types server-only on their permanent types, profiles and the `tagging` throttle bucket, the photo fan-out (priority 20, `pending`, behind `features.autoTagging`), the backfill (photos by default, videos opt in) and the unique vocabulary. The package runs it over the fakes with the services resolved from the real Nest module (`test/tagging-conformance.spec.ts`); the web app runs it with the jobs port bound to the real adapter (`apps/api/test/tagging/tagging-slice-conformance.spec.ts`).

`describeSearchSliceConformance(harness, { name, create })` from `@marinoscar/memoriahub-api/search/testing`: not-found for a non-member and queries bound to the scope and the live rows, the unknown-key 400, AND composition of OR-emitting filters, the `near` bounding box, the semantic fallback when no embedding model is configured and the KNN ranking when one is, and the agent (a 400 before any model call without a search model, the request scope and never one the model names). The package runs it over the fakes (`test/search-conformance.spec.ts`); the web app runs it with the AI port bound to the real adapter over a scripted platform `AiService` (`apps/api/test/search/search-slice-conformance.spec.ts`).

## Upgrade notes

New package: nothing to upgrade from. A port, a field of a port or a token description is added, never renamed or removed; a binding written against this release keeps working.

## Troubleshooting

`MemoriahubPortsModule.forRoot: no binding for port MEMORIAHUB_X` means the host did not bind a required port. `Cannot find module '@marinoscar/memoriahub-api/...'` means the package was not built (`npm run build -w @marinoscar/memoriahub-api`) or, under `moduleResolution: node`, that the per-slice stub folder (`ports/`, `core/`, `testing/`) is missing from the checkout. `Building raw SQL needs the optional peer dependency @prisma/client-runtime-utils` means a slice used `Prisma.sql` in a host that did not install it.

## Links

- [Ports spec](../../docs/specs/memoriahub-ports.md): each port, the call sites it serves, the bare-host notes
- [Package documentation standard and checks](../../docs/PACKAGES.md)
- [Release runbook](../../docs/runbooks/release-memoriahub-packages.md)
- [ADR 0001: packages first](../../docs/decisions/0001-packages-first.md)

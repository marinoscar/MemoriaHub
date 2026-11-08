# User data deletion, factory reset and offboarding

RETRO-H1 ([#591](https://github.com/marinoscar/MemoriaHub/issues/591), epic #584). MemoriaHub mounts the platform user-data slice (`@marinoscar/platform-api/user-data`, `@marinoscar/platform-web/user-data`) and declares a keep-or-delete decision for every model that names a user. The platform's design is EAB's `docs/specs/user-data-reset.md`; this page is what MemoriaHub adds to it. Operator procedure: [runbooks/factory-reset.md](../runbooks/factory-reset.md).

## 1. What is mounted

| Surface | Route | Permission | Job |
|---|---|---|---|
| Danger Zone (`/settings/danger-zone`) | `GET /api/user-data/summary`, `POST /api/user-data/deletions`, `GET /api/user-data/deletions/:jobId` | `user_settings:write` (every role), scoped to the caller | `user.data.purge` |
| Factory reset (`/admin/settings/factory-reset`) | `GET /api/admin/factory-reset/summary`, `POST /api/admin/factory-reset`, `GET /api/admin/factory-reset/:jobId` | `system:factory_reset` (Admin only, never implied by `system_settings:write`) | `admin.factory_reset` |
| Organization offboarding | `/api/admin/orgs/:orgId/offboarding/*` | `orgs:offboard` | `org.offboard` |

Offboarding needs `TENANCY_MODE=multi`; MemoriaHub runs single-organization, so it is wired but unreachable. A factory reset is disabled with `DEPLOYMENT_MODE=saas`. Every confirmation phrase is re-checked by the API.

Code: `apps/api/src/platform/user-data/` (`user-data.config.ts` mounts the module; `user-data.manifest.ts` holds the decisions; `memoriahub-user-data.service.ts` does the MemoriaHub-specific deletes; `memoriahub-purge.handlers.ts` the three delegated jobs; `factory-reset.steps.ts` the four reset steps; `user-removal.hook.ts` the removal hook). Web: the two packaged pages, routed in `App.tsx`, one card each in a `Danger Zone` group pinned last of `userSettingsSections.tsx` and `adminSections.tsx`.

## 2. Which models are decided, and why the library hangs off `StorageObject`

The planner decides **owner models**: a user-owned registry entry with an `ownerField` (`apps/api/src/app-registrations/user-owned-models.ts`). The registry refuses `ownerField` with `purge: 'retain'`, and the four keys that name an uploader (`media_items.added_by_id`, `albums`, `tags`, `people`) and `circles.owner_id` are `Restrict`. Making them owner models would mean changing `onDelete`, a migration this issue keeps out of scope (Open decision 1). So MemoriaHub's personal library is reached through the one owner model that names every uploaded file, the platform's `StorageObject` (`uploaded_by_id`).

### Keep or delete, per model

| Model | Owner key | Danger Zone (`user.data.purge`) | Factory reset | User row deleted (removal hook) |
|---|---|---|---|---|
| `StorageObject` (platform) | `uploaded_by_id`, SetNull | category `files`, delegated to `memoriahub.circle.purge` | kept by the org step (`factoryReset: 'keep'`); the `memoriahub.storage` step deletes every object outside the surviving prefixes | detached |
| `MediaItem`, `Album`, `Tag`, `Person` | actor `added_by_id`, Restrict | personal circle: deleted by `memoriahub.circle.purge`; shared circles: kept | deleted (`memoriahub.content`) | own circles deleted; shared: reassigned to the circle owner |
| `Circle` | actor `owner_id`, Restrict | kept (emptied) | deleted, then a new personal circle for the administrator | own circles deleted; refused while the user owns a shared circle with other members |
| `Face`, `MediaFaceStatus`, embeddings, statuses, `MediaTranscript`, `MediaTag`, `AlbumItem`, `MemoryItem`, `LocationSuggestion`, `MediaEnhancement` | via media | with their media | with their media | with their media |
| `Memory`, `Workflow` (+ runs), `BurstGroup`, `DuplicateGroup`, `ReviewRun`, `TrashEmptyRun` | via circle | personal circle: memories, workflows, groups deleted; run history cascades with workflows | deleted with circles | with the user's own circles |
| `CircleMember` | `user_id`, Cascade | **kept** ("a data reset never removes the user from a circle") | deleted with circles | cascades |
| `CircleInvite` | actor, SetNull | kept | deleted with circles | detached |
| `MemoryUserState` | `user_id`, Cascade | category `memories`, inline | deleted | cascades |
| `MediaShare` | `created_by_id`, Cascade | category `shares`, inline | deleted | cascades |
| `MediaSyncDevice` (+ runs, reports) | `user_id`, Cascade | category `devices`, delegated to `memoriahub.media_sync.purge` (also deletes each phone's token) | deleted (`memoriahub.content`) | cascades |
| `UserProfile` | `user_id`, Cascade | category `settings`, delegated to `memoriahub.profile.purge` (also deletes the avatar files) | deleted (`memoriahub.content`) | cascades |
| `MhLegacyNotification`, `MhLegacyPushSubscription` | `user_id`, Cascade | category `notifications`, inline | deleted | cascades |
| `MhLegacyNotificationDelivery`, `MhLegacyNotificationBroadcast` | actor, SetNull | kept | deleted (`memoriahub.leftovers`) | detached |
| `MhLegacyWorkerNode`, `MhLegacyNodeCredential` | Cascade | **kept** (deployment infrastructure, until RETRO-C2) | reassigned to the administrator (`memoriahub.legacy-nodes`) | cascade |
| `NodeBackupConfig`, `NodeBackupRun` | via node | kept | deleted | with the node |
| `EnrichmentJob` (`enrichment_jobs_legacy`) | none | n/a | deleted (`memoriahub.leftovers`) | n/a |
| `InsightsSnapshot`, `MhLegacyStorageMigrationRun`/`Item` | none | n/a | deleted (`memoriahub.content`) | n/a |
| `TagLabel`, `LocationGroup`, `LocationGroupAlias` | actor (groups), SetNull | n/a | **kept** (admin configuration) | detached |
| `Ai`/`Face`/`Geo`/`StorageProviderCredential` | actor, SetNull | n/a | **kept** (deployment configuration) | detached |
| `MhLegacyAndroidAppRelease`, `MhLegacyDatabaseBackupRun` (and the platform's `DatabaseBackupRun`) | actor, SetNull | n/a | **kept**, rows and files (deployment artifacts; backup jobs kept with `keepJobsReferencedBy`) | detached |
| Platform models (identity, settings, credentials, jobs, notifications, AI, webhooks, ...) | | the platform's hints (`registerPlatformUserData()`) | the platform's | the platform's |

The `user-data` conformance suite (`apps/api/test/conformance.spec.ts`) fails when an owner model has no decision, when a hint or scope names something that does not exist, or when no delete order exists. **A new model with a relation to `User` needs a user-owned registry entry and, if it has an owner column, a decision in `user-data.manifest.ts`.**

## 3. Categories and scopes

| Category | Label | `content` | Deletes |
|---|---|---|---|
| `files` (replaces the platform's) | Your personal library | yes | `memoriahub.circle.purge` |
| `memories` | Memory marks | yes | `MemoryUserState` |
| `shares` | Public links | yes | `MediaShare` |
| `devices` | Paired Android devices | no | `memoriahub.media_sync.purge` |
| platform `notifications`, `ai`, `credentials`, `settings`, `other` | | | the platform's models, the two legacy notification tables, `UserProfile` (`settings`) |

| Scope | Phrase | Categories |
|---|---|---|
| `library` | `LIBRARY` | `files` |
| `shares` | `SHARES` | `shares` |
| `devices` | `DEVICES` | `devices` |
| `content` (built-in) | `DELETE MY CONTENT` | every `content: true` category |
| `everything` (built-in) | `DELETE MY DATA` | every category |

Scope ids, phrases and job type strings are permanent once a job carried them.

**The `files` count** is the platform's, by owner key: every storage object the user uploaded, including the files behind what they added to shared circles (which a deletion keeps) and derived thumbnails. A hint cannot narrow its count by circle (seam gap, [local-exceptions.md](../platform-adoption/local-exceptions.md)); the category description says so.

## 4. The delegated jobs

Enqueued by `user.data.purge` after its inline rows commit, subject `user:<userId>`, payload `{ userId }`, `orgId: null` (MemoriaHub's circle tables have no `org_id` until Epic I). Server-only (no node-result pair), idempotent (deletes by predicate, pages re-select what is left).

| Type | Profile | What it does |
|---|---|---|
| `memoriahub.circle.purge` | 60 min, 3 attempts | Empties the user's PERSONAL circle (the circle stays): media items through `MediaService.purgeMediaItemsBatched` (original files deleted per provider group), thumbnails (`thumbnails/<objectId>*`) and video face frames (`video-faces/<itemId>/`) as storage-object rows, staged enhancement files through their recorded provider, then faces, people, albums, tags, memories, review groups and workflows. Fails the attempt when a media row could not be deleted, so the queue retries |
| `memoriahub.media_sync.purge` | 10 min, 3 attempts | Deletes the user's devices (runs and reports cascade) and the personal access token each one signed in with |
| `memoriahub.profile.purge` | 10 min, 3 attempts | Deletes every stored avatar (`avatars/<userId>/`) and the `user_profiles` row |

**Storage is routed per row.** Every file goes through the provider and bucket recorded on its own row (`storage_objects.storage_provider`/`bucket`, `media_enhancements.staging_provider`/`staging_bucket`) via the app's `StorageProviderResolver`; bytes first, then the row; a provider failure keeps the row and is counted. The platform's own `StorageObject` hint (`storageObjects: true`) is replaced in the manifest, because it would delete every object the user uploaded, shared-circle originals included, through the active provider; a boot-time assertion fails the application if that hint ever wins.

## 5. The user removal hook (Open decisions 1 and 2)

`memoriahub.circle-content` runs before the platform deletes a user ROW (a factory reset's "every other user" step, offboarding with `userDisposition: 'purge'`):

1. **Refuses** (throws `SharedCircleOwnershipError`, nothing changed) while the user owns a non-personal circle with other members. The job fails naming the circle ids; the administrator transfers ownership or removes the members, then retries. Revisited in Epic I (circles become groups).
2. Deletes every circle the user owns (personal, or shared with nobody) with all its content and files.
3. **Reassigns** what the user added to other people's circles (media, albums, tags, people) to each circle's owner. No schema change; the content stays for the members.

## 6. Factory reset steps

In the handler's order, after the platform deleted the jobs (backup jobs kept) and every user's inline rows:

| Step | Phase | Does |
|---|---|---|
| `memoriahub.content` | before-users | Staged enhancement files; then every media item, album, tag, person and circle (cascading the rest), profiles, paired devices, node backup configs and runs, the legacy storage-migration history, the insights snapshot |
| `memoriahub.legacy-nodes` | before-users | Legacy worker nodes and their credentials move to the administrator (a name clash removes the other node) |
| `memoriahub.leftovers` | deployment | Legacy notifications, deliveries and broadcasts, the frozen `enrichment_jobs_legacy` archive; a new personal circle for the administrator |
| `memoriahub.storage` | deployment | Every storage object outside the surviving prefixes (`database-backups/`, `db-backups/`, `android-releases/` and the registry's `survivesFactoryReset` ones), bytes through the row's provider, then the row |

`txTimeoutMs` is 20 minutes (the content step deletes a whole library in one transaction). A step that still times out is retried by the queue and deletes what is left.

## 7. Tests

- `apps/api/test/conformance.spec.ts`: the `user-data` suite.
- `apps/api/test/user-data/user-data-registrations.spec.ts`: job types, scopes, the `StorageObject` hint, step order, kept lines, the removal hook.
- `apps/api/test/user-data/user-data-purge.db.spec.ts` (real PostgreSQL, destructive; run alone): the platform's real `UserPurgeRunner` and `FactoryResetHandler` with MemoriaHub's registrations; a personal-plus-shared-circle user, the removal hook (refusal, reassignment, user row deleted without a foreign-key error) and a factory reset, table by table, with every file deleted through its own provider.
- `apps/web/src/__tests__/config/dangerZone.test.ts`: both Danger Zone groups last (`dangerZoneLastViolations`), the card permissions.

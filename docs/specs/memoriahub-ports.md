# MemoriaHub host ports (`@marinoscar/memoriahub-api/ports`)

RETRO-J4 (#610), epic #558, program #555. Decision record: [ADR 0001](../decisions/0001-packages-first.md). Package standard: [PACKAGES.md](../PACKAGES.md). Precedent: the `kvox-api` ports of the KVox repository (`packages/kvox-api/src/ports/`, bound in `apps/api/src/platform-kvox/`).

## 1. Why ports

The domain slices (media, face, tagging, search, memories, workflows, review runs, location, dedup, burst, social media, enhancement, insights) are about to move out of `apps/api/src` into `@marinoscar/memoriahub-api` (J5 to J10). Today every one of them calls the platform directly: `JobsService` and `JobHandler`, `AiService`, the storage provider, `NotificationsService`, the settings services, `CredentialsService`, `OwnerAccessService`, `AppMetricsService`, the event bus. A package that kept those imports could not be installed by a host that carries no platform (the bare host, the worker), and a slice that imports the platform is a fork waiting to happen.

So the **host-neutral rule** (ADR 0001, rule 6 of `check:memoriahub-slice-peers`, the ESLint ban in `eslint.config.mjs`): no file under `packages/memoriahub-api/src/**` imports `@marinoscar/platform-*` or an application workspace. Everything outside the domain is a **port**: an injection token plus an interface declared in `@marinoscar/memoriahub-api/ports` and bound by the host. The web app binds them in `apps/api/src/platform-memoriahub/`.

J4 creates the package skeleton, the ports and the adapters only. **No domain code moves and nothing calls a port yet**: the application behaves exactly as before (the OpenAPI document, every job type string and the queue's behaviour are unchanged; `test/jobs/job-type-snapshot.spec.ts` and the `host` conformance suite stay green).

Decision 2 of the issue (pin `@marinoscar/platform-api` as an optional peer, as kvox does) was **not** taken: the ports are structural, the jobs adapter adapts a `MemoriahubJobHandler` to a platform `JobHandler` field by field (no cast on the handler's own members), and the package has no platform peer at all, which is what rule 6 asks for.

## 2. Tokens and binding

Every token is `Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_<NAME>')`, so two copies of the package agree on identity; the description string is permanent. A host binds them with one call:

```ts
MemoriahubPortsModule.forRoot({
  ports: {
    prisma, jobs, ai, objectStore, access, identity, notify, settings, secrets,   // required
    events, audit, webhooks, metrics,                                              // optional
    imports: [/* modules the useClass bindings need */],
  },
});
```

Each binding is `useClass`, `useExisting`, `useValue` or `useFactory` (a Nest custom provider without the token). The module is global: a slice imports nothing to inject a port. `forRoot` throws, naming every missing required port, so a forgotten binding stops the boot. Optional ports default to an in-process emitter (`InProcessMemoriahubEvents`) and three no-ops (`NOOP_MEMORIAHUB_AUDIT`, `NOOP_MEMORIAHUB_WEBHOOKS`, `NOOP_MEMORIAHUB_METRICS`).

In the web app: `apps/api/src/platform-memoriahub/platform-memoriahub.module.ts` (`PlatformMemoriahubModule`, mounted last in `app.module.ts`; `createPlatformMemoriahubModule(overrides)` for tests). `PlatformMemoriahubDepsModule` imports what the adapters need and no module exports on its own: the AI slice, the credential store, the storage providers and processor registry, `OwnerAccessModule`, the webhooks slice, and it provides `JwtAuthGuard` and `StorageProviderResolver`.

## 3. The ports

Each row names the platform service the web adapter wraps and the call sites in `apps/api/src` the port will serve once their slice moves (counts are import sites of the domain folders, excluding `platform/` and `app-registrations/`, at the time of J4).

| Token | Interface | Web adapter (`platform-memoriahub/`) | Serves (call sites) |
|---|---|---|---|
| `MEMORIAHUB_PRISMA` | `MemoriahubPrismaClientLike`: `$queryRaw`, `$executeRaw`, both `$transaction` forms, `runInOrg(orgId, fn, { userId })` | none: `useExisting: PrismaService`; `prismaServiceIsThePrismaPort` is the compile-time proof | every service (raw SQL for pgvector, `FOR UPDATE SKIP LOCKED`, the dedup indexes) |
| `MEMORIAHUB_JOBS` | `MemoriahubJobsPort`: `enqueue` (`{ id, deduplicated }`), `enqueueWithin`, `enqueueHousekeeping`, `registerHandler`, `isRegistered`, `onSettled`, `findActive`, `runInJobScope`, `tempPath`; `MemoriahubJobHandler`, `MemoriahubRateLimitError` | `jobs/platform-memoriahub-jobs.adapter.ts` over `JobsService`, `JobHandlerRegistry`, `ProviderThrottleService`, `JobScope` | the 38 handler types (about 46 `JobHandler` imports), 11 `enqueueHousekeepingJob` crons, the `EnrichmentJobFacade`, the admin "is it running" checks |
| `MEMORIAHUB_AI` | `MemoriahubAiPort`: `forUser(userId, scope)`, `forSystem(scope)`, `registerFeature`; `MemoriahubAiClient`: `respond`, `respondStructured`, `stream`, `openStream`, `embed`, `editImageInline`, `transcribeInline`; `MemoriahubAiError` (`errorClass`) | `ai/platform-memoriahub-ai.adapter.ts` over `AiService` | the seven registered features: tagging, video tagging and transcription, semantic embedding, the search agent (SSE, tool calls), memory titles, the picture enhancer |
| `MEMORIAHUB_OBJECT_STORE` | `MemoriahubObjectStorePort`: `active()`, `forLocation(provider, bucket)`, `signedUrlForObject`, `registerKeyPrefixes`, `registerProcessor`; `MemoriahubObjectStore`: `upload` (stream), `download`, `getSignedDownloadUrl`, `getSignedPutUrl`, `delete`, `deleteMany`, `exists`, `size`; `MemoriahubObjectProcessor` | `object-store/platform-memoriahub-object-store.adapter.ts` over `StorageProviderResolver`, `ObjectProcessorRegistry`, the key-prefix registry | media, thumbnails, face frames, enhanced copies, avatars, public links, the node claim and the backup feed (about 26 files), the seven post-upload processors |
| `MEMORIAHUB_ACCESS` | `MemoriahubAccessPort`: `requireOwnerRole`, `hasOwnerBypass`, `roleIn`, `rolesOf`, `scopesOf`, `writableScopesOf`, `personalLibraryOf`, `invalidateMembers`, `grantAllows`, `grantsAllowAll`, `sharedWhere`, `deleteGrantsFor`, `allScopes`, `allScopeIds`, `scopeSummary`, `scopeExists`, `membersOf`, `userNames` | `access/platform-memoriahub-access.adapter.ts` over `OwnerAccessService`, `RecordAccessService`, `OwnerScopeSweepService` | every media, album, face, burst, dedup, search and review route and every per-scope cron or backfill (about 40 files) |
| `MEMORIAHUB_IDENTITY` | `MemoriahubIdentityPort`: `authenticate(context)`, `hasPermission`, `permissionsOf`; `MemoriahubPrincipal` (with the credential kind) | `identity/platform-memoriahub-identity.adapter.ts` over `JwtAuthGuard`, `principalFactory` | controllers of the moved slices, background code acting for a user |
| `MEMORIAHUB_NOTIFY` | `MemoriahubNotifyPort`: `registerEvents`, `registerEmailTemplates`, `notify`, `notifyCounted`, `notifyState`, `notifyNow`, `notifyAddress` | `notify/platform-memoriahub-notify.adapter.ts` over `NotificationsService`, `registerNotification`, the email template registry | `upload_completed`, `enrichment_failed`, `workflow_run_completed`, `share_expiring`, `memories_ready`, the four `review_queue_*` states, the memories digest and the membership confirmation (about 13 `NotificationsService` sites) |
| `MEMORIAHUB_SETTINGS` | `MemoriahubSettingsPort`: `registerNamespace`, `readSystem`, `patchSystem`, `readUser`, `patchUser`, `readUserTimeZone` | `settings/platform-memoriahub-settings.adapter.ts` over `AppSystemSettingsService`, `UserSettingsService`, `UserTimeZoneService` | the `features`, `memories`, `workflows`, `dedup`, `burst`, `locationInference`, `locationGrouping`, `socialMedia`, `pictureEnhancement`, `reviewRuns`, `autoTagging`, `face`, `geo`, `backup` and `storage.*` namespaces and the user `memories`, `search`, `timezone` ones (about 14 files plus the Doctor checks) |
| `MEMORIAHUB_SECRETS` | `MemoriahubSecretsPort`: `registerPurpose`, `get`, `set`, `delete`, `status` | `secrets/platform-memoriahub-secrets.adapter.ts` over `CredentialsService` | the CompreFace base URL and the Google reverse-geocoding key (`face_compreface`, `geo_provider`) |
| `MEMORIAHUB_EVENTS` (optional) | `MemoriahubEventsPort`: `emit`, `subscribe` | `events/platform-memoriahub-events.adapter.ts` over `EVENT_BUS` | the object-processed and review-group events and their listeners (listeners decide and enqueue, never do I/O) |
| `MEMORIAHUB_AUDIT` (optional) | `MemoriahubAuditPort`: `record` | `audit/platform-memoriahub-audit.adapter.ts` over `AUDIT_SINK` | `burst_group:resolved`, `media_enhancement:applied`, `memory:deleted` and the other destructive actions |
| `MEMORIAHUB_WEBHOOKS` (optional) | `MemoriahubWebhooksPort`: `emit` | `webhooks/platform-memoriahub-webhooks.adapter.ts` over `WebhooksService` | the events `MemoriaHubWebhooks` raises after a write commits |
| `MEMORIAHUB_METRICS` (optional) | `MemoriahubMetricsPort`: `add`, `record` | `metrics/platform-memoriahub-metrics.adapter.ts` over `AppMetricsService` | the 21 `app.*` metrics of `memoriahub-metrics.manifest.ts` (about 30 `AppMetricsService` sites) |

### Rules that are part of a port's contract

- **Jobs.** A job `type` string is permanent. `profile` is exactly `{ maxRuntimeMs, maxAttempts }`. Node eligibility is derived from `nodeResultSchema` plus `persistNodeResult`; one without the other, or a handler with `usesAi: true` and either, is refused at registration (AI jobs are server-only, permanently). `MemoriahubRateLimitError` defers a job without charging an attempt (the adapter translates it to the platform's `RateLimitError` and registers the named throttle bucket). Dedup is one pending or running job per type and subject unless `skipDedup`. A job with a subject belongs to the default organization, a subject-less one to none, an explicit `orgId` wins. A `@Cron` body only calls `enqueueHousekeeping`.
- **AI.** A key never crosses the port: the platform resolves it per call (user, organization, then deployment) and drops it. `forSystem` is for jobs, `forUser` for a route. `openStream` throws a refusal (kill switch, no key, a model that cannot call tools) before the caller's first response byte. Errors are `MemoriahubAiError` with a class a slice branches on (`rate_limit` carries `retryAfterMs`); `asJobError` and `aiRateLimit` (core) turn a rate limit into the queue's deferral.
- **Access.** The only way a slice decides access. `requireOwnerRole` answers not-found, never forbidden, to a non-member and for an unknown scope, and forbidden to a member below the role. A grant can only add access (`grantAllows`, `grantsAllowAll`, `sharedWhere`); group-admin-only actions never fall back to one. `sharedWhere` is AND-ed with a list's own filters, never spread into them.
- **Identity and the guard.** A slice's controllers declare `@MemoriahubAuth({ permissions?, roles?, anyPermissions?, credentials?, public? })` from `@marinoscar/memoriahub-api/core` and read the caller with `@MemoriahubCurrentUser()` and `@MemoriahubAuthCredential()`; `MemoriahubAuthGuard` authenticates through the port and checks role, then permission, then credential kind, with the web edition's refusal messages (`Required roles: ...`, `Missing permissions: ...`, 401 body of the platform's own guard, carried through `MEMORIAHUB_AUTH_FAILURE_PROPERTY`). The decorator writes the metadata keys (`roles`, `permissions`, `anyPermissions`, `isPublic`) and the OpenAPI `x-rbac` extension, `JWT-auth` security and 401/403 responses the platform `@Auth()` writes, so the host's document pass and permission checks read the packaged routes unchanged. The host binds the port with an adapter over its guard and proves it with `describeMemoriahubAuthGuardConformance`. A packaged controller is an exported class the host mounts in its own module: OpenAPI path order follows module order, and mounting it where the old controller sat keeps the document byte-identical. The platform identity suite cannot see the packaged guard, so the host's conformance spec walks those controllers with its own `memoriahub-guarded routes` rules.
- **Notify.** Every write is detached and never throws; call after the triggering write commits, outside any transaction. `notifyCounted` folds into one row; `notifyState` keeps one live row per user, scope and event. Event keys and template names are permanent.
- **Settings.** A namespace is declared before the application starts (the platform freezes its registries); `registerNamespace` verifies the declaration exists. A secret is never a setting. `readUserTimeZone` fails open to `UTC`; a capture date never reads it.
- **Secrets.** `status` never returns material.
- **Object store.** Bytes are never buffered whole. Always resolve the RECORDED provider (`forLocation`) for an existing object.
- **Prisma.** A write to an `org` table runs in `runInOrg` (transaction-local scope); never a `forOrg` client inside `$transaction`.

### What is not a port, and why

- **Maintenance mode, clock, ids.** No domain code reads them.
- **Resumable upload, part URLs, `partUploadAuth`.** The platform objects API owns the upload protocol; the domain only registers the finished object. (The issue listed them; the call sites that need them are the platform's controllers.)
- **`openRead` with Range.** The platform driver has no ranged read: a Range request goes to a signed URL (`getSignedDownloadUrl`), which is what the public-link and media routes do today.
- **Retention policies, job reasons, job type labels.** Registered at import time by `app-registrations/`; they take effect before a port can exist. A slice exports its declarations and the host registers them (as `registerJobTypeLabel` is today).
- **Guard and decorator (`@Auth`).** Not in `core` yet: the controllers of the first slices stay in the app. If a slice moves its controller, J5 adds an identity-backed guard to `core` (kvox's `KvoxAuthGuard` is the model).
- **Webhook event catalog.** `MemoriaHubWebhooks` and the event definitions stay in the app until a slice that emits needs them in the package.

## 4. `core`

`MemoriahubPortsModule.forRoot`, the defaults above, `Prisma.sql|raw|join` (the optional `@prisma/client-runtime-utils` peer, loaded on first use), `MemoriahubError` (a domain refusal with a `reason`, reported under `details`, never at the top level of the error body) and `MemoriahubFeatureDisabledError`, `asJobError` and `aiRateLimit`, and `isFeatureEnabled(settings, flag, killSwitchEnv?)` (the `features.<flag>` setting AND its kill switch, through the cached settings read).

## 5. `testing` and the conformance kit

`createFakeMemoriahubPorts()` builds an in-memory fake of every port; `fakeMemoriahubBindings(fakes)` turns them into `forRoot` bindings. A slice's unit test builds a Nest testing module on those and needs neither the platform nor a database. The fakes enforce the same rules as the adapters (dedup, the node-pair refusals, the not-found rule, version checks, `status` without material).

`describeMemoriahubPortsConformance(name, factory, harness, { skip })` is test-runner neutral. One section per port; a port the factory omits fails unless named in `skip`. It asserts, among other rules: dedup collapses and `skipDedup` does not; a handler runs and the settled event reports it; attempts are spent before a terminal failure; a rate limit defers instead of failing; an AI handler cannot be node-eligible; a non-member of a scope is answered not-found and a member below the role forbidden; a grant adds access to one record and nothing else; an unauthenticated request yields `null`; notifications never throw; a failing event listener cannot break the emitter; a stale settings version is refused; `status` never contains the secret; an AI failure carries a class and no key material; an object round-trips and a missing one fails.

Runs:

- the package's own fakes: `packages/memoriahub-api/test/ports-conformance.spec.ts`;
- the web adapters over stand-ins for the I/O underneath (`jobs` rows, the model provider, the storage driver, memberships, credential and settings rows): `apps/api/test/platform-memoriahub/ports-conformance.spec.ts`; the platform registries, `OwnerAccessService`, `RecordAccessService`, `OwnerScopeSweepService` and the platform helpers are real;
- `MEMORIAHUB_PRISMA` over the real `PrismaService` and PostgreSQL (`runInOrg` is transaction-local, also after a rollback, also under concurrency): `apps/api/test/platform-memoriahub/ports-conformance.db.spec.ts` (skipped, never passed, when no database listens).

## 6. Declaring a slice's ports (what J5 to J10 do)

1. The slice folder `packages/memoriahub-api/src/<slice>/` imports `../ports/index.js` and `../core/index.js` only (`packages/memoriahub-slices.json`: `"<slice>": ["ports", "core"]`, plus the other slices it depends on). Its peers go in `memoriahub-slice-peers.json` (`@nestjs/common`, `zod`, `@marinoscar/memoriahub-contract`, ...; the check fails on an undeclared import).
2. A provider injects a port with `@Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort`. A handler is a `MemoriahubJobHandler` registered in `onModuleInit` through `jobs.registerHandler(this)` (the adapter keeps `type`, `profile`, the node pair, `nodeSecretBroker`, `canDelete`).
3. A slice declares what it needs registered at start-up through the ports: `settings.registerNamespace`, `notify.registerEvents`, `secrets.registerPurpose`, `objectStore.registerKeyPrefixes`, `ai.registerFeature`. In the web app those declarations already exist in `app-registrations/` before the application is created, so the calls verify and remember defaults; a slice never relies on being first.
4. Its unit tests build a Nest testing module on `fakeMemoriahubBindings()`; a database-backed rule is a `*.db.spec.ts` in the package's `db` Jest project (`npm run test:db -w @marinoscar/memoriahub-api`).
5. A new need of the platform is a new method on an existing port or a new port (with a fake and a conformance rule), never a platform import in the slice. Add to a port, never rename or remove.

## 7. Bare-host notes

A host with no platform binds: Prisma (any client with `runInOrg` that sets a transaction-local scope, or a thin wrapper), jobs (an in-process queue honouring the dedup and deferral rules; `FakeMemoriahubJobs` is the reference), AI, an object store (a local-disk driver), access (owner-only: `grantAllows` false, `sharedWhere` null, the same not-found rule), identity (one local user), notify (an OS notification), settings (a file), secrets (the keychain). Events, audit, webhooks and metrics may be left unbound. `describeMemoriahubPortsConformance` is the acceptance test.

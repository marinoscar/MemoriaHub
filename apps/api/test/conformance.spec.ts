// =============================================================================
// Platform conformance (RETRO-B1, #597)
// =============================================================================
//
// The platform's invariants, run against MemoriaHub's own module graph. Each
// adopted slice adds its suite here (RETRO-B1b doctor, RETRO-B2 identity, ...);
// a slice not adopted yet has no entry rather than a skip, because there is
// nothing to opt out of.
//
// `doctor-read-only` (`@marinoscar/platform-api/doctor/testing`): every Doctor
// check writes no row, job or object and holds no side-effecting test service.
//
// `identity` (`@marinoscar/platform-api/identity/testing`, RETRO-B2): every route
// declares `@Auth(...)` or `@Public()`, every permission a route names is
// registered with a scope, no seeded grant crosses a scope, and `nod_` tokens are
// refused outside `/api/nodes` while `pat_` tokens resolve everywhere.
//
// `user-owned-data` (`@marinoscar/platform-api/testing`, RETRO-B2): every foreign
// key to `User` has a registry entry whose purge policy matches the relation's
// `onDelete`, and only allowlisted files issue raw SQL.
//
// `settings` (`@marinoscar/platform-api/settings/testing`, RETRO-B3): no registered
// system or user namespace declares a secret-named field, every default satisfies
// its stored schema, every org layer is gated by registered org permissions.
//
// `credentials` (`@marinoscar/platform-api/credentials/testing`, RETRO-B4): purpose owners, addresses
// and the no-secret-egress shape of the credential info schemas.
//
// `db-backup` (`@marinoscar/platform-api/db-backup/testing`, RETRO-D4): both halves of the RLS pair
// on pg_dump and pg_restore, the restore server-only and the backup node-eligible, system-scope
// permissions, the `database-backups/` prefix with deployment scope, and every registered
// carry-over binding `$1` (MemoriaHub's Android releases carry is required).
// `email` (`@marinoscar/platform-api/email/testing`, RETRO-D2): the platform templates
// are registered, every sampled template (the platform's plus this app's three) renders
// a complete document with its data escaped, and no email settings shape carries a secret.
//
// `notifications` (`@marinoscar/platform-api/notifications/testing`, RETRO-D3):
// the platform channels and the platform's own events are registered, every event that
// declares email has a bound template, no `notify*()` sits inside a `$transaction`, and
// the Web Push shapes carry no secret. The registrations come from
// `src/platform/notifications/notification.manifest.ts` (MemoriaHub's nine events).
// `ai-*` (`@marinoscar/platform-api/ai/testing`, RETRO-E1): `ai-no-sdk-leak` (no provider SDK
// imported in apps/api, apps/cli or apps/web, none declared by an app manifest) and
// `ai-orchestration-boundary` (no orchestration library anywhere) run here; the five suites that
// boot the AI runtime run in test/ai-conformance.spec.ts over `AiConformanceFixture` (RETRO-E4).
//
// `alerts` (`@marinoscar/platform-api/alerts/testing`, RETRO-H5): the routes' permissions, the
// starter rules, the open-incident index and the evaluation invariants (see the entry below).
//
// `user-data` (`@marinoscar/platform-api/user-data/testing`, RETRO-H1): every owner model
// (a user-owned registry entry with an `ownerField`) is kept with a reason or deleted in a
// registered category that `everything` reaches; every hint and scope names what exists; the
// relation-ordered delete plan exists for the composed schema.
//
// `onboarding` (`@marinoscar/platform-api/onboarding/testing`, RETRO-H3): the step and fact
// registries are consistent, every step's permission is registered, each fact resolves once and no
// step's `evaluate` reads anything.
// `webhooks` (`@marinoscar/platform-api/webhooks/testing`, RETRO-H4): every route of the three
// webhook controllers enforces exactly its tier's permission, deliveries verify with
// `verifyWebhookSignature`, the SSRF guard refuses non-public targets at create and at send, the
// signing secret never leaves create/rotate, nothing makes an HTTP request outside the delivery job,
// and endpoints never cross owners, scopes or organizations. It drives the slice over in-memory ports.
//
// `exports` (`@marinoscar/platform-api/exports/testing`, RETRO-H2): source permissions, writers,
// the credential-model policy and the secret-egress sentinel run (see the entry below).
//
// `host` (`@marinoscar/platform-api/host/testing`): a walk of `AppModule` from
// its root. `MaintenanceGuard` is the first and only global guard,
// `PlatformHostCoreModule.forRoot()` is imported exactly once, and the
// `{ data }` envelope and the exception filter are global exactly once each.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { permissionRegistry, roleRegistry, userOwnedModelRegistry } from '@marinoscar/platform-api/core';

import '@marinoscar/platform-api/ai/testing';
import '@marinoscar/platform-api/android-app/testing';
import '@marinoscar/platform-api/alerts/testing';
import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/db-backup/testing';
import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/email/testing';
import '@marinoscar/platform-api/exports/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/jobs/testing';
import '@marinoscar/platform-api/notifications/testing';
import '@marinoscar/platform-api/onboarding/testing';
import '@marinoscar/platform-api/settings/testing';
import '@marinoscar/platform-api/storage/testing';
import '@marinoscar/platform-api/sharing/testing';
import '@marinoscar/platform-api/user-data/testing';
import { composedSchemaDatamodel } from '@marinoscar/platform-api/user-data';
import '@marinoscar/platform-api/webhooks/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';
import { Prisma } from '@prisma/client';

import { DOCTOR_FORBIDDEN_SERVICES } from '@marinoscar/platform-api/doctor/testing';

import { Module } from '@nestjs/common';
import { AppModule } from '../src/app.module';
// Declares the credential purposes the `credentials` suite reads.
import { APP_CREDENTIAL_OWNERS } from '../src/platform/credentials/credential-purposes.manifest';
// Fills the role, permission and ownership registries the suites read.
import '../src/app-registrations/permission-manifest';
import '../src/app-registrations/ownership-manifest';
import { MEMORIAHUB_REQUIRED_CARRY_OVER_IDS } from '../src/app-registrations/db-backup';
import { MEMORIAHUB_REQUIRED_KEY_PREFIX_IDS } from '../src/platform/storage/storage-key-prefix.manifest';
// Configures email rendering and registers this app's templates (the `email` suite renders them).
import '../src/platform/email/email.config';
// Registers the notification channels and events the `notifications` suite reads (RETRO-D3).
import '../src/platform/notifications/notification.manifest';
// Registers the alerts slice's metrics and MemoriaHub's two rule kinds (RETRO-H5).
import '../src/app-registrations/alerts';
// Fills the user-data registries (categories, scopes, model hints, factory reset steps).
import '../src/platform/user-data/user-data.manifest';
import { RAW_SQL_ALLOWLIST } from './conformance/raw-sql-allowlist';
import { API_SOURCE_ROOT, CRON_SOURCE_ROOTS } from './jobs/cron-source-roots';
import { EMAIL_TEMPLATE_SAMPLES } from './conformance/email-samples';
import { doctorConformanceFixture } from './conformance/doctor-fixture';
// Registers the exports slice's writers and sources (platform `user-data` / `org-data` plus
// MemoriaHub's four) the `exports` suite reads (RETRO-H2; AppModule imports it too).
import '../src/platform/exports/exports.config';
// Fills the onboarding step and fact registries the `onboarding` suite reads (AppModule imports it too).
import '../src/platform/onboarding/onboarding.manifest';
// The sharing slice's registrations (RETRO-I1); AppModule imports them too.
import { MEMORIAHUB_GROUP_OWNED_MODELS } from '../src/app-registrations/sharing';
// The android-app slice's composition: the Media Sync device source it reads (RETRO-D5; AppModule imports it too).
import '../src/platform/android-app/android-app.config';
import { IS_PUBLIC_KEY } from '@marinoscar/platform-api/identity';
import { discoverControllers } from '@marinoscar/platform-api/identity/testing';
import { MEMORIAHUB_PERMISSIONS_KEY, MEMORIAHUB_ROLES_KEY, MemoriahubAuthGuard } from '@marinoscar/memoriahub-api/core';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The platform's raw-SQL index list (`@marinoscar/platform-db/raw-sql-indexes.json`): the
// alerts suite requires the one-open-incident index of migration `0040_add_alerts` on it.
const PLATFORM_RAW_SQL_INDEX_NAMES: string[] = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules', '@marinoscar', 'platform-db', 'raw-sql-indexes.json'), 'utf8'),
  ) as { indexes: { name: string }[] }
).indexes.map((index) => index.name);

/** Nest's metadata key for the guards a controller or handler declares. */
const GUARDS_METADATA = '__guards__';

/**
 * The root the platform's identity suite walks: every controller reachable from `AppModule` EXCEPT the
 * ones the `@marinoscar/memoriahub-api` slices guard with `@MemoriahubAuth` (RETRO-J5, #613).
 *
 * The suite's route-access rule asks for the platform's `JwtAuthGuard` on the route, and a packaged slice
 * cannot name that class (the host-neutral rule): its guard authenticates through the identity port, whose
 * web-edition adapter delegates to `JwtAuthGuard`. Those routes are held to the same two rules by the
 * `memoriahub-guarded routes` block below instead, so no route leaves the identity checks unproven.
 */
function handlersOf(controller: Function): Array<{ name: string; handler: Function }> {
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => ({ name, handler: controller.prototype[name] as Function }))
    .filter(({ handler }) => typeof handler === 'function' && Reflect.getMetadata('path', handler) !== undefined);
}

function isMemoriahubGuarded(controller: Function): boolean {
  return [controller, ...handlersOf(controller).map(({ handler }) => handler)].some((target) =>
    ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[]).includes(MemoriahubAuthGuard),
  );
}

const IDENTITY_CONTROLLERS = discoverControllers(AppModule).filter((controller) => !isMemoriahubGuarded(controller));
const MEMORIAHUB_GUARDED_CONTROLLERS = discoverControllers(AppModule).filter(isMemoriahubGuarded);
@Module({ controllers: IDENTITY_CONTROLLERS })
class IdentityConformanceRoot {}

runPlatformConformance({
  sourceRoots: [...CRON_SOURCE_ROOTS],
  suites: {
    // Identity (RETRO-B2, #611). The walk reads Nest metadata from AppModule; the
    // registries are the ones `permission-manifest.ts` filled.
    identity: {
      rootModule: IdentityConformanceRoot,
      permissions: permissionRegistry.list(),
      roles: roleRegistry.list(),
      grants: permissionRegistry
        .list()
        .flatMap((permission) => permission.defaultGrants.map((role) => ({ role, permission: permission.id }))),
      minRoutes: 100,
    },

    // Every foreign key to User is classified; raw SQL only where listed.
    userOwnedData: {
      schemaPath: join(__dirname, '..', 'prisma', 'schema'),
      policies: userOwnedModelRegistry.list(),
      rawSqlAllowlist: RAW_SQL_ALLOWLIST,
      registerIn: 'apps/api/src/app-registrations/user-owned-models.ts',
    },

    // The settings slice (RETRO-B3, #614). The registries are filled by importing
    // `src/settings/registry` (AppModule does). `minSystemNamespaces` is a vacuity
    // guard: 20 app namespaces plus the platform's `maintenance`, `jobs` and `retention`.
    settings: {
      permissions: permissionRegistry.list().map((permission) => ({ id: permission.id, scope: permission.scope })),
      minSystemNamespaces: 23,
    },

    // The credentials slice (RETRO-B4, #617): every registered purpose names a platform slice or one of
    // this app's owners as its owner, every user purpose's fallback address resolves, and no credential
    // `*Info` schema can carry a secret.
    credentials: { appOwners: [...APP_CREDENTIAL_OWNERS] },

    // Jobs (RETRO-C1, #575; both suites ON since RETRO-C9, #612).
    // `cron-enqueue-only`: every `@Cron` body enqueues (`enqueueHousekeepingJob` or
    // `JobsService.enqueue`) and does no work inline. RETRO-C9 moved the last inline
    // bodies into jobs (`workflows.schedule_tick`, `workflows.micro_run_finalize`,
    // `notifications.review_queue_reconcile`, `shares.expiring_sweep`,
    // `node_backup.stale_sweep`; test/jobs/cron-tasks.conformance.spec.ts). The three
    // permanent platform exemptions are not listed: the installed package ships no
    // `.ts` sources to scan (test/jobs/cron-source-roots.ts). The two temporary exemptions for the
    // legacy worker-node crons left with RETRO-C2 (#581): the platform nodes slice's fleet crons
    // only enqueue `nodes.fleet.sweep` / `nodes.fleet.prune`.
    cronEnqueueOnly: {
      exempt: [],
      // 12 cron files in apps/api/src after RETRO-C2 removed the two worker-node crons; the floor is a vacuity guard.
      minCronFiles: 12,
    },
    // Since RETRO-D1 post-upload processing is the platform's `storage.object.process` job; the
    // object-processing listener that downloaded bytes is gone.
    // RETRO-C9 (#612): the listeners the issue names are pinned with `mustScan`, so a move cannot
    // drop one out of the scan silently.
    onEventNoIo: {
      minListenerFiles: 7, // 7 since RETRO-D3 removed the broadcast-failure listener
      mustScan: [
        'media/sync/media-metadata-sync.listener.ts',
        'media/enrichment/media-enrichment-enqueue.listener.ts',
        'workflows/runs/workflow-trigger.listener.ts', // the app's listener over the workflows slice's settlement service
        'notification-producers/enrichment-failure-notification.listener.ts',
        'media-processing/media-object-processing.service.ts',
      ],
    },

    // Every MemoriaHub writer's key prefix is registered (platform/storage/storage-key-prefix.manifest.ts).
    storage: { requiredPrefixIds: [...MEMORIAHUB_REQUIRED_KEY_PREFIX_IDS] },

    // Database backup and restore (RETRO-D4, #580).
    dbBackup: { requiredCarryOverIds: [...MEMORIAHUB_REQUIRED_CARRY_OVER_IDS] },
    // The email slice (RETRO-D2, #570). `samples` adds this app's three templates to the
    // rendering check, with hostile text in every field the escaping must catch.
    email: { samples: EMAIL_TEMPLATE_SAMPLES },
    // The notifications slice's registrations (RETRO-D3, #576). No file is allowlisted.
    notifications: { afterCommitAllowlist: [] },

    // The alerts slice (RETRO-H5, #609): every `/api/admin/alerts` route authenticated with exactly
    // `alerts:read` (GET) or `alerts:write`, the built-in kinds registered, every starter rule valid
    // and seeded disabled, the one-open-incident index on the raw-SQL list, no transaction around a
    // dispatch, the node-event listener doing no I/O, two evaluations leaving one incident.
    alerts: { rawSqlIndexNames: PLATFORM_RAW_SQL_INDEX_NAMES },

    // The android-app slice (RETRO-D5, #586): assetlinks public and read-only, the signed download
    // the only other public route, admin routes on exactly system_settings:read/write, the
    // one-current index on the platform's raw-SQL list, `android-releases/` kept by the factory
    // reset and the `android_app` channel registered covered by push.
    androidApp: { rawSqlIndexNames: PLATFORM_RAW_SQL_INDEX_NAMES },

    // MaintenanceGuard is the application's only global guard: MemoriaHub has no
    // global JWT guard (every route declares its own @Auth()/@Public()) and no
    // global throttler. If one is ever added, list it here with a reason.
    host: { rootModule: AppModule },

    // The webhooks slice (RETRO-H4, #603). No extra blocked ranges: the platform's list
    // (loopback, private, link-local, metadata, CGNAT, multicast, IPv4-mapped) covers this app.
    webhooks: {},

    // The AI slice (RETRO-E1, #595). The two static suites run.
    //   - ai-no-sdk-leak: no provider SDK is imported anywhere in the app trees (`providerDirs: []`,
    //     MemoriaHub registers no provider of its own) and no app manifest declares one; the SDKs
    //     are declared only by the two platform packages that own them. NOT scanned:
    //     `packages/memoriahub-compute`, the worker-node compute package that still imports the
    //     `openai` and `@anthropic-ai/sdk` SDKs for the node-side `auto_tagging` /
    //     `video_auto_tagging` calls under a brokered per-job key (PLATFORM-ADOPTION-SHIM(#1083):
    //     the platform's node credential delivery, EnterpriseAppBase #1083, is unreleased; the node
    //     compute moves server-side or onto platform executors in RETRO-C4/C10).
    //   - ai-orchestration-boundary: no orchestration library anywhere (`allowedRoots: {}`).
    aiNoSdkLeak: {
      apiTrees: [
        // A vacuity floor: the media slices keep moving into packages/memoriahub-api (RETRO-J5..J10), so the app's tree shrinks.
        { name: 'apps/api', root: join(REPO_ROOT, 'apps', 'api', 'src'), minFiles: 350 },
        { name: 'apps/cli', root: join(REPO_ROOT, 'apps', 'cli', 'src'), minFiles: 50 },
      ],
      webTrees: [
        // A vacuity floor: 171 source files after RETRO-J11 (#626) moved the web slices into packages/memoriahub-web (was 200+).
        { name: 'apps/web', root: join(REPO_ROOT, 'apps', 'web', 'src'), minFiles: 150 },
        // The moved code stays under the SDK-leak guard: 330 source files at RETRO-J11.
        { name: 'packages/memoriahub-web', root: join(REPO_ROOT, 'packages', 'memoriahub-web', 'src'), minFiles: 300 },
      ],
      providerDirs: [],
      sdkOwner: [
        {
          manifest: join(REPO_ROOT, 'node_modules', '@marinoscar', 'platform-ai-providers', 'package.json'),
          declares: ['openai', '@anthropic-ai/sdk'],
        },
        {
          manifest: join(REPO_ROOT, 'node_modules', '@marinoscar', 'platform-api', 'package.json'),
          declares: ['openai', '@anthropic-ai/sdk'],
        },
      ],
      noSdkManifests: [
        join(REPO_ROOT, 'package.json'),
        join(REPO_ROOT, 'apps', 'api', 'package.json'),
        join(REPO_ROOT, 'apps', 'web', 'package.json'),
        join(REPO_ROOT, 'apps', 'cli', 'package.json'),
        join(REPO_ROOT, 'packages', 'shared', 'package.json'),
      ],
    },
    aiOrchestrationBoundary: {
      apiSourceRoots: [join(REPO_ROOT, 'apps', 'api', 'src'), join(REPO_ROOT, 'apps', 'cli', 'src')],
      webSourceRoots: [join(REPO_ROOT, 'apps', 'web', 'src')],
      packageJsonPaths: [
        join(REPO_ROOT, 'package.json'),
        join(REPO_ROOT, 'apps', 'api', 'package.json'),
        join(REPO_ROOT, 'apps', 'web', 'package.json'),
        join(REPO_ROOT, 'apps', 'cli', 'package.json'),
      ],
      allowedRoots: {},
    },
    // The five suites that boot the AI runtime (`ai-kill-switch`, `ai-rbac-matrix`,
    // `ai-secret-egress`, `ai-key-policy`, `ai-jobs-server-only`) run in test/ai-conformance.spec.ts
    // over `AiConformanceFixture` (test/conformance/ai-fixture.ts, RETRO-E4 #607): each boots the
    // app, so they run in their own file, with no skip.

    // The onboarding slice (RETRO-H3, #599): the registries are well formed, every step's permission
    // is one this app registers, and one derivation, for a caller holding every permission against a
    // spied data port, resolves each fact once and reads nothing while evaluating. The samples stand
    // in for MemoriaHub's six facts, which read Prisma and the settings service (app providers the
    // suite's probe does not have). Floor: 9 MemoriaHub steps plus the platform's kept built-ins.
    onboarding: {
      permissions: permissionRegistry.list(),
      factSamples: {
        'memoriahub.media_counts': { addedByUser: 0 },
        'memoriahub.album_counts': { addedByUser: 0 },
        'memoriahub.circle_membership': { collaboratorCircles: 1, otherMembers: 0, pendingInvites: 0 },
        'memoriahub.people_named': { named: 0 },
        'memoriahub.devices': { syncDevices: 0, activeTokens: 0 },
        'memoriahub.feature_readiness': {
          storageReady: false,
          faceRecognition: false,
          autoTagging: false,
          taggingProviderReady: false,
          memories: false,
        },
      },
      minSteps: 15,
    },

    // Rule 3 of the Doctor check contract (RETRO-B1b, #602): every registered
    // check is read-only. Suite id: `doctor-read-only`. The checks are DISCOVERED
    // from the booted app's registry; the floor is a vacuity guard, not a list.
    // `StorageSettingsService` is MemoriaHub's own side-effecting "test
    // connection" service (it writes a sentinel object), so a check holding it
    // is a regression. The AI, face and geo settings services stay allowed: see
    // the live-probe row of docs/platform-adoption/local-exceptions.md.
    // User data (RETRO-H1, #591): the keep-or-delete decision of every owner model,
    // against the composed schema the purge planner reads at bootstrap.
    userData: { datamodel: composedSchemaDatamodel(join(__dirname, '..', 'src', 'platform', 'user-data'))() },

    // The sharing slice (RETRO-I1, #562). No app file touches the sharing tables directly (one read-only link
    // listing exempt since RETRO-I4), the
    // public link route carries the identity slice's `@Public()` marker, and the three partial
    // unique indexes are in the installed platform migrations. RETRO-I2 (#569): every model with an
    // `owner_group_id` maps to a registered group-owned type, and the two shareable resource types
    // are pinned (their ids are permanent once grants exist).
    sharing: {
      schemaPath: join(__dirname, '..', 'prisma', 'schema'),
      migrationsDir: join(__dirname, '..', 'prisma', 'migrations'),
      rootModule: AppModule,
      isPublic: (target) => Reflect.getMetadata(IS_PUBLIC_KEY, target) === true,
      groupOwnedModels: { ...MEMORIAHUB_GROUP_OWNED_MODELS },
      resourceTypeIds: ['album', 'media_item'],
      minRoutes: 100,
    },

    // Data export (RETRO-H2, #596): every source's permission is registered and every source offers a
    // writer; every credential-shaped user-owned model is excluded or metadata-only; and the
    // `user-data` / `org-data` sources, run over a client that fills EVERY column with a sentinel,
    // write no redacted field into any byte of any format. MemoriaHub's own four sources are proven
    // the same way by test/exports/memoriahub-export.sources.spec.ts.
    exports: { datamodel: Prisma.dmmf.datamodel, permissions: permissionRegistry.list() },

    doctorReadOnly: {
      fixture: doctorConformanceFixture,
      minChecks: 30,
      forbiddenServices: [...DOCTOR_FORBIDDEN_SERVICES],
    },
  },
});

// memoriahub-guarded routes: the identity suite's two route rules, for the controllers it cannot see (see
// `isMemoriahubGuarded`). Every route of a controller a `@marinoscar/memoriahub-api` slice guards is
// authenticated through `MemoriahubAuthGuard` (or deliberately public), and every permission and role it
// names is registered.
describe('memoriahub-guarded routes', () => {
  it('finds the packaged controllers (a discovery mistake must not make this vacuous)', () => {
    expect(MEMORIAHUB_GUARDED_CONTROLLERS.map((controller) => controller.name)).toEqual(
      expect.arrayContaining([
        'MediaSyncController',
        'TrashEmptyRunsController',
        'TaggingController',
        'TagLabelsController',
        'AdminTaggingController',
        'SearchController',
        'SearchAgentController',
      ]),
    );
  });

  it.each(MEMORIAHUB_GUARDED_CONTROLLERS.map((controller) => [controller.name, controller] as const))(
    '%s: every route is behind MemoriahubAuthGuard and names only registered permissions and roles',
    (_name, controller) => {
      const permissions = new Set(permissionRegistry.list().map((entry: { id: string }) => entry.id));
      const roles = new Set(roleRegistry.list().map((entry: { id: string }) => entry.id));
      const problems: string[] = [];

      for (const { name, handler } of handlersOf(controller)) {
        const guards = [...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])];
        const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true || Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
        if (!isPublic && !guards.includes(MemoriahubAuthGuard)) problems.push(`${controller.name}#${name} is not behind MemoriahubAuthGuard`);

        for (const permission of (Reflect.getMetadata(MEMORIAHUB_PERMISSIONS_KEY, handler) ?? []) as string[]) {
          if (!permissions.has(permission)) problems.push(`${controller.name}#${name} names the unregistered permission "${permission}"`);
        }
        for (const role of (Reflect.getMetadata(MEMORIAHUB_ROLES_KEY, handler) ?? []) as string[]) {
          if (!roles.has(role)) problems.push(`${controller.name}#${name} names the unregistered role "${role}"`);
        }
      }

      expect(problems).toEqual([]);
    },
  );
});

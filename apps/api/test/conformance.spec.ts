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
// `ai-orchestration-boundary` (no orchestration library anywhere) run; the five suites that boot
// the AI runtime against an app fixture are wired and opted out with their reasons (RETRO-E4).
//
// `alerts` (`@marinoscar/platform-api/alerts/testing`, RETRO-H5): the routes' permissions, the
// starter rules, the open-incident index and the evaluation invariants (see the entry below).
//
// `user-data` (`@marinoscar/platform-api/user-data/testing`, RETRO-H1): every owner model
// (a user-owned registry entry with an `ownerField`) is kept with a reason or deleted in a
// registered category that `everything` reaches; every hint and scope names what exists; the
// relation-ordered delete plan exists for the composed schema.
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
import '@marinoscar/platform-api/alerts/testing';
import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/db-backup/testing';
import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/email/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/jobs/testing';
import '@marinoscar/platform-api/notifications/testing';
import '@marinoscar/platform-api/settings/testing';
import '@marinoscar/platform-api/user-data/testing';
import { composedSchemaDatamodel } from '@marinoscar/platform-api/user-data';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import { DOCTOR_FORBIDDEN_SERVICES } from '@marinoscar/platform-api/doctor/testing';

import { AppModule } from '../src/app.module';
// Declares the credential purposes the `credentials` suite reads.
import { APP_CREDENTIAL_OWNERS } from '../src/platform/credentials/credential-purposes.manifest';
// Fills the role, permission and ownership registries the suites read.
import '../src/app-registrations/permission-manifest';
import '../src/app-registrations/ownership-manifest';
import { MEMORIAHUB_REQUIRED_CARRY_OVER_IDS } from '../src/app-registrations/db-backup';
// Configures email rendering and registers this app's templates (the `email` suite renders them).
import '../src/platform/email/email.config';
// Registers the notification channels and events the `notifications` suite reads (RETRO-D3).
import '../src/platform/notifications/notification.manifest';
// Registers the alerts slice's metrics and MemoriaHub's two rule kinds (RETRO-H5).
import '../src/app-registrations/alerts';
// Fills the user-data registries (categories, scopes, model hints, factory reset steps).
import '../src/platform/user-data/user-data.manifest';
import { RAW_SQL_ALLOWLIST } from './conformance/raw-sql-allowlist';
import { EMAIL_TEMPLATE_SAMPLES } from './conformance/email-samples';
import { doctorConformanceFixture } from './conformance/doctor-fixture';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// The platform's raw-SQL index list (`@marinoscar/platform-db/raw-sql-indexes.json`): the
// alerts suite requires the one-open-incident index of migration `0040_add_alerts` on it.
const PLATFORM_RAW_SQL_INDEX_NAMES: string[] = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules', '@marinoscar', 'platform-db', 'raw-sql-indexes.json'), 'utf8'),
  ) as { indexes: { name: string }[] }
).indexes.map((index) => index.name);

runPlatformConformance({
  sourceRoots: [join(__dirname, '..', 'src')],
  suites: {
    // Identity (RETRO-B2, #611). The walk reads Nest metadata from AppModule; the
    // registries are the ones `permission-manifest.ts` filled.
    identity: {
      rootModule: AppModule,
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

    // Jobs (RETRO-C1, #575).
    // Both suites are wired and OPTED OUT with the reason, so the debt is visible in the run summary
    // until the issue that pays it enables the suite (with `exempt` for the three platform
    // exemptions only). Measured with the suites on at the cutover: 18 inline findings in 13 cron
    // files (the db-backup one is gone since RETRO-D4: the platform task only enqueues; insights, memories, node-backup, node-prune, notification-reconcile,
    // share-expiring, storage-cleanup, storage-processing-recovery and workflow crons) and one
    // listener download (storage/processing/object-processing.service.ts).
    cronEnqueueOnly: {
      skip:
        'RETRO-C9 (cron remediation) turns the crons that still work inline into enqueue-only ones; ' +
        'until then 13 cron files fail this suite. The queue they enqueue into is the platform\'s since RETRO-C1.',
    },
    onEventNoIo: {
      skip:
        'object-processing.service.ts downloads object bytes inside an OBJECT_UPLOADED_EVENT listener; ' +
        'the storage slice (RETRO-D1) moves it into a post-upload processor job. No other listener fails.',
    },

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

    // MaintenanceGuard is the application's only global guard: MemoriaHub has no
    // global JWT guard (every route declares its own @Auth()/@Public()) and no
    // global throttler. If one is ever added, list it here with a reason.
    host: { rootModule: AppModule },

    // The AI slice (RETRO-E1, #595). The two static suites run.
    //   - ai-no-sdk-leak: no provider SDK is imported anywhere in the app trees (`providerDirs: []`,
    //     MemoriaHub registers no provider of its own) and no app manifest declares one; the SDKs
    //     are declared only by the two platform packages that own them. NOT scanned:
    //     `packages/enrichment-compute`, the worker-node compute package that still imports the
    //     `openai` and `@anthropic-ai/sdk` SDKs for the node-side `auto_tagging` /
    //     `video_auto_tagging` calls under a brokered per-job key (PLATFORM-ADOPTION-SHIM(#1083):
    //     the platform's node credential delivery, EnterpriseAppBase #1083, is unreleased; the node
    //     compute moves server-side or onto platform executors in RETRO-C4/C10).
    //   - ai-orchestration-boundary: no orchestration library anywhere (`allowedRoots: {}`).
    aiNoSdkLeak: {
      apiTrees: [
        { name: 'apps/api', root: join(REPO_ROOT, 'apps', 'api', 'src'), minFiles: 500 },
        { name: 'apps/cli', root: join(REPO_ROOT, 'apps', 'cli', 'src'), minFiles: 50 },
      ],
      webTrees: [{ name: 'apps/web', root: join(REPO_ROOT, 'apps', 'web', 'src'), minFiles: 200 }],
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
    // The five suites that boot the AI runtime need an app fixture (`AiConformanceFixture`: an app
    // with the fake provider registered, a user factory, the role-to-permission map). RETRO-E4
    // builds it and turns them on, with every MemoriaHub AI call on `AiService` by then (E2).
    aiKillSwitch: {
      skip:
        'RETRO-E4 builds the AiConformanceFixture these runtime suites boot. Until RETRO-E2 no MemoriaHub ' +
        'feature calls the platform runtime, so the kill switch governs only the platform routes, which ' +
        'test/ai/ai-platform-mount.integration.spec.ts checks (AI_DISABLED while off; admin routes not gated).',
    },
    aiRbacMatrix: {
      skip:
        'RETRO-E4 builds the AiConformanceFixture. The AI permissions are registered (permissions.ts, ' +
        '`ai` slice) and test/ai/ai-platform-mount.integration.spec.ts checks ai_config:read on /api/admin/ai.',
    },
    aiSecretEgress: {
      skip:
        'RETRO-E4 builds the AiConformanceFixture. Known gap it would report: worker nodes still receive a ' +
        'transient per-job provider key for auto_tagging, video_auto_tagging and geocode from ' +
        'POST /api/nodes/:id/jobs/:jobId/credentials (PLATFORM-ADOPTION-SHIM(#1083): the platform node ' +
        'credential delivery, EnterpriseAppBase #1083, is unreleased; RETRO-C4 decides server-only).',
    },
    aiKeyPolicy: {
      skip:
        'RETRO-E4 builds the AiConformanceFixture; the deployment keys move into the platform store in ' +
        'RETRO-E3 (until then MemoriaHub reads ai_provider_credentials through the legacy adapter).',
    },
    aiJobsServerOnly: {
      skip:
        'RETRO-E4 builds the AiConformanceFixture. MemoriaHub adds no ai.* job type (the platform ones are server-only); its node-claimable ' +
        'AI types (auto_tagging, video_auto_tagging) keep their permanent non-ai.* type strings and the ' +
        'brokered-key node path (PLATFORM-ADOPTION-SHIM(#1083), EnterpriseAppBase #1083 unreleased; RETRO-C4).',
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

    doctorReadOnly: {
      fixture: doctorConformanceFixture,
      minChecks: 30,
      forbiddenServices: [...DOCTOR_FORBIDDEN_SERVICES, 'StorageSettingsService'],
    },
  },
});

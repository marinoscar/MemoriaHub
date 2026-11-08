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
// `host` (`@marinoscar/platform-api/host/testing`): a walk of `AppModule` from
// its root. `MaintenanceGuard` is the first and only global guard,
// `PlatformHostCoreModule.forRoot()` is imported exactly once, and the
// `{ data }` envelope and the exception filter are global exactly once each.
// =============================================================================

import { join } from 'node:path';

import { permissionRegistry, roleRegistry, userOwnedModelRegistry } from '@marinoscar/platform-api/core';

import '@marinoscar/platform-api/credentials/testing';
import '@marinoscar/platform-api/db-backup/testing';
import '@marinoscar/platform-api/doctor/testing';
import '@marinoscar/platform-api/email/testing';
import '@marinoscar/platform-api/host/testing';
import '@marinoscar/platform-api/identity/testing';
import '@marinoscar/platform-api/jobs/testing';
import '@marinoscar/platform-api/settings/testing';
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
import { RAW_SQL_ALLOWLIST } from './conformance/raw-sql-allowlist';
import { EMAIL_TEMPLATE_SAMPLES } from './conformance/email-samples';
import { doctorConformanceFixture } from './conformance/doctor-fixture';

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

    // MaintenanceGuard is the application's only global guard: MemoriaHub has no
    // global JWT guard (every route declares its own @Auth()/@Public()) and no
    // global throttler. If one is ever added, list it here with a reason.
    host: { rootModule: AppModule },

    // Rule 3 of the Doctor check contract (RETRO-B1b, #602): every registered
    // check is read-only. Suite id: `doctor-read-only`. The checks are DISCOVERED
    // from the booted app's registry; the floor is a vacuity guard, not a list.
    // `StorageSettingsService` is MemoriaHub's own side-effecting "test
    // connection" service (it writes a sentinel object), so a check holding it
    // is a regression. The AI, face and geo settings services stay allowed: see
    // the live-probe row of docs/platform-adoption/local-exceptions.md.
    doctorReadOnly: {
      fixture: doctorConformanceFixture,
      minChecks: 30,
      forbiddenServices: [...DOCTOR_FORBIDDEN_SERVICES, 'StorageSettingsService'],
    },
  },
});

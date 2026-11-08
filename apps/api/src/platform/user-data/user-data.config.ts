import { UserDataModule, composedSchemaDatamodel } from '@marinoscar/platform-api/user-data';

// Registers MemoriaHub's categories, scopes, model hints and factory reset steps,
// THEN the platform's (an entry whose id is already registered is skipped, so
// MemoriaHub's win where they overlap). Must run before the module is composed.
import './user-data.manifest';
import { UserDataHostModule } from './user-data-host.module';
import { memoriaHubCircleContentRemovalHook } from './user-removal.hook';

// =============================================================================
// The platform's user-data slice (RETRO-H1, #591)
// =============================================================================
//
// Mounts, once:
//   - the user Danger Zone: `GET /api/user-data/summary`, `POST /api/user-data/deletions`,
//     `GET /api/user-data/deletions/:jobId` (`user_settings:write`, every role) and the
//     `user.data.purge` job, which deletes inline rows and enqueues MemoriaHub's delegated
//     purges (`memoriahub-purge.handlers.ts`);
//   - the admin factory reset: `/api/admin/factory-reset/*` (`system:factory_reset`, Admin
//     only, never implied by `system_settings:write`) and the `admin.factory_reset` job,
//     with MemoriaHub's steps (`factory-reset.steps.ts`);
//   - organization offboarding (`orgs:offboard`, `org.offboard`): unreachable while the
//     deployment runs in single-organization mode (`TENANCY_MODE` unset), wired anyway so
//     the removal hook below is exercised the day it is not.
//
// `datamodel`: the composed Prisma schema folder (`prisma/schema`), parsed once when the
// purge plan is first computed (the generated client's DMMF lacks `onDelete`).
//
// `userRemovalHooks`: `memoriahub.circle-content` runs before a user ROW is deleted
// (Open decisions 1 and 2 of #591). The sharing slice's `groupMembershipRemovalHook` is not
// passed: MemoriaHub does not mount the sharing slice (circles become groups in Epic I).
//
// `factoryReset.keepJobsReferencedBy`: a database backup run's job survives the reset's
// first step, as the page promises ("Database backups, their files and their jobs").
//
// `txTimeoutMs`: the reset's `memoriahub.content` step deletes every media item and circle
// of a library (tens of thousands of rows with HNSW-indexed embeddings) in one transaction;
// the platform's 5 minute default is too short for that. 20 minutes stays inside the reset
// job's 30 minute budget; a step that still times out is retried and deletes what is left.
//
// No `legacyJobTypes`: MemoriaHub had no server-side deletion before this slice.
// =============================================================================

export const USER_DATA_TX_TIMEOUT_MS = 20 * 60_000;

export const userDataModule = UserDataModule.forRoot({
  imports: [UserDataHostModule],
  datamodel: composedSchemaDatamodel(__dirname),
  userRemovalHooks: [memoriaHubCircleContentRemovalHook],
  factoryReset: { keepJobsReferencedBy: [{ model: 'DatabaseBackupRun', field: 'jobId' }] },
  txTimeoutMs: USER_DATA_TX_TIMEOUT_MS,
});

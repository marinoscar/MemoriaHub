import { registerFactoryResetStep, type FactoryResetStepDef } from '@marinoscar/platform-api/user-data';
import { survivingKeyPrefixes } from '@marinoscar/platform-api/storage';

import type { MemoriaHubUserDataService } from './memoriahub-user-data.service';

// =============================================================================
// MemoriaHub's steps of the platform factory reset (RETRO-H1, #591)
// =============================================================================
//
// `admin.factory_reset` (`@marinoscar/platform-api/user-data`) deletes the jobs,
// every user's INLINE owner rows, every `org` model, every user but the actor,
// the platform's leftovers and the storage objects of a `storageObjects: true`
// model. Left alone it is wrong here on four counts:
//
//   1. MemoriaHub's content is not owned through a cascading user key. Circles
//      (`owner_id`) and media, albums, tags and people (`added_by_id`) are
//      `Restrict`, so the "every other user" step would fail on the foreign key,
//      and the actor's own library would survive. Their user-data hints are
//      DELEGATED (`user-data.manifest.ts`), and the reset never enqueues a delegate.
//   2. `StorageObject` is not `storageObjects: true` (a user's deletion must not
//      take the files behind a shared circle's photos), so the platform's storage
//      step never runs; and its org-data step would `deleteMany` `storage_objects`
//      under `media_items.storage_object_id` (Restrict). The hint says
//      `factoryReset: 'keep'` and the sweep below owns the table, deleting each
//      object through the provider recorded on its row.
//   3. Staged AI-enhancement results have no storage-object row; they are deleted
//      through their recorded provider before their rows go.
//   4. The legacy worker nodes (`mh_legacy_worker_nodes`, RETRO-C2 replaces them)
//      cascade from their creator: the platform reassigns its own nodes to the
//      administrator, so the legacy ones are reassigned the same way first.
//
// Steps, in the handler's order (each runs in its own bypass transaction and
// returns counts; all are retry-safe, deletes by predicate):
//
//   memoriahub.content        before-users  staged enhancement files, then every
//                                           media item (cascading its faces,
//                                           embeddings, statuses, tags-links, shares,
//                                           enhancements, album and memory items),
//                                           every circle (albums, tags, people,
//                                           memories, workflows, runs, groups,
//                                           invites, members), profiles, paired
//                                           devices, node backup configs, the legacy
//                                           storage-migration history and the
//                                           insights snapshot
//   memoriahub.legacy-nodes   before-users  legacy worker nodes and their
//                                           credentials move to the administrator
//   memoriahub.leftovers      deployment    legacy notifications, deliveries and
//                                           broadcasts, the frozen pre-platform job
//                                           archive, and a fresh personal circle for
//                                           the administrator (the first-run state)
//   memoriahub.storage        deployment    every storage object outside the
//                                           surviving prefixes: bytes through the
//                                           row's provider, then the row
//
// KEPT: the tag vocabulary (`tag_labels`), location groups and aliases, provider
// credentials, the legacy Android releases and database backups (rows and files),
// system settings, roles and the audit log. Those models carry `factoryReset:
// 'keep'` hints with a `summary`, so the reset page lists them.
//
// The steps cannot inject: `MemoriaHubFactoryResetBinding` (in
// `user-data-host.module.ts`) hands them the service once the container is up.
// =============================================================================

let service: MemoriaHubUserDataService | undefined;

/** Called once the Nest container is up. */
export function bindMemoriaHubFactoryResetDeps(deps: { service: MemoriaHubUserDataService }): void {
  service = deps.service;
}

function deps(): MemoriaHubUserDataService {
  if (!service) {
    throw new Error('MemoriaHub factory reset steps are not bound (MemoriaHubFactoryResetBinding did not run)');
  }
  return service;
}

/** `deleteMany` on one model, returning the count. */
async function wipe(tx: any, model: string, where: Record<string, unknown> = {}): Promise<number> {
  return (await tx[model].deleteMany({ where })).count as number;
}

export const MEMORIAHUB_CONTENT_STEP: FactoryResetStepDef = {
  id: 'memoriahub.content',
  phase: 'before-users',
  description:
    'Every circle with its photos, videos, albums, tags, people, faces, memories, workflows and review history; profiles and paired devices.',
  summary:
    'Every circle, photo, video, album, tag, person, face and memory, with their stored files, and every paired phone',
  async run(tx: any): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    // Files without a storage-object row, before the rows that name them go.
    const staging = await deps().deleteEnhancementStaging({});
    counts.stagingFilesDeleted = staging.stagingFilesDeleted;
    counts.stagingFilesFailed = staging.stagingFilesFailed;

    // Media first: albums, tags and media items Restrict their circle.
    counts.mediaItems = await wipe(tx, 'mediaItem');
    counts.albums = await wipe(tx, 'album');
    counts.tags = await wipe(tx, 'tag');
    counts.people = await wipe(tx, 'person');
    counts.circles = await wipe(tx, 'circle');

    counts.profiles = await wipe(tx, 'userProfile');
    counts.devices = await wipe(tx, 'mediaSyncDevice');
    counts.nodeBackupRuns = await wipe(tx, 'nodeBackupRun');
    counts.nodeBackupConfigs = await wipe(tx, 'nodeBackupConfig');
    counts.legacyStorageMigrations = await wipe(tx, 'mhLegacyStorageMigrationRun');
    counts.insightsSnapshots = await wipe(tx, 'insightsSnapshot');
    return counts;
  },
};

export const MEMORIAHUB_LEGACY_NODES_STEP: FactoryResetStepDef = {
  id: 'memoriahub.legacy-nodes',
  phase: 'before-users',
  description:
    'Legacy worker nodes and their credentials move to the administrator (a node whose name the administrator already uses is removed).',
  async run(tx: any, ctx): Promise<Record<string, number>> {
    const taken = new Set<string>(
      (
        await tx.mhLegacyWorkerNode.findMany({ where: { createdById: ctx.actorUserId }, select: { name: true } })
      ).map((row: { name: string }) => row.name),
    );
    const others: { id: string; name: string }[] = await tx.mhLegacyWorkerNode.findMany({
      where: { createdById: { not: ctx.actorUserId } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    let reassigned = 0;
    const clashing: string[] = [];
    for (const node of others) {
      if (taken.has(node.name)) {
        clashing.push(node.id);
        continue;
      }
      taken.add(node.name);
      reassigned += (await tx.mhLegacyWorkerNode.updateMany({ where: { id: node.id }, data: { createdById: ctx.actorUserId } }))
        .count;
    }
    const removed = clashing.length > 0 ? await wipe(tx, 'mhLegacyWorkerNode', { id: { in: clashing } }) : 0;
    const credentials = (
      await tx.mhLegacyNodeCredential.updateMany({
        where: { userId: { not: ctx.actorUserId } },
        data: { userId: ctx.actorUserId },
      })
    ).count;
    return { legacyNodesReassigned: reassigned, legacyNodesRemoved: removed, legacyNodeCredentialsReassigned: credentials };
  },
};

export const MEMORIAHUB_LEFTOVERS_STEP: FactoryResetStepDef = {
  id: 'memoriahub.leftovers',
  phase: 'deployment',
  description:
    'Legacy notification tables and the frozen pre-platform job archive; a new personal circle for the administrator.',
  async run(tx: any, ctx): Promise<Record<string, number>> {
    const counts: Record<string, number> = {
      legacyNotifications: await wipe(tx, 'mhLegacyNotification'),
      legacyDeliveries: await wipe(tx, 'mhLegacyNotificationDelivery'),
      legacyBroadcasts: await wipe(tx, 'mhLegacyNotificationBroadcast'),
      legacyJobs: await wipe(tx, 'enrichmentJob'),
      personalCircles: 0,
    };

    // The first-run state: every user has a personal circle (`ensurePersonalCircle`
    // in `circles/identity-listeners.ts` creates it at sign-up, which the
    // administrator will not repeat).
    const existing = await tx.circle.findFirst({ where: { ownerId: ctx.actorUserId, isPersonal: true }, select: { id: true } });
    if (!existing) {
      const actor = await tx.user.findUnique({
        where: { id: ctx.actorUserId },
        select: { email: true, displayName: true, providerDisplayName: true },
      });
      const circle = await tx.circle.create({
        data: {
          name: `${actor?.displayName || actor?.providerDisplayName || actor?.email || 'My'}'s Library`,
          ownerId: ctx.actorUserId,
          isPersonal: true,
        },
      });
      await tx.circleMember.create({ data: { circleId: circle.id, userId: ctx.actorUserId, role: 'circle_admin' } });
      counts.personalCircles = 1;
    }
    return counts;
  },
};

export const MEMORIAHUB_STORAGE_STEP: FactoryResetStepDef = {
  id: 'memoriahub.storage',
  phase: 'deployment',
  description:
    'Every storage object outside the surviving prefixes (database backups, Android releases): bytes through the provider recorded on the row, then the row. A refused object keeps its row and is counted.',
  async run(): Promise<Record<string, number>> {
    return deps().sweepStorageObjects(survivingKeyPrefixes());
  },
};

/** The steps, in registration order. */
export const MEMORIAHUB_FACTORY_RESET_STEPS: readonly FactoryResetStepDef[] = [
  MEMORIAHUB_CONTENT_STEP,
  MEMORIAHUB_LEGACY_NODES_STEP,
  MEMORIAHUB_LEFTOVERS_STEP,
  MEMORIAHUB_STORAGE_STEP,
];

for (const step of MEMORIAHUB_FACTORY_RESET_STEPS) {
  registerFactoryResetStep(step);
}

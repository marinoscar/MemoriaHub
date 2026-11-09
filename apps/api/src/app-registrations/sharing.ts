// =============================================================================
// The sharing slice's registrations (RETRO-I1, #562)
// =============================================================================
//
// Imported by `platform/sharing/sharing.config.ts` and by
// `platform/notifications/notification.manifest.ts` BEFORE their modules
// compose, so every registry is filled before the application bootstraps (the
// registries freeze then). Idempotent: a second import in the same process
// registers nothing twice.
//
//   metrics      `SHARING_APP_METRICS`: `app.sharing.group_mutations` (label `op`),
//                `app.sharing.access_decisions` (`resource_type`, `outcome`, `via`),
//                `app.sharing.link_resolutions` (`outcome`, `resource_type`). Never an
//                organization, group or record id on a label.
//   templates    `group-invitation` and `shared-with-you`: the slice's words in
//                MemoriaHub's layout (`platform/email/templates/`). Names permanent.
//
// Registered ELSEWHERE, on purpose:
//   - the six permissions (`groups:read|write|admin`, `sharing:read|write|admin`):
//     the platform permission manifest, slice `sharing` in `permissions.ts`;
//   - the two notification events (`groups.invitation`, `sharing.shared_with_you`):
//     `platform/sharing/sharing.notifications.ts`, through the notification manifest;
//   - `SHARING_USER_OWNED_MODELS` and `SHARING_MODEL_OWNERSHIP`: already part of the
//     platform inventories `registerPlatformUserOwnedModels` /
//     `registerPlatformModelOwnership` register (`ownership-manifest.ts`), so
//     registering them here would be a duplicate id.
//
// RESOURCE TYPES (RETRO-I2, #569): `media_item` and `album` (ownership
// `user_or_group`, `registerResourceType`, which also makes them group-owned) and
// every other content table as a group-owned resource (`registerGroupOwnedResource`),
// so `DELETE /api/groups/:id` answers 409 `GROUP_OWNS_RESOURCES` while the group
// owns rows. The ids are PERMANENT (like a job type string); the sharing
// conformance suite pins them (`groupOwnedModels`, `resourceTypeIds`). The
// decisions are fixed in `docs/platform-adoption/circles-to-groups.md` §3-§4.
// Nothing reads `AccessPolicy` for these types yet: circles decide access until
// RETRO-I3.
// =============================================================================

import { registerEmailTemplates, type EmailTemplate, type EmailTemplateEntry } from '@marinoscar/platform-api/email';
import { appMetricRegistry, registerAppMetrics } from '@marinoscar/platform-api/otel-core';
import {
  GROUP_INVITATION_EMAIL_TEMPLATE,
  groupOwnedResourceRegistry,
  registerGroupOwnedResource,
  registerResourceType,
  resourceTypeRegistry,
  SHARED_WITH_YOU_EMAIL_TEMPLATE,
  SHARING_APP_METRICS,
  type ResourceOwnerInfo,
  type ResourceTypeDef,
} from '@marinoscar/platform-api/sharing';
import type { Prisma } from '@prisma/client';

import { groupInvitationEmail, type GroupInvitationEmailData } from '../platform/email/templates/group-invitation.email';
import { sharedWithYouEmail, type SharedWithYouEmailData } from '../platform/email/templates/shared-with-you.email';

declare module '@marinoscar/platform-api/email' {
  interface EmailTemplateDataMap {
    'group-invitation': GroupInvitationEmailData;
    'shared-with-you': SharedWithYouEmailData;
  }
}

/** The registrant recorded for the two templates in the bootstrap log. */
export const SHARING_EMAIL_REGISTRANT = 'sharing';

/** The sharing slice's two e-mail templates, bound to MemoriaHub's layout. */
export const SHARING_EMAIL_TEMPLATES: readonly EmailTemplateEntry[] = [
  {
    name: GROUP_INVITATION_EMAIL_TEMPLATE,
    render: groupInvitationEmail as EmailTemplate<never>,
    registrant: SHARING_EMAIL_REGISTRANT,
  },
  {
    name: SHARED_WITH_YOU_EMAIL_TEMPLATE,
    render: sharedWithYouEmail as EmailTemplate<never>,
    registrant: SHARING_EMAIL_REGISTRANT,
  },
];

let registered = false;

/** Registers the metrics and the two templates once per process. */
export function registerSharingDeclarations(): void {
  if (registered) return;
  registered = true;

  if (!appMetricRegistry.has(SHARING_APP_METRICS[0].key)) {
    registerAppMetrics(SHARING_APP_METRICS);
  }
  registerEmailTemplates(SHARING_EMAIL_TEMPLATES);
  registerMemoriaHubResources();
}

// -----------------------------------------------------------------------------
// Resource types and group-owned resources (RETRO-I2, #569)
// -----------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

/** The owner columns every content table carries since RETRO-I2. */
interface OwnerRow {
  id: string;
  orgId: string;
  ownerGroupId: string | null;
  ownerUserId: string | null;
}

const OWNER_SELECT = { id: true, orgId: true, ownerGroupId: true, ownerUserId: true } as const;

/** `ResourceOwnerInfo` of one row; a row with no owner (impossible under the CHECK) is left out. */
function ownersOf(rows: readonly OwnerRow[]): Map<string, ResourceOwnerInfo> {
  const owners = new Map<string, ResourceOwnerInfo>();
  for (const row of rows) {
    if (row.ownerGroupId) owners.set(row.id, { orgId: row.orgId, owner: { kind: 'group', groupId: row.ownerGroupId } });
    else if (row.ownerUserId) owners.set(row.id, { orgId: row.orgId, owner: { kind: 'user', userId: row.ownerUserId } });
  }
  return owners;
}

/** The two shareable types share everything but `loadOwners`, `countOwnedByGroup` and `describe`. */
const MEDIA_RESOURCE_BASE = {
  roles: ['viewer', 'editor'],
  actions: { read: 'viewer', write: 'editor', share_link: 'editor', share: 'owner', delete: 'owner' },
  actionPermissions: { write: 'media:write', delete: 'media:delete' },
  // `share_link: 'sharing:admin'` (RETRO-I4, #578): the slice gives `sharing:admin` the `share`
  // action on every record but decides a LINK's update and revocation on `share_link`, so the
  // admin public-links page (`/admin/settings/sharing`, which replaced `shares:manage_any`) can
  // revoke or re-date any link through `PATCH` / `DELETE /api/grants/:id`.
  bypassPermissions: { read: 'media:read_any', write: 'media:write_any', delete: 'media:delete_any', share_link: 'sharing:admin' },
  ownership: 'user_or_group',
  groupRoleMap: { admin: 'owner', editor: 'editor', viewer: 'viewer' },
  grantable: { user: ['viewer'], group: ['viewer', 'editor'], link: ['viewer'] },
  denyAs: 'not_found',
} as const satisfies Omit<ResourceTypeDef<'viewer' | 'editor'>, 'type' | 'loadOwners'>;

/** A photo or video. ONE query; a trashed item (`deleted_at` set) is a missing record. */
export const MEDIA_ITEM_RESOURCE_TYPE: ResourceTypeDef<'viewer' | 'editor'> = {
  type: 'media_item',
  ...MEDIA_RESOURCE_BASE,
  async loadOwners(ids, tx) {
    const rows = await (tx as Tx).mediaItem.findMany({ where: { id: { in: [...ids] }, deletedAt: null }, select: OWNER_SELECT });
    return ownersOf(rows);
  },
  countOwnedByGroup: (groupId, tx) => (tx as Tx).mediaItem.count({ where: { ownerGroupId: groupId } }),
  async describe(ids, tx) {
    const rows = await (tx as Tx).mediaItem.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, originalFilename: true },
    });
    return new Map(rows.map((row) => [row.id, { title: row.originalFilename, path: `/media?item=${row.id}` }]));
  },
};

/** An album. ONE query. */
export const ALBUM_RESOURCE_TYPE: ResourceTypeDef<'viewer' | 'editor'> = {
  type: 'album',
  ...MEDIA_RESOURCE_BASE,
  async loadOwners(ids, tx) {
    const rows = await (tx as Tx).album.findMany({ where: { id: { in: [...ids] } }, select: OWNER_SELECT });
    return ownersOf(rows);
  },
  countOwnedByGroup: (groupId, tx) => (tx as Tx).album.count({ where: { ownerGroupId: groupId } }),
  async describe(ids, tx) {
    const rows = await (tx as Tx).album.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, { title: row.name, path: `/albums/${row.id}` }]));
  },
};

/** Counts one model's rows owned by a group, inside the group-deleting transaction. */
type GroupCount = (tx: Tx, groupId: string) => Promise<number>;

/**
 * Every other content table, by its permanent group-owned type id. Derived tables
 * (statuses, embeddings, transcript) keep denormalised owner columns copied from
 * their media item (circles-to-groups.md §3, open decision 3).
 */
export const MEMORIAHUB_GROUP_OWNED_RESOURCES: ReadonlyArray<{ type: string; model: Prisma.ModelName; count: GroupCount }> = [
  { type: 'tag', model: 'Tag', count: (tx, g) => tx.tag.count({ where: { ownerGroupId: g } }) },
  { type: 'person', model: 'Person', count: (tx, g) => tx.person.count({ where: { ownerGroupId: g } }) },
  { type: 'face', model: 'Face', count: (tx, g) => tx.face.count({ where: { ownerGroupId: g } }) },
  { type: 'memory', model: 'Memory', count: (tx, g) => tx.memory.count({ where: { ownerGroupId: g } }) },
  { type: 'burst_group', model: 'BurstGroup', count: (tx, g) => tx.burstGroup.count({ where: { ownerGroupId: g } }) },
  { type: 'duplicate_group', model: 'DuplicateGroup', count: (tx, g) => tx.duplicateGroup.count({ where: { ownerGroupId: g } }) },
  {
    type: 'location_suggestion',
    model: 'LocationSuggestion',
    count: (tx, g) => tx.locationSuggestion.count({ where: { ownerGroupId: g } }),
  },
  { type: 'media_enhancement', model: 'MediaEnhancement', count: (tx, g) => tx.mediaEnhancement.count({ where: { ownerGroupId: g } }) },
  {
    type: 'media_enhancement_batch',
    model: 'MediaEnhancementBatch',
    count: (tx, g) => tx.mediaEnhancementBatch.count({ where: { ownerGroupId: g } }),
  },
  { type: 'review_run', model: 'ReviewRun', count: (tx, g) => tx.reviewRun.count({ where: { ownerGroupId: g } }) },
  { type: 'trash_empty_run', model: 'TrashEmptyRun', count: (tx, g) => tx.trashEmptyRun.count({ where: { ownerGroupId: g } }) },
  { type: 'workflow', model: 'Workflow', count: (tx, g) => tx.workflow.count({ where: { ownerGroupId: g } }) },
  { type: 'workflow_run', model: 'WorkflowRun', count: (tx, g) => tx.workflowRun.count({ where: { ownerGroupId: g } }) },
  {
    type: 'media_geocode_status',
    model: 'MediaGeocodeStatus',
    count: (tx, g) => tx.mediaGeocodeStatus.count({ where: { ownerGroupId: g } }),
  },
  {
    type: 'media_metadata_status',
    model: 'MediaMetadataStatus',
    count: (tx, g) => tx.mediaMetadataStatus.count({ where: { ownerGroupId: g } }),
  },
  { type: 'media_tag_status', model: 'MediaTagStatus', count: (tx, g) => tx.mediaTagStatus.count({ where: { ownerGroupId: g } }) },
  { type: 'media_transcript', model: 'MediaTranscript', count: (tx, g) => tx.mediaTranscript.count({ where: { ownerGroupId: g } }) },
  {
    type: 'media_item_embedding',
    model: 'MediaItemEmbedding',
    count: (tx, g) => tx.mediaItemEmbedding.count({ where: { ownerGroupId: g } }),
  },
];

/**
 * Every model with an `owner_group_id` and its group-owned type id: the sharing
 * conformance suite's `groupOwnedModels` (a model missing here fails it).
 */
export const MEMORIAHUB_GROUP_OWNED_MODELS: Readonly<Record<string, string>> = {
  MediaItem: MEDIA_ITEM_RESOURCE_TYPE.type,
  Album: ALBUM_RESOURCE_TYPE.type,
  ...Object.fromEntries(MEMORIAHUB_GROUP_OWNED_RESOURCES.map((entry) => [entry.model, entry.type])),
};

/** Registers the two resource types and the group-owned resources, once per process. */
function registerMemoriaHubResources(): void {
  for (const def of [MEDIA_ITEM_RESOURCE_TYPE, ALBUM_RESOURCE_TYPE]) {
    if (!resourceTypeRegistry.has(def.type)) registerResourceType(def);
  }
  for (const entry of MEMORIAHUB_GROUP_OWNED_RESOURCES) {
    if (groupOwnedResourceRegistry.has(entry.type)) continue;
    registerGroupOwnedResource({ type: entry.type, countOwnedByGroup: (groupId, tx) => entry.count(tx as Tx, groupId) });
  }
}

registerSharingDeclarations();

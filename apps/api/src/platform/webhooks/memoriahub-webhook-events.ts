// =============================================================================
// MemoriaHub's webhook events (RETRO-H4, #603)
// =============================================================================
//
// The app's entries in the platform webhook catalog (`registerWebhookEvent`),
// registered at import time, before `WebhooksModule.forRoot` composes and the
// registries freeze. `GET /api/webhooks/events` (and the org and admin twins)
// list them with the JSON Schema of `payloadSchema`.
//
// KEYS ARE PERMANENT. A receiver subscribes to them by name and dedupes on
// them; rename one and every endpoint subscribed to it silently stops
// receiving. Add a key, never rename or remove one (a retired event keeps its
// registration and simply stops being emitted).
//
// PAYLOADS CARRY IDS, NEVER CONTENT. No captions, file names, locations,
// person names, URLs, tokens or secrets: a receiver that needs more reads the
// API with its own credential, under its own permissions.
//
// VOLUME. Every media event is BATCHED (`MediaWebhookEvents`): at most
// `MAX_IDS_PER_EVENT` ids per event, so a 4 000-file import produces about 40
// `media.item.created` events, never 4 000 deliveries per endpoint.
//
// AUDIENCE (open decision 1 of #603). Circle-content events are `system`
// (deployment endpoints, administrators): an `org` endpoint would receive
// events from circles its owner does not belong to, and the fan-out's
// permission re-check cannot express circle membership. A member's own events
// (`media.upload.completed` for their uploads, `workflows.run.*` for runs they
// started or own) are `user`. Per-circle subscriptions arrive with Epic I.
//
// The built-in `jobs.job.failed` covers a permanently failed enrichment job, so
// MemoriaHub registers no `media.enrichment.failed` of its own.
// =============================================================================

import { registerWebhookEvent, webhookEventRegistry, type WebhookEventDef } from '@marinoscar/platform-api/webhooks';
import { z } from 'zod';

/** The `source` of every MemoriaHub event. */
export const MEMORIAHUB_WEBHOOK_SOURCE = 'memoriahub';

/** At most this many ids in one event (and one delivery). */
export const MAX_IDS_PER_EVENT = 100;

/** MemoriaHub's webhook event keys. PERMANENT: add, never rename. */
export const MEMORIAHUB_WEBHOOK_EVENTS = {
  uploadCompleted: 'media.upload.completed',
  itemCreated: 'media.item.created',
  itemTrashed: 'media.item.trashed',
  itemDeleted: 'media.item.deleted',
  memoryCreated: 'memories.memory.created',
  workflowRunCompleted: 'workflows.run.completed',
  workflowRunAwaitingApproval: 'workflows.run.awaiting_approval',
} as const;

export type MemoriaHubWebhookEventKey = (typeof MEMORIAHUB_WEBHOOK_EVENTS)[keyof typeof MEMORIAHUB_WEBHOOK_EVENTS];

const id = z.string().min(1).max(64);
const ids = z.array(id).min(1).max(MAX_IDS_PER_EVENT);
const isoDate = z.string().datetime({ offset: true });

export const uploadCompletedSchema = z.object({
  circleId: id,
  /** Items in this event (equals `mediaItemIds.length`). */
  count: z.number().int().min(1).max(MAX_IDS_PER_EVENT),
  mediaItemIds: ids,
  /** When the first upload of this batch was registered. */
  windowStart: isoDate,
});

export const itemCreatedSchema = z.object({
  circleId: id,
  count: z.number().int().min(1).max(MAX_IDS_PER_EVENT),
  items: z
    .array(
      z.object({
        mediaItemId: id,
        mediaType: z.enum(['photo', 'video']),
        /** The capture wall clock re-encoded as UTC (a civil timestamp, see docs/specs/date-model.md); null when unknown. */
        capturedAt: isoDate.nullable(),
        addedById: id.nullable(),
      }),
    )
    .min(1)
    .max(MAX_IDS_PER_EVENT),
});

export const itemsChangedSchema = z.object({
  circleId: id,
  count: z.number().int().min(1).max(MAX_IDS_PER_EVENT),
  mediaItemIds: ids,
});

export const memoryCreatedSchema = z.object({
  circleId: id,
  count: z.number().int().min(1).max(MAX_IDS_PER_EVENT),
  memoryIds: ids,
  /** The distinct memory types among `memoryIds` (`on_this_day`, `trip`, ...). */
  types: z.array(z.string().min(1).max(40)).min(1).max(20),
});

export const workflowRunCompletedSchema = z.object({
  runId: id,
  workflowId: id,
  circleId: id,
  status: z.enum(['completed', 'completed_with_errors', 'failed']),
  /** How this run started: `manual`, `scheduled` or `on_media_enriched`. */
  trigger: z.string().min(1).max(40),
  succeededCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
});

export const workflowRunAwaitingApprovalSchema = z.object({
  runId: id,
  workflowId: id,
  circleId: id,
  matchedCount: z.number().int().min(0),
});

// Invented ids only (never real data).
const CIRCLE = '0f8b2c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f';
const ITEM_A = '1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e';
const ITEM_B = '2b2b2b2b-3c3c-4d4d-9e5e-6f6f6f6f6f6f';
const USER = '3c3c3c3c-4d4d-4e5e-8f6f-7a7a7a7a7a7a';
const RUN = '4d4d4d4d-5e5e-4f6f-9a7a-8b8b8b8b8b8b';
const WORKFLOW = '5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c';

const GROUP_MEDIA = 'Media';
const GROUP_MEMORIES = 'Memories';
const GROUP_WORKFLOWS = 'Workflows';

/** Every MemoriaHub event, in catalog order. */
export const MEMORIAHUB_WEBHOOK_EVENT_DEFS: readonly WebhookEventDef[] = [
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.uploadCompleted,
    label: 'My uploads completed',
    description:
      'Photos and videos you uploaded were registered in a circle; one event per batch of up to 100 items or per minute of uploading.',
    group: GROUP_MEDIA,
    audience: 'user',
    permission: 'media:read',
    payloadSchema: uploadCompletedSchema,
    example: { circleId: CIRCLE, count: 2, mediaItemIds: [ITEM_A, ITEM_B], windowStart: '2026-01-01T10:00:00.000Z' },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.itemCreated,
    label: 'Media items created',
    description:
      'New photos and videos were registered in a circle (any uploader); one event per batch of up to 100 items or per minute.',
    group: GROUP_MEDIA,
    audience: 'system',
    permission: 'media:read',
    payloadSchema: itemCreatedSchema,
    example: {
      circleId: CIRCLE,
      count: 1,
      items: [{ mediaItemId: ITEM_A, mediaType: 'photo', capturedAt: '2025-12-24T18:30:00.000Z', addedById: USER }],
    },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.itemTrashed,
    label: 'Media items moved to Trash',
    description: 'Photos and videos in a circle were moved to Trash (recoverable until the trash retention ends).',
    group: GROUP_MEDIA,
    audience: 'system',
    permission: 'media:read',
    payloadSchema: itemsChangedSchema,
    example: { circleId: CIRCLE, count: 2, mediaItemIds: [ITEM_A, ITEM_B] },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.itemDeleted,
    label: 'Media items permanently deleted',
    description: 'Photos and videos in a circle were deleted for good (emptied trash, delete forever, retention purge).',
    group: GROUP_MEDIA,
    audience: 'system',
    permission: 'media:read',
    payloadSchema: itemsChangedSchema,
    example: { circleId: CIRCLE, count: 1, mediaItemIds: [ITEM_B] },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.memoryCreated,
    label: 'Memories created',
    description: 'A generation pass created new memories in a circle (On This Day, trips, people, themes, seasons, years).',
    group: GROUP_MEMORIES,
    audience: 'system',
    permission: 'media:read',
    payloadSchema: memoryCreatedSchema,
    example: { circleId: CIRCLE, count: 1, memoryIds: [ITEM_A], types: ['on_this_day'] },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted,
    label: 'Workflow run finished',
    description: 'A workflow run you started (or a scheduled run of a workflow you created) finished: completed, completed with errors or failed.',
    group: GROUP_WORKFLOWS,
    audience: 'user',
    permission: 'media:read',
    payloadSchema: workflowRunCompletedSchema,
    example: {
      runId: RUN,
      workflowId: WORKFLOW,
      circleId: CIRCLE,
      status: 'completed',
      trigger: 'manual',
      succeededCount: 42,
      failedCount: 0,
    },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
  {
    key: MEMORIAHUB_WEBHOOK_EVENTS.workflowRunAwaitingApproval,
    label: 'Workflow run awaiting approval',
    description: 'A workflow run you started matched items and waits for your approval before it changes anything.',
    group: GROUP_WORKFLOWS,
    audience: 'user',
    permission: 'media:read',
    payloadSchema: workflowRunAwaitingApprovalSchema,
    example: { runId: RUN, workflowId: WORKFLOW, circleId: CIRCLE, matchedCount: 128 },
    source: MEMORIAHUB_WEBHOOK_SOURCE,
  },
];

/** Registers MemoriaHub's events once per process (a key already registered is skipped). */
export function registerMemoriaHubWebhookEvents(): void {
  for (const def of MEMORIAHUB_WEBHOOK_EVENT_DEFS) {
    if (!webhookEventRegistry.has(def.key)) registerWebhookEvent(def);
  }
}

registerMemoriaHubWebhookEvents();

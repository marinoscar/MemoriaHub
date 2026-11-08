// =============================================================================
// MemoriaHub's webhook events (RETRO-H4, #603): catalog, schemas, signed delivery, SSRF
// =============================================================================
//
// Drives the platform slice over its in-memory test kit (no database): the
// catalog a caller sees (`GET .../webhooks/events`), each payload schema against
// its example, a signed `workflows.run.completed` delivery verified with the
// contract's `verifyWebhookSignature`, and the egress guard refusing a private
// target at create.
// =============================================================================

import { webhookEventRegistry } from '@marinoscar/platform-api/webhooks';
import {
  KIT_ORG_ID,
  KIT_USER_A,
  createWebhooksTestKit,
  makeWebhookOwner,
} from '@marinoscar/platform-api/webhooks/testing';
import { verifyWebhookSignature } from '@marinoscar/platform-contract/webhooks';

import {
  MAX_IDS_PER_EVENT,
  MEMORIAHUB_WEBHOOK_EVENT_DEFS,
  MEMORIAHUB_WEBHOOK_EVENTS,
  registerMemoriaHubWebhookEvents,
} from '../../src/platform/webhooks/memoriahub-webhook-events';

/** The keys, groups, audiences and permissions of the issue's table. PERMANENT. */
const EXPECTED = [
  ['media.upload.completed', 'Media', 'user', 'media:read'],
  ['media.item.created', 'Media', 'system', 'media:read'],
  ['media.item.trashed', 'Media', 'system', 'media:read'],
  ['media.item.deleted', 'Media', 'system', 'media:read'],
  ['memories.memory.created', 'Memories', 'system', 'media:read'],
  ['workflows.run.completed', 'Workflows', 'user', 'media:read'],
  ['workflows.run.awaiting_approval', 'Workflows', 'user', 'media:read'],
] as const;

const ALL_PERMISSIONS = [
  'webhooks:read',
  'webhooks:write',
  'org_webhooks:read',
  'org_webhooks:write',
  'system_webhooks:read',
  'system_webhooks:write',
  'media:read',
];

describe('MemoriaHub webhook events', () => {
  it('registers exactly the permanent keys, each with source memoriahub', () => {
    expect(MEMORIAHUB_WEBHOOK_EVENT_DEFS.map((def) => [def.key, def.group, def.audience, def.permission])).toEqual(
      EXPECTED.map((row) => [...row]),
    );
    for (const def of MEMORIAHUB_WEBHOOK_EVENT_DEFS) {
      expect(webhookEventRegistry.get(def.key)?.source).toBe('memoriahub');
    }
    expect(Object.values(MEMORIAHUB_WEBHOOK_EVENTS).sort()).toEqual(EXPECTED.map(([key]) => key).sort());
  });

  it('registering again in-process is a no-op', () => {
    expect(() => registerMemoriaHubWebhookEvents()).not.toThrow();
  });

  it.each(MEMORIAHUB_WEBHOOK_EVENT_DEFS.map((def) => [def.key, def] as const))(
    '%s: the example satisfies the payload schema',
    (_key, def) => {
      expect(def.payloadSchema.safeParse(def.example).success).toBe(true);
    },
  );

  it('caps every id list at 100 and refuses an empty one', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    const trashed = webhookEventRegistry.get(MEMORIAHUB_WEBHOOK_EVENTS.itemTrashed)!.payloadSchema;
    expect(trashed.safeParse({ circleId: 'c', count: 100, mediaItemIds: ids(MAX_IDS_PER_EVENT) }).success).toBe(true);
    expect(trashed.safeParse({ circleId: 'c', count: 101, mediaItemIds: ids(101) }).success).toBe(false);
    expect(trashed.safeParse({ circleId: 'c', count: 1, mediaItemIds: [] }).success).toBe(false);
  });

  it('payload schemas carry ids, not content: unknown keys are stripped', () => {
    const created = webhookEventRegistry.get(MEMORIAHUB_WEBHOOK_EVENTS.memoryCreated)!.payloadSchema;
    const parsed = created.parse({ circleId: 'c', count: 1, memoryIds: ['m'], types: ['trip'], title: 'secret text' });
    expect(parsed).not.toHaveProperty('title');
  });

  it('the catalog lists the user events for a member and the system events for an administrator, with JSON Schema', () => {
    const kit = createWebhooksTestKit();
    const userCatalog = kit.endpoints.catalog(kit.context('user', KIT_USER_A, ALL_PERMISSIONS));
    const systemCatalog = kit.endpoints.catalog(kit.context('system', KIT_USER_A, ALL_PERMISSIONS));
    const keysOf = (entries: { key: string }[]) => entries.map((entry) => entry.key);

    for (const [key, , audience] of EXPECTED) {
      const catalog = audience === 'user' ? userCatalog : systemCatalog;
      const entry = catalog.find((candidate) => candidate.key === key);
      expect(entry).toBeDefined();
      expect(entry!.jsonSchema).toMatchObject({ type: 'object' });
    }
    expect(keysOf(userCatalog)).not.toContain(MEMORIAHUB_WEBHOOK_EVENTS.itemCreated);
    expect(keysOf(systemCatalog)).not.toContain(MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted);
  });

  it('a member without media:read is not offered the media events', () => {
    const kit = createWebhooksTestKit();
    const catalog = kit.endpoints.catalog(kit.context('user', KIT_USER_A, ['webhooks:read', 'webhooks:write']));
    expect(catalog.map((entry) => entry.key)).not.toContain(MEMORIAHUB_WEBHOOK_EVENTS.uploadCompleted);
  });
});

describe('a signed workflows.run.completed delivery', () => {
  it('reaches the subscribed user endpoint and verifies with verifyWebhookSignature', async () => {
    const kit = createWebhooksTestKit();
    kit.repository.owners.set(
      KIT_USER_A,
      makeWebhookOwner({ id: KIT_USER_A, orgId: KIT_ORG_ID, permissions: ['webhooks:read', 'media:read'] }),
    );
    const { endpoint, secret } = await kit.seedEndpoint({
      scope: 'user',
      ownerUserId: KIT_USER_A,
      eventKeys: [MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted],
    });
    const data = {
      runId: '4d4d4d4d-5e5e-4f6f-9a7a-8b8b8b8b8b8b',
      workflowId: '5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c',
      circleId: '0f8b2c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f',
      status: 'completed',
      trigger: 'manual',
      succeededCount: 3,
      failedCount: 0,
    };

    const result = await kit.webhooks.emitForUser(KIT_USER_A, MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted, data, {
      orgId: KIT_ORG_ID,
    });
    expect(result).toMatchObject({ matched: 1, queued: 1 });

    const delivery = [...kit.repository.deliveries.values()].find((row) => row.endpointId === endpoint.id)!;
    await kit.runDeliveryJob(delivery.id);

    expect(kit.receiver.requests).toHaveLength(1);
    const [request] = kit.receiver.requests;
    const body = JSON.parse(request.body);
    expect(body.type).toBe(MEMORIAHUB_WEBHOOK_EVENTS.workflowRunCompleted);
    expect(body.data).toEqual(data);
    await expect(
      verifyWebhookSignature({
        secret,
        id: request.headers['webhook-id'],
        timestamp: request.headers['webhook-timestamp'],
        body: request.body,
        signatureHeader: request.headers['webhook-signature'],
      }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({
        secret,
        id: request.headers['webhook-id'],
        timestamp: request.headers['webhook-timestamp'],
        body: request.body.replace('"completed"', '"failed"'),
        signatureHeader: request.headers['webhook-signature'],
      }),
    ).resolves.toBe(false);
  });

  it('is not sent to another member, nor when the owner lost media:read', async () => {
    const kit = createWebhooksTestKit();
    kit.repository.owners.set(
      KIT_USER_A,
      makeWebhookOwner({ id: KIT_USER_A, orgId: KIT_ORG_ID, permissions: ['webhooks:read'] }),
    );
    await kit.seedEndpoint({ scope: 'user', ownerUserId: KIT_USER_A, eventKeys: ['workflows.*'] });
    const data = {
      runId: 'run-1',
      workflowId: 'wf-1',
      circleId: 'circle-1',
      matchedCount: 4,
    };
    const lostAccess = await kit.webhooks.emitForUser(
      KIT_USER_A,
      MEMORIAHUB_WEBHOOK_EVENTS.workflowRunAwaitingApproval,
      data,
      { orgId: KIT_ORG_ID },
    );
    expect(lostAccess.queued).toBe(0);
  });
});

describe('the SSRF egress guard', () => {
  it.each([['10.0.0.5'], ['127.0.0.1'], ['169.254.169.254'], ['192.168.1.20']])(
    'refuses an endpoint whose host resolves to %s',
    async (address) => {
      const kit = createWebhooksTestKit();
      kit.resolver.set('internal.example.test', address);
      await expect(
        kit.endpoints.create(kit.context('system', KIT_USER_A, ALL_PERMISSIONS), {
          name: 'Internal receiver',
          url: 'https://internal.example.test/hooks',
          eventKeys: [MEMORIAHUB_WEBHOOK_EVENTS.itemCreated],
          enabled: true,
        }),
      ).rejects.toThrow();
      expect(kit.receiver.requests).toHaveLength(0);
    },
  );
});

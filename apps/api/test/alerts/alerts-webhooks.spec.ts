// =============================================================================
// Alert incidents reach the webhooks slice (RETRO-H4, #603)
// =============================================================================
//
// The alerts slice's `AlertsDispatchService`, with MemoriaHub's
// `AlertsWebhookAdapter` as its `ALERTS_WEBHOOK_EMITTER`, over the webhooks
// test kit: a fired incident of a rule with `webhook` on becomes a signed
// `alerts.alert.fired` delivery to a subscribed deployment endpoint; a rule with
// `webhook` off sends nothing; the two events are in the system catalog.
// =============================================================================

import { AlertsDispatchService, ALERTS_WEBHOOK_EMITTER } from '@marinoscar/platform-api/alerts';
import { KIT_USER_A, createWebhooksTestKit, makeWebhookOwner } from '@marinoscar/platform-api/webhooks/testing';
import { webhookEventRegistry } from '@marinoscar/platform-api/webhooks';
import { verifyWebhookSignature } from '@marinoscar/platform-contract/webhooks';
import { MODULE_METADATA } from '@nestjs/common/constants';

import {
  AlertsWebhookAdapter,
  registerAlertWebhookEvents,
} from '../../src/platform/alerts/alerts-webhooks.adapter';
import { AlertsWebhooksHostModule } from '../../src/platform/alerts/alerts.config';

const RULE = {
  id: '00000000-0000-4000-8000-0000000000aa',
  key: 'memoriahub.example_rule',
  name: 'Queue backlog',
  kind: 'metric_threshold',
  severity: 'warning',
  webhook: true,
};

const INCIDENT = {
  id: '00000000-0000-4000-8000-0000000000bb',
  ruleId: RULE.id,
  labelsKey: 'node=node-1',
  labels: { node: 'node-1' },
  state: 'firing',
  severity: 'warning',
  pendingSince: null,
  firedAt: new Date('2026-11-01T10:00:00.000Z'),
  resolvedAt: null,
  lastValue: 91.5,
  lastSeenAt: new Date('2026-11-01T10:00:00.000Z'),
  summary: 'Queue backlog: 91.5 is above 90',
  acknowledgedAt: null,
  acknowledgedById: null,
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
};

const metrics = { transition: jest.fn() };

async function setup() {
  registerAlertWebhookEvents();
  const kit = createWebhooksTestKit();
  kit.repository.owners.set(
    KIT_USER_A,
    makeWebhookOwner({ id: KIT_USER_A, systemPermissions: ['system_webhooks:read'], permissions: [] }),
  );
  const { endpoint, secret } = await kit.seedEndpoint({ scope: 'system', ownerUserId: KIT_USER_A, eventKeys: ['alerts.*'] });
  const dispatch = new AlertsDispatchService(metrics as never, undefined, new AlertsWebhookAdapter(kit.webhooks));
  return { kit, endpoint, secret, dispatch };
}

describe('alert incidents and webhooks', () => {
  it('registers both alert events as system events in the Alerts group, once', () => {
    registerAlertWebhookEvents();
    expect(() => registerAlertWebhookEvents()).not.toThrow();
    for (const key of ['alerts.alert.fired', 'alerts.alert.resolved']) {
      const def = webhookEventRegistry.get(key);
      expect(def).toMatchObject({ audience: 'system', group: 'Alerts', permission: 'system_webhooks:read' });
      expect(def!.payloadSchema.safeParse(def!.example).success).toBe(true);
    }
  });

  it('binds ALERTS_WEBHOOK_EMITTER to the adapter in AlertsWebhooksHostModule', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AlertsWebhooksHostModule) as unknown[];
    expect(providers).toContainEqual({ provide: ALERTS_WEBHOOK_EMITTER, useExisting: AlertsWebhookAdapter });
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AlertsWebhooksHostModule)).toContain(ALERTS_WEBHOOK_EMITTER);
  });

  it('a fired incident becomes a signed alerts.alert.fired delivery', async () => {
    const { kit, endpoint, secret, dispatch } = await setup();
    await dispatch.dispatch('fired', RULE as never, INCIDENT as never, false);

    const deliveries = [...kit.repository.deliveries.values()].filter((row) => row.endpointId === endpoint.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].eventKey).toBe('alerts.alert.fired');

    await kit.runDeliveryJob(deliveries[0].id, null);
    const [request] = kit.receiver.requests;
    const body = JSON.parse(request.body);
    expect(body.type).toBe('alerts.alert.fired');
    expect(body.data).toMatchObject({ incidentId: INCIDENT.id, rule: { id: RULE.id, name: RULE.name }, value: 91.5 });
    await expect(
      verifyWebhookSignature({
        secret,
        id: request.headers['webhook-id'],
        timestamp: request.headers['webhook-timestamp'],
        body: request.body,
        signatureHeader: request.headers['webhook-signature'],
      }),
    ).resolves.toBe(true);
  });

  it('a resolved incident emits alerts.alert.resolved', async () => {
    const { kit, endpoint, dispatch } = await setup();
    await dispatch.dispatch(
      'resolved',
      RULE as never,
      { ...INCIDENT, state: 'resolved', resolvedAt: new Date('2026-11-01T10:30:00.000Z') } as never,
      false,
    );
    const keys = [...kit.repository.deliveries.values()].filter((row) => row.endpointId === endpoint.id).map((row) => row.eventKey);
    expect(keys).toEqual(['alerts.alert.resolved']);
  });

  it('a rule with webhook off sends nothing', async () => {
    const { kit, dispatch } = await setup();
    await dispatch.dispatch('fired', { ...RULE, webhook: false } as never, INCIDENT as never, false);
    expect(kit.repository.deliveries.size).toBe(0);
  });
});

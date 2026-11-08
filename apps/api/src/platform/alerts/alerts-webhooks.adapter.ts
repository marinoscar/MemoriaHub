// =============================================================================
// The alerts slice's optional webhook port, bound to the webhooks slice (RETRO-H4, #603)
// =============================================================================
//
// `ALERTS_WEBHOOK_EMITTER` is `WebhooksService.emit` (kvox precedent). The
// adapter only passes the event on: `emit` validates the data, records one
// delivery row per subscribed endpoint and enqueues the delivery jobs, and never
// calls a receiver itself, so a slow or failing receiver cannot hold up (or roll
// back) an incident. The slice calls it after the incident's write committed,
// and only for a rule whose `webhook` flag is on.
//
// Both events are `system`-audience (`orgId: null`): only the deployment's
// endpoints receive them, and an endpoint's owner must hold
// `system_webhooks:read`. They join the webhooks catalog under the `Alerts`
// group; their keys (`alerts.alert.fired`, `alerts.alert.resolved`) are the
// platform contract's and permanent.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { ALERT_WEBHOOK_EVENTS, alertWebhookDataSchema } from '@marinoscar/platform-contract/alerts';
import type { AlertsWebhookEmitter } from '@marinoscar/platform-api/alerts';
import {
  SYSTEM_WEBHOOKS_PERMISSIONS,
  WebhooksService,
  registerWebhookEvent,
  webhookEventRegistry,
} from '@marinoscar/platform-api/webhooks';

// Invented ids only.
const example: z.infer<typeof alertWebhookDataSchema> = {
  incidentId: '00000000-0000-4000-8000-000000000001',
  rule: {
    id: '00000000-0000-4000-8000-000000000002',
    key: null,
    name: 'Example rule',
    kind: 'metric_threshold',
    severity: 'warning',
  },
  labels: { node: 'node-1' },
  value: 91.5,
  summary: 'Example rule: 91.5 is above 90',
  firedAt: '2026-11-01T10:00:00.000Z',
  resolvedAt: null,
};

/** Registers `alerts.alert.fired` and `alerts.alert.resolved` in the webhooks catalog (idempotent; before bootstrap). */
export function registerAlertWebhookEvents(): void {
  const defs = [
    {
      key: ALERT_WEBHOOK_EVENTS.FIRED,
      label: 'Alert fired',
      description: 'An alert rule with webhooks on started firing.',
      example,
    },
    {
      key: ALERT_WEBHOOK_EVENTS.RESOLVED,
      label: 'Alert resolved',
      description: 'A firing alert of a rule with webhooks on cleared.',
      example: { ...example, resolvedAt: '2026-11-01T10:30:00.000Z' },
    },
  ];
  for (const def of defs) {
    if (webhookEventRegistry.has(def.key)) continue;
    registerWebhookEvent({
      ...def,
      group: 'Alerts',
      audience: 'system',
      permission: SYSTEM_WEBHOOKS_PERMISSIONS.SYSTEM_WEBHOOKS_READ.id,
      payloadSchema: alertWebhookDataSchema,
      source: 'alerts',
    });
  }
}

/** `AlertsWebhookEmitter` over `WebhooksService.emit`. */
@Injectable()
export class AlertsWebhookAdapter implements AlertsWebhookEmitter {
  constructor(private readonly webhooks: WebhooksService) {}

  async emit(eventKey: string, data: Record<string, unknown>, ctx: { orgId: string | null }): Promise<void> {
    await this.webhooks.emit(eventKey, data, { orgId: ctx.orgId });
  }
}

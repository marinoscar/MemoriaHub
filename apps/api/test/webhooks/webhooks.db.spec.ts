/**
 * Real-Postgres tier (RETRO-H4, #603): MemoriaHub's media webhook events on the platform tables.
 *
 * A deployment endpoint subscribed to `media.*`, 150 uploads raised through `MemoriaHubWebhooks`:
 * the batcher closes two batches (100 + 50) into two `webhooks.fanout` jobs on the platform `jobs`
 * table, and running them inserts exactly two `webhook_deliveries` rows (one per batch, never one
 * per item) plus their `webhooks.deliver` jobs. The subscription check reads `webhook_endpoints`
 * through the bypass client with the `webhooks` reason. No HTTP request is made: delivery is a
 * later job. Skips when no database is reachable.
 */
import { randomUUID } from 'node:crypto';

import { JobsService } from '@marinoscar/platform-api/jobs';
import {
  PrismaWebhooksRepository,
  WebhookFanoutHandler,
  WebhooksService,
  registerWebhooksSystemAccessReason,
} from '@marinoscar/platform-api/webhooks';

import '../../src/platform/webhooks/memoriahub-webhook-events';
import { MemoriaHubWebhooks } from '../../src/platform/webhooks/memoriahub-webhooks.service';
import { webhooksSystemPrisma } from '../../src/platform/webhooks/webhooks-host.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PrismaSystemService } from '../../src/prisma/prisma-system.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('media webhook events on the platform tables (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let system: PrismaSystemService;
  let endpointId: string;
  const circleId = randomUUID();
  const uploaderId = randomUUID();

  beforeAll(async () => {
    registerWebhooksSystemAccessReason();
    prisma = new PrismaService();
    system = new PrismaSystemService();
    await system.$connect();
    await prisma.$connect();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        orgId: null,
        scope: 'system',
        ownerUserId: null,
        createdById: null,
        name: 'Archive receiver',
        url: 'https://receiver.example.test/hooks/in',
        eventKeys: ['media.*'],
        enabled: true,
      },
    });
    endpointId = endpoint.id;
  });

  afterAll(async () => {
    await prisma.webhookEndpoint.deleteMany({ where: { id: endpointId } });
    await prisma.job.deleteMany({
      where: { type: { in: ['webhooks.fanout', 'webhooks.deliver'] }, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
    });
    await prisma.$disconnect();
    await system.$disconnect();
  });

  it('150 uploads become two fan-out jobs and two deliveries per subscribed endpoint', async () => {
    const jobs = new JobsService(prisma as never);
    const repository = new PrismaWebhooksRepository(prisma as never, webhooksSystemPrisma(system), jobs);
    const webhooks = new WebhooksService(repository, jobs, prisma as never, { record: async () => undefined } as never);
    const events = new MemoriaHubWebhooks(webhooks, prisma, system);
    const since = new Date();

    for (let n = 0; n < 150; n += 1) {
      events.mediaCreated({ id: randomUUID(), circleId, type: 'photo', capturedAt: null, addedById: uploaderId });
    }
    await events.flushPending();

    const fanouts = await prisma.job.findMany({
      where: { type: 'webhooks.fanout', createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
    });
    const created = fanouts.filter((job) => (job.payload as { eventKey: string }).eventKey === 'media.item.created');
    const uploads = fanouts.filter((job) => (job.payload as { eventKey: string }).eventKey === 'media.upload.completed');
    expect(created).toHaveLength(2);
    // The user event is queued too; with no user endpoint subscribed it will match nothing.
    expect(uploads).toHaveLength(2);
    expect(created.map((job) => (job.payload as { data: { count: number } }).data.count).sort()).toEqual([100, 50].sort());

    const fanout = new WebhookFanoutHandler({ register: () => undefined } as never, webhooks);
    for (const job of created) await fanout.process(job as never);

    const deliveries = await prisma.webhookDelivery.findMany({ where: { endpointId } });
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((delivery) => delivery.eventKey))).toEqual(new Set(['media.item.created']));
    const deliverJobs = await prisma.job.count({ where: { type: 'webhooks.deliver', createdAt: { gte: since } } });
    expect(deliverJobs).toBe(2);

    // Replaying a fan-out (a retried job) inserts nothing new: (endpoint, eventId) is unique.
    await fanout.process(created[0] as never);
    expect(await prisma.webhookDelivery.count({ where: { endpointId } })).toBe(2);
  });

  it('a deployment without a subscribed endpoint queues nothing', async () => {
    await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { enabled: false } });
    try {
      const jobs = new JobsService(prisma as never);
      const repository = new PrismaWebhooksRepository(prisma as never, webhooksSystemPrisma(system), jobs);
      const webhooks = new WebhooksService(repository, jobs, prisma as never, { record: async () => undefined } as never);
      const events = new MemoriaHubWebhooks(webhooks, prisma, system);
      const since = new Date();
      events.mediaTrashed(circleId, [randomUUID()]);
      await events.flushPending();
      expect(await prisma.job.count({ where: { type: 'webhooks.fanout', createdAt: { gte: since } } })).toBe(0);
    } finally {
      await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { enabled: true } });
    }
  });
});

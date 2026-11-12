/**
 * Real-Postgres tier (RETRO-C2, #581). One node-eligible job type, enqueued, claimed and settled
 * through the PLATFORM nodes slice over the MemoriaHub schema (every app migration applied to a
 * scratch database), with a fake executor in place of the CLI:
 *
 *   register (a node that was enrolled before the move re-attaches to its own row, same id)
 *     -> claim (the one-statement `FOR UPDATE SKIP LOCKED` claim, bounded by the node's eligible types)
 *     -> result (validated against the handler's `nodeResultSchema`, persisted by its
 *        `persistNodeResult`, the job settled `succeeded`)
 *
 * and the two rules the issue adds for MemoriaHub:
 *   - a server-only type (here: the provider-key types) is never offered to a node;
 *   - `NodeJobInputsAdapter` resolves a media-item job to the item's stored object and refuses a job
 *     whose item is gone (`NodeJobInputError`).
 *
 * Skips (reported as skipped, never passed) when nothing listens on the port.
 */
import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  JobClaimService,
  JobHandlerRegistry,
  JobLeaseService,
  JobTerminalService,
  JobsService,
  NodeOffloadService,
  ProviderThrottleService,
  type Job,
  type JobHandler,
} from '@marinoscar/platform-api/jobs';
import { NodeJobInputError, NodesService, type ClaimJobsDto, type NodeJobResultDto } from '@marinoscar/platform-api/nodes';
import type { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { NodeJobInputsAdapter } from '../../src/platform/jobs/node-job-inputs.adapter';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { createSharedLibrary } from '../helpers/library';
import { connectionUrl, createScratchDatabase, type ScratchDatabase } from './scratch-db';
import { orgScoped } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

const NODE_TYPE = 'retro.c2.checksum';
const SERVER_ONLY_TYPE = 'retro.c2.server_only';

describeMaybeDb('RETRO-C2 platform nodes slice: claim to result over the MemoriaHub schema (DB_GATED: real PostgreSQL)', () => {
  let scratch: ScratchDatabase;
  let prisma: PrismaClient;
  // The inputs adapter reads `media_items` on the plain client with no organization of its own (the app-reads
  // row of docs/platform-adoption/local-exceptions.md): its client carries the explicit `app.rls_bypass`
  // connection option, as the same ordinary role. Seeding and the jobs slice use `prisma` / the scoped `q`.
  let inputsPrisma: PrismaClient;
  let registry: JobHandlerRegistry;
  let jobs: JobsService;
  let nodes: NodesService;
  const persisted: Array<{ jobId: string; sha256: string }> = [];

  let ownerId: string;
  let nodeId: string;

  const q = async (sql: string, params: unknown[] = []) => (await orgScoped(scratch.db, { bypass: true }).query(sql, params)).rows;

  const checksumHandler: JobHandler = {
    type: NODE_TYPE,
    label: 'Retro C2 checksum (test)',
    process: async () => undefined,
    nodeResultSchema: z.object({ sha256: z.string().length(8) }),
    persistNodeResult: async (job: Job, result: unknown) => {
      persisted.push({ jobId: job.id, sha256: (result as { sha256: string }).sha256 });
    },
  };
  const serverOnlyHandler: JobHandler = { type: SERVER_ONLY_TYPE, label: 'Server only (test)', process: async () => undefined };

  beforeAll(async () => {
    scratch = await createScratchDatabase(`c2_round_${randomUUID().replace(/-/g, '').slice(0, 12)}`);
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionUrl(scratch.name), max: 4 }) });
    inputsPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: `${connectionUrl(scratch.name)}?options=${encodeURIComponent('-c app.rls_bypass=on')}`, max: 2 }),
    });

    ownerId = randomUUID();
    await q(`INSERT INTO users (id, email, is_active, updated_at) VALUES ($1, $2, true, now())`, [
      ownerId,
      `person-a-${randomUUID().slice(0, 8)}@example.test`,
    ]);

    registry = new JobHandlerRegistry();
    registry.register(checksumHandler);
    registry.register(serverOnlyHandler);

    const config = new ConfigService({});
    const settings = {
      getNodesPolicy: async () => ({
        staleHeartbeatSeconds: 60,
        offlineStaleMultiplier: 10,
        offlineRetentionDays: 14,
        jobSecretBrokerEnabled: false,
      }),
    } as unknown as SystemSettingsService;
    jobs = new JobsService(prisma as never);
    nodes = new NodesService(
      prisma as never,
      config,
      new JobClaimService(prisma as never),
      new JobTerminalService(prisma as never, config, new ProviderThrottleService(config), new EventEmitter2(), registry),
      new JobLeaseService(prisma as never),
      registry,
      new NodeOffloadService(registry, settings),
    );

    // A node enrolled BEFORE the move: its row (and id) came from the C2 migration.
    nodeId = randomUUID();
    await q(
      `INSERT INTO worker_nodes (id, name, hostname, platform, cli_version, eligible_types, concurrency, status, created_by_id)
       VALUES ($1, 'worker-one', 'host-a.example.test', 'linux', '1.3.9', ARRAY[]::text[], 1, 'offline', $2)`,
      [nodeId, ownerId],
    );
  }, 300_000);

  afterAll(async () => {
    await inputsPrisma?.$disconnect();
    await prisma?.$disconnect();
    await scratch?.drop();
  });

  it('re-attaches an existing node by owner and name (same row, same id) and brings it online', async () => {
    const registration = await nodes.register(ownerId, {
      name: 'worker-one',
      hostname: 'host-a.example.test',
      platform: 'linux',
      cliVersion: '2.0.0',
      eligibleTypes: [NODE_TYPE, SERVER_ONLY_TYPE],
      concurrency: 2,
    } as never);
    expect(registration.reattached).toBe(true);
    expect(registration.node.id).toBe(nodeId);
    expect(registration.node.status).toBe('online');
    expect(registration.node.cliVersion).toBe('2.0.0');
  });

  it('claims a node-eligible job, takes its result, persists it and settles the job', async () => {
    const queued = await jobs.enqueue({ type: NODE_TYPE, reason: 'upload', orgId: null, payload: { n: 1 } } as never);

    const claimed = await nodes.claimJobs(ownerId, nodeId, { limit: 1 } as ClaimJobsDto);
    expect(claimed.map((job) => job.id)).toEqual([queued.id]);
    expect(claimed[0]).toMatchObject({ status: 'running', executor: 'node', claimedByNodeId: nodeId });

    // What the fake executor computes: nothing but the job assignment it was handed.
    const settlement = await nodes.submitResult(ownerId, nodeId, queued.id, {
      type: NODE_TYPE,
      result: { sha256: 'ab12cd34' },
    } as NodeJobResultDto);

    expect(settlement).toMatchObject({ jobId: queued.id, outcome: 'succeeded', willRetry: false });
    expect(persisted).toEqual([{ jobId: queued.id, sha256: 'ab12cd34' }]);
    const [row] = await q(`SELECT status::text AS status, executor, claimed_by_node_id FROM jobs WHERE id = $1`, [queued.id]);
    expect(row.status).toBe('succeeded');
    expect(row.executor).toBe('node');
  });

  it('refuses a result that does not match the handler schema, and persists nothing', async () => {
    const before = persisted.length;
    const queued = await jobs.enqueue({ type: NODE_TYPE, reason: 'upload', orgId: null, payload: { n: 2 } } as never);
    await nodes.claimJobs(ownerId, nodeId, { limit: 1 } as ClaimJobsDto);

    await expect(
      nodes.submitResult(ownerId, nodeId, queued.id, { type: NODE_TYPE, result: { sha256: 'too-long-to-be-valid' } } as NodeJobResultDto),
    ).rejects.toMatchObject({ status: 400 });
    expect(persisted).toHaveLength(before);
  });

  it('never offers a server-only type to a node', async () => {
    const serverOnly = await jobs.enqueue({ type: SERVER_ONLY_TYPE, reason: 'upload', orgId: null, payload: {} } as never);
    // The held job from the previous case is still running; a fresh node-eligible one is claimable.
    await q(`UPDATE jobs SET status = 'succeeded', finished_at = now(), claimed_by_node_id = NULL WHERE type = $1 AND status = 'running'`, [NODE_TYPE]);
    const claimed = await nodes.claimJobs(ownerId, nodeId, { limit: 5 } as ClaimJobsDto);
    expect(claimed.map((job) => job.id)).not.toContain(serverOnly.id);
    const [row] = await q(`SELECT status::text AS status FROM jobs WHERE id = $1`, [serverOnly.id]);
    expect(row.status).toBe('pending');
  });

  describe('NODE_JOB_INPUTS: a media-item job reads its item\'s stored object', () => {
    let adapter: NodeJobInputsAdapter;
    let mediaItemId: string;
    let objectId: string;

    beforeAll(async () => {
      adapter = new NodeJobInputsAdapter(inputsPrisma as never);
      const org = (await q(`SELECT id FROM organizations WHERE is_default`))[0].id;
      objectId = randomUUID();
      mediaItemId = randomUUID();
      const circleId = randomUUID();
      // RETRO-K2: a shared library is a platform group of the scope id the content rows carry
      await createSharedLibrary(scratch.db, { id: circleId, name: 'Library Alpha', createdById: ownerId });
      await q(
        `INSERT INTO storage_objects (id, org_id, name, size, mime_type, storage_key, status, uploaded_by_id, updated_at)
         VALUES ($1, $2, 'photo-a.jpg', 4096, 'image/jpeg', $3, 'ready', $4, now())`,
        [objectId, org, `uploads/${objectId}/photo-a.jpg`, ownerId],
      );
      await q(
        `INSERT INTO media_items (id, circle_id, org_id, storage_object_id, type, source, original_filename, added_by_id, updated_at)
         VALUES ($1, $2, $3, $4, 'photo', 'web', 'photo-a.jpg', $5, now())`,
        [mediaItemId, circleId, org, objectId, ownerId],
      );
    });

    const job = (over: Partial<Job>): Job => ({ id: randomUUID(), type: NODE_TYPE, subjectType: 'media_item', subjectId: null, ...over }) as Job;

    it('resolves the stored object of the item', async () => {
      const resolved = await adapter.resolve(job({ subjectId: mediaItemId }));
      expect(resolved).toEqual({
        id: objectId,
        storageKey: `uploads/${objectId}/photo-a.jpg`,
        size: 4096n,
        mimeType: 'image/jpeg',
      });
    });

    it('refuses a job whose media item is gone, and a job that is not about a media item', async () => {
      await expect(adapter.resolve(job({ subjectId: randomUUID() }))).rejects.toMatchObject({
        constructor: NodeJobInputError,
        reason: 'input_object_not_found',
      });
      await expect(adapter.resolve(job({ subjectType: 'circle', subjectId: randomUUID() }))).rejects.toMatchObject({
        reason: 'missing_subject_id',
      });
      await expect(adapter.resolve(job({ subjectType: null, subjectId: null }))).rejects.toBeInstanceOf(NodeJobInputError);
    });
  });
});

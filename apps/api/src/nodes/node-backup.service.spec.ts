/**
 * Unit tests for NodeBackupService (issue #312, epic #308 — node backup
 * control plane).
 *
 * Covers:
 *  1. getConfig — { config: null } when unconfigured; populated shape with
 *     BigInt-as-string fields, pending wired to getPendingLag, checkpoint
 *     null-vs-set, and activeRunId resolution
 *  2. updateConfig — bad cron 400, bad timezone 400, foreign circleId 400,
 *     nextRunAt recompute on schedule change and clear on scheduleCron null
 *  3. startRun — cursorStart snapshots the checkpoint; 409 (with activeRunId)
 *     on a fresh active run; stale running runs are released (marked stale)
 *     and the new run proceeds; scheduled trigger rolls nextRunAt; 400 when
 *     unconfigured or disabled
 *  4. getChanges — 409 without the active run; lastAckAt refreshed by the
 *     page fetch; both-or-neither cursor 400; limit clamped to
 *     backup.maxPageSize; downloadUrl null on tombstone / not-ready /
 *     presign-throw; nextCursor from the last item even on a partial page
 *  5. ack — 409 on cursor regression; equal cursor accepted; single
 *     $transaction accumulating config checkpoint/counters + run counters;
 *     checkpoint echoed back
 *  6. finishRun — completed stamps lastCompletedRunAt (+ lastReconcileAt for
 *     reconcile runs); 400 on double-finish; 404 for a foreign node's run
 *  7. getManifest — 409 without the active run; id-keyset paging + 1000 cap
 *  8. markStaleRuns — only stale running runs are targeted
 *  9. Serialization — JSON.stringify never throws on any response shape
 *     (BigInt-as-string rule)
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeBackupService } from './node-backup.service';
import { NodesService } from './nodes.service';
import { NodeBackupQueryService } from './node-backup-query.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const OWNER_ID = 'user-1';
const NODE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const CIRCLE_A = '33333333-3333-4333-8333-333333333333';
const CIRCLE_B = '44444444-4444-4444-8444-444444444444';
const ITEM_ID_1 = '55555555-5555-4555-8555-555555555555';
const ITEM_ID_2 = '66666666-6666-4666-8666-666666666666';
const OBJECT_ID = '77777777-7777-4777-8777-777777777777';
const CKPT_ID = '88888888-8888-4888-8888-888888888888';

const NOW = Date.now();

function makeNode(overrides: Partial<any> = {}) {
  return {
    id: NODE_ID,
    name: 'backup-node',
    hostname: 'host',
    platform: 'linux',
    cliVersion: '1.2.0',
    eligibleTypes: [],
    concurrency: 1,
    status: 'online',
    capabilities: null,
    registeredAt: new Date(NOW - 86_400_000),
    lastHeartbeatAt: new Date(NOW),
    createdById: OWNER_ID,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<any> = {}) {
  return {
    id: 'cfg-1',
    nodeId: NODE_ID,
    enabled: true,
    scheduleCron: '0 3 * * *',
    timezone: 'America/Costa_Rica',
    nextRunAt: new Date(NOW + 3_600_000),
    circleIds: [],
    checkpointUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
    checkpointId: CKPT_ID,
    itemsAcked: 41230n,
    bytesAcked: 812345678901n,
    lastRunAt: new Date('2026-08-07T03:00:00.000Z'),
    lastCompletedRunAt: new Date('2026-08-07T03:30:00.000Z'),
    lastReconcileAt: null,
    createdAt: new Date(NOW - 86_400_000),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function makeRun(overrides: Partial<any> = {}) {
  return {
    id: RUN_ID,
    nodeId: NODE_ID,
    kind: 'incremental',
    status: 'running',
    trigger: 'manual',
    startedAt: new Date(NOW - 60_000),
    finishedAt: null,
    lastAckAt: new Date(NOW - 30_000),
    itemsDownloaded: 10,
    itemsSkipped: 2,
    sidecarsWritten: 12,
    bytesDownloaded: 1234n,
    errorCount: 0,
    lastError: null,
    cliVersion: '1.2.0',
    cursorStartUpdatedAt: null,
    cursorStartId: null,
    cursorEndUpdatedAt: null,
    cursorEndId: null,
    ...overrides,
  };
}

function makeFeedItem(overrides: Partial<any> = {}) {
  return {
    id: ITEM_ID_1,
    circleId: CIRCLE_A,
    type: 'photo',
    originalFilename: 'photo.jpg',
    capturedAt: new Date('2026-01-01T10:00:00.000Z'),
    capturedAtOffset: -300,
    createdAt: new Date('2026-01-01T10:05:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    importedAt: new Date('2026-01-01T10:05:01.000Z'),
    contentHash: 'a'.repeat(64),
    deletedAt: null,
    archivedAt: null,
    storageObject: {
      id: OBJECT_ID,
      size: 5242880n,
      mimeType: 'image/jpeg',
      storageKey: 'originals/x.jpg',
      status: 'ready',
    },
    ...overrides,
  };
}

function defaultSettings(overrides: Partial<any> = {}) {
  return {
    backup: {
      maxPageSize: 200,
      feedSafetyHorizonSeconds: 5,
      runStaleMinutes: 15,
      ...overrides,
    },
  };
}

const defaultStats = {
  itemsDownloaded: 5,
  itemsSkipped: 3,
  sidecarsWritten: 8,
  bytesDownloaded: '1000',
  errors: 1,
};

// ---------------------------------------------------------------------------
// Test module
// ---------------------------------------------------------------------------

describe('NodeBackupService', () => {
  let service: NodeBackupService;
  let mockPrisma: MockPrismaService & any;
  let nodesService: { assertOwnership: jest.Mock };
  let queryService: {
    resolveScope: jest.Mock;
    getPendingLag: jest.Mock;
    getChanges: jest.Mock;
    composeSidecar: jest.Mock;
    getManifest: jest.Mock;
    getDimensions: jest.Mock;
  };
  let objectsService: { getInternalDownloadUrl: jest.Mock };
  let systemSettings: { getSettings: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService() as any;
    nodesService = { assertOwnership: jest.fn().mockResolvedValue(makeNode()) };
    queryService = {
      resolveScope: jest.fn().mockResolvedValue([CIRCLE_A]),
      getPendingLag: jest.fn().mockResolvedValue({ items: 152, bytes: 9876543210n }),
      getChanges: jest.fn().mockResolvedValue([]),
      composeSidecar: jest.fn().mockReturnValue({ schemaVersion: 1 }),
      getManifest: jest.fn().mockResolvedValue([]),
      getDimensions: jest
        .fn()
        .mockResolvedValue({ albums: [], people: [], tags: [] }),
    };
    objectsService = {
      getInternalDownloadUrl: jest.fn().mockResolvedValue('https://signed.example/get'),
    };
    systemSettings = { getSettings: jest.fn().mockResolvedValue(defaultSettings()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeBackupService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NodesService, useValue: nodesService },
        { provide: NodeBackupQueryService, useValue: queryService },
        { provide: ObjectsService, useValue: objectsService },
        { provide: SystemSettingsService, useValue: systemSettings },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, def?: unknown) => def) },
        },
      ],
    }).compile();

    service = module.get(NodeBackupService);
  });

  // =========================================================================
  // getConfig
  // =========================================================================

  describe('getConfig', () => {
    it('returns { config: null } when backup has never been configured', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(null);

      await expect(service.getConfig(USER_ID, NODE_ID)).resolves.toEqual({
        config: null,
      });
      expect(nodesService.assertOwnership).toHaveBeenCalledWith(USER_ID, NODE_ID);
    });

    it('returns the populated shape with BigInt fields as STRINGS and pending from getPendingLag', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findFirst.mockResolvedValue({ id: RUN_ID });

      const result = await service.getConfig(USER_ID, NODE_ID);

      expect(result.config).toMatchObject({
        nodeId: NODE_ID,
        enabled: true,
        scheduleCron: '0 3 * * *',
        timezone: 'America/Costa_Rica',
        circleIds: [],
        checkpoint: { updatedAt: '2026-08-01T00:00:00.000Z', id: CKPT_ID },
        itemsAcked: '41230',
        bytesAcked: '812345678901',
        pending: { items: 152, bytes: '9876543210' },
        activeRunId: RUN_ID,
      });
      // Pending is computed past the CURRENT checkpoint cursor.
      expect(queryService.getPendingLag).toHaveBeenCalledWith([CIRCLE_A], {
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        id: CKPT_ID,
      });
    });

    it('reports a null checkpoint and null activeRunId before the first ack / with no active run', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(
        makeConfig({ checkpointUpdatedAt: null, checkpointId: null }),
      );
      mockPrisma.nodeBackupRun.findFirst.mockResolvedValue(null);

      const result = await service.getConfig(USER_ID, NODE_ID);

      expect(result.config).toMatchObject({ checkpoint: null, activeRunId: null });
      expect(queryService.getPendingLag).toHaveBeenCalledWith([CIRCLE_A], null);
    });

    it('only treats a FRESH running run as active (lastAckAt >= now - runStaleMinutes)', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findFirst.mockResolvedValue(null);

      await service.getConfig(USER_ID, NODE_ID);

      const arg = mockPrisma.nodeBackupRun.findFirst.mock.calls[0][0];
      expect(arg.where.status).toBe('running');
      const cutoff: Date = arg.where.lastAckAt.gte;
      const expected = Date.now() - 15 * 60_000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
    });
  });

  // =========================================================================
  // updateConfig
  // =========================================================================

  describe('updateConfig', () => {
    beforeEach(() => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(null);
      mockPrisma.nodeBackupRun.findFirst.mockResolvedValue(null);
      mockPrisma.nodeBackupConfig.upsert.mockImplementation(async (args: any) =>
        makeConfig({
          ...args.create,
          itemsAcked: 0n,
          bytesAcked: 0n,
          checkpointUpdatedAt: null,
          checkpointId: null,
          lastRunAt: null,
          lastCompletedRunAt: null,
        }),
      );
    });

    it('rejects an invalid cron expression with 400', async () => {
      await expect(
        service.updateConfig(USER_ID, NODE_ID, { scheduleCron: 'not a cron' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.nodeBackupConfig.upsert).not.toHaveBeenCalled();
    });

    it('rejects an unknown timezone with 400', async () => {
      await expect(
        service.updateConfig(USER_ID, NODE_ID, { timezone: 'Not/AZone' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.nodeBackupConfig.upsert).not.toHaveBeenCalled();
    });

    it('rejects circleIds the node owner is not a member of with 400', async () => {
      mockPrisma.circleMember.findMany.mockResolvedValue([{ circleId: CIRCLE_A }]);

      await expect(
        service.updateConfig(USER_ID, NODE_ID, { circleIds: [CIRCLE_A, CIRCLE_B] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.circleMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER_ID }),
        }),
      );
      expect(mockPrisma.nodeBackupConfig.upsert).not.toHaveBeenCalled();
    });

    it('accepts member circleIds and persists them', async () => {
      mockPrisma.circleMember.findMany.mockResolvedValue([
        { circleId: CIRCLE_A },
        { circleId: CIRCLE_B },
      ]);

      await service.updateConfig(USER_ID, NODE_ID, {
        circleIds: [CIRCLE_A, CIRCLE_B],
      });

      const upsert = mockPrisma.nodeBackupConfig.upsert.mock.calls[0][0];
      expect(upsert.create.circleIds).toEqual([CIRCLE_A, CIRCLE_B]);
    });

    it('computes nextRunAt when scheduleCron is set (timezone-aware, default UTC)', async () => {
      await service.updateConfig(USER_ID, NODE_ID, { scheduleCron: '0 3 * * *' });

      const upsert = mockPrisma.nodeBackupConfig.upsert.mock.calls[0][0];
      const next: Date = upsert.create.nextRunAt;
      expect(next).toBeInstanceOf(Date);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      // 03:00 UTC — cron evaluated in UTC when no timezone was supplied.
      expect(next.getUTCHours()).toBe(3);
      expect(next.getUTCMinutes()).toBe(0);
    });

    it('recomputes nextRunAt when the timezone changes on an existing schedule', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(
        makeConfig({ timezone: null, nextRunAt: new Date('2020-01-01T03:00:00Z') }),
      );

      await service.updateConfig(USER_ID, NODE_ID, {
        timezone: 'America/Costa_Rica',
      });

      const upsert = mockPrisma.nodeBackupConfig.upsert.mock.calls[0][0];
      const next: Date = upsert.update.nextRunAt;
      expect(next.getTime()).toBeGreaterThan(Date.now());
      // 03:00 in UTC-06:00 (no DST) = 09:00 UTC.
      expect(next.getUTCHours()).toBe(9);
    });

    it('clears nextRunAt when scheduleCron is set to null', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());

      await service.updateConfig(USER_ID, NODE_ID, { scheduleCron: null });

      const upsert = mockPrisma.nodeBackupConfig.upsert.mock.calls[0][0];
      expect(upsert.update.scheduleCron).toBeNull();
      expect(upsert.update.nextRunAt).toBeNull();
    });

    it('leaves nextRunAt untouched when only enabled changes', async () => {
      const existing = makeConfig();
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(existing);

      await service.updateConfig(USER_ID, NODE_ID, { enabled: false });

      const upsert = mockPrisma.nodeBackupConfig.upsert.mock.calls[0][0];
      expect(upsert.update.enabled).toBe(false);
      expect(upsert.update.nextRunAt).toBe(existing.nextRunAt);
    });

    it('responds with the GET shape', async () => {
      const result = await service.updateConfig(USER_ID, NODE_ID, {
        scheduleCron: '0 3 * * *',
      });

      expect(result.config).toMatchObject({
        nodeId: NODE_ID,
        scheduleCron: '0 3 * * *',
        pending: { items: 152, bytes: '9876543210' },
      });
    });
  });

  // =========================================================================
  // startRun
  // =========================================================================

  describe('startRun', () => {
    const startDto = {
      kind: 'incremental' as const,
      trigger: 'manual' as const,
      cliVersion: '1.2.0',
    };

    beforeEach(() => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([]);
      mockPrisma.nodeBackupRun.create.mockImplementation(async (args: any) =>
        makeRun({ ...args.data, id: 'new-run-1' }),
      );
      mockPrisma.nodeBackupConfig.update.mockResolvedValue(makeConfig());
    });

    it('400s when backup is not configured', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(null);
      await expect(service.startRun(USER_ID, NODE_ID, startDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400s when the config is disabled (manual runs too)', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(
        makeConfig({ enabled: false }),
      );
      await expect(service.startRun(USER_ID, NODE_ID, startDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('snapshots the config checkpoint into cursorStart and sets lastAckAt/lastRunAt', async () => {
      const result = await service.startRun(USER_ID, NODE_ID, startDto);

      const createArgs = mockPrisma.nodeBackupRun.create.mock.calls[0][0];
      expect(createArgs.data).toMatchObject({
        nodeId: NODE_ID,
        kind: 'incremental',
        status: 'running',
        trigger: 'manual',
        cliVersion: '1.2.0',
        cursorStartUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
        cursorStartId: CKPT_ID,
      });
      expect(createArgs.data.lastAckAt).toBeInstanceOf(Date);

      const configUpdate = mockPrisma.nodeBackupConfig.update.mock.calls[0][0];
      expect(configUpdate.data.lastRunAt).toBeInstanceOf(Date);
      // Manual trigger must NOT roll nextRunAt.
      expect(configUpdate.data.nextRunAt).toBeUndefined();

      expect(result).toEqual({
        run: {
          id: 'new-run-1',
          kind: 'incremental',
          startedAt: expect.any(String),
          cursorStart: {
            updatedAt: '2026-08-01T00:00:00.000Z',
            id: CKPT_ID,
          },
        },
      });
    });

    it('409s with the activeRunId when a fresh running run exists', async () => {
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([
        makeRun({ lastAckAt: new Date() }),
      ]);

      let err: any;
      try {
        await service.startRun(USER_ID, NODE_ID, startDto);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ activeRunId: RUN_ID });
      expect(mockPrisma.nodeBackupRun.create).not.toHaveBeenCalled();
    });

    it('releases a STALE running run (marks it stale + finishedAt) and proceeds', async () => {
      const staleRun = makeRun({
        id: 'stale-run-1',
        lastAckAt: new Date(NOW - 60 * 60_000), // 1h ago >> 15 min window
      });
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([staleRun]);

      const result = await service.startRun(USER_ID, NODE_ID, startDto);

      expect(mockPrisma.nodeBackupRun.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['stale-run-1'] } },
        data: { status: 'stale', finishedAt: expect.any(Date) },
      });
      expect(result.run.id).toBe('new-run-1');
    });

    it('rolls nextRunAt forward (config timezone) when trigger is scheduled', async () => {
      await service.startRun(USER_ID, NODE_ID, { ...startDto, trigger: 'scheduled' });

      const configUpdate = mockPrisma.nodeBackupConfig.update.mock.calls[0][0];
      const next: Date = configUpdate.data.nextRunAt;
      expect(next).toBeInstanceOf(Date);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      // '0 3 * * *' in America/Costa_Rica (UTC-06:00, no DST) fires at 09:00 UTC.
      expect(next.getUTCHours()).toBe(9);
    });
  });

  // =========================================================================
  // getChanges
  // =========================================================================

  describe('getChanges', () => {
    beforeEach(() => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(makeRun());
      mockPrisma.nodeBackupRun.update.mockResolvedValue(makeRun());
    });

    it('409s when runId is not a run of this node', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ nodeId: 'other-node' }),
      );
      await expect(
        service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s when the run is no longer running or has gone stale', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'completed' }),
      );
      await expect(
        service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID }),
      ).rejects.toBeInstanceOf(ConflictException);

      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ lastAckAt: new Date(NOW - 60 * 60_000) }),
      );
      await expect(
        service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refreshes the run lastAckAt — a page fetch counts as liveness', async () => {
      await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID });

      expect(mockPrisma.nodeBackupRun.update).toHaveBeenCalledWith({
        where: { id: RUN_ID },
        data: { lastAckAt: expect.any(Date) },
      });
    });

    it('400s when only one cursor half is provided', async () => {
      await expect(
        service.getChanges(USER_ID, NODE_ID, {
          runId: RUN_ID,
          updatedAfter: '2026-08-01T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID, afterId: ITEM_ID_1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('passes the parsed cursor through and defaults limit to 100', async () => {
      await service.getChanges(USER_ID, NODE_ID, {
        runId: RUN_ID,
        updatedAfter: '2026-08-01T00:00:00.000Z',
        afterId: ITEM_ID_1,
      });

      expect(queryService.getChanges).toHaveBeenCalledWith(
        [CIRCLE_A],
        { updatedAt: new Date('2026-08-01T00:00:00.000Z'), id: ITEM_ID_1 },
        100,
      );
    });

    it('clamps limit to backup.maxPageSize', async () => {
      await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID, limit: 100000 });
      expect(queryService.getChanges).toHaveBeenCalledWith([CIRCLE_A], null, 200);
    });

    it('returns presigned items with sidecars, nextCursor from the last item, and hasMore on a full page', async () => {
      const item1 = makeFeedItem();
      const item2 = makeFeedItem({
        id: ITEM_ID_2,
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      });
      queryService.getChanges.mockResolvedValue([item1, item2]);

      const result = await service.getChanges(USER_ID, NODE_ID, {
        runId: RUN_ID,
        limit: 2,
      });

      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: ITEM_ID_1,
        circleId: CIRCLE_A,
        storage: {
          objectId: OBJECT_ID,
          size: '5242880',
          mimeType: 'image/jpeg',
          status: 'ready',
        },
        downloadUrl: 'https://signed.example/get',
        sidecar: { schemaVersion: 1 },
      });
      expect(result.items[0].downloadUrlExpiresAt).toEqual(expect.any(String));
      expect(result.nextCursor).toEqual({
        updatedAt: '2026-01-03T00:00:00.000Z',
        id: ITEM_ID_2,
      });
      expect(result.hasMore).toBe(true);
      expect(result.safetyHorizon).toEqual(expect.any(String));
    });

    it('still advances nextCursor on a PARTIAL page, with hasMore false', async () => {
      queryService.getChanges.mockResolvedValue([makeFeedItem()]);

      const result = await service.getChanges(USER_ID, NODE_ID, {
        runId: RUN_ID,
        limit: 50,
      });

      expect(result.nextCursor).toEqual({
        updatedAt: '2026-01-02T00:00:00.000Z',
        id: ITEM_ID_1,
      });
      expect(result.hasMore).toBe(false);
    });

    it('returns nextCursor null on a zero-item page', async () => {
      queryService.getChanges.mockResolvedValue([]);
      const result = await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID });
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('nulls downloadUrl for a tombstone (deletedAt set) without presigning', async () => {
      queryService.getChanges.mockResolvedValue([
        makeFeedItem({ deletedAt: new Date('2026-08-01T00:00:00.000Z') }),
      ]);

      const result = await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID });

      expect(result.items[0].downloadUrl).toBeNull();
      expect(result.items[0].downloadUrlExpiresAt).toBeNull();
      expect(objectsService.getInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('nulls downloadUrl when the storage object is not ready', async () => {
      queryService.getChanges.mockResolvedValue([
        makeFeedItem({
          storageObject: { ...makeFeedItem().storageObject, status: 'processing' },
        }),
      ]);

      const result = await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID });

      expect(result.items[0].downloadUrl).toBeNull();
      expect(objectsService.getInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('nulls downloadUrl (item still returned) when presigning throws', async () => {
      queryService.getChanges.mockResolvedValue([makeFeedItem()]);
      objectsService.getInternalDownloadUrl.mockRejectedValue(new Error('boom'));

      const result = await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].downloadUrl).toBeNull();
      expect(result.items[0].downloadUrlExpiresAt).toBeNull();
    });
  });

  // =========================================================================
  // ack
  // =========================================================================

  describe('ack', () => {
    const ackDto = {
      runId: RUN_ID,
      cursor: { updatedAt: '2026-08-02T00:00:00.000Z', id: CKPT_ID },
      stats: defaultStats,
    };

    beforeEach(() => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(makeRun());
    });

    it('409s when the run is not the active running run', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'stale' }),
      );
      await expect(service.ack(USER_ID, NODE_ID, ackDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('409s on a cursor strictly behind the stored checkpoint (time regression)', async () => {
      await expect(
        service.ack(USER_ID, NODE_ID, {
          ...ackDto,
          cursor: { updatedAt: '2026-07-01T00:00:00.000Z', id: CKPT_ID },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s on an equal-time, lower-id cursor regression', async () => {
      await expect(
        service.ack(USER_ID, NODE_ID, {
          ...ackDto,
          cursor: {
            updatedAt: '2026-08-01T00:00:00.000Z',
            // Lexicographically below the stored checkpoint id (8888…).
            id: '00000000-0000-4000-8000-000000000000',
          },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts an EQUAL cursor as a no-op advance', async () => {
      const result = await service.ack(USER_ID, NODE_ID, {
        ...ackDto,
        cursor: { updatedAt: '2026-08-01T00:00:00.000Z', id: CKPT_ID },
      });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.checkpoint).toEqual({
        updatedAt: '2026-08-01T00:00:00.000Z',
        id: CKPT_ID,
      });
    });

    it('advances the checkpoint and accumulates stats in ONE transaction, echoing the checkpoint', async () => {
      const result = await service.ack(USER_ID, NODE_ID, ackDto);

      // Both writes went through a single $transaction call.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      const configUpdate = mockPrisma.nodeBackupConfig.update.mock.calls[0][0];
      expect(configUpdate).toEqual({
        where: { nodeId: NODE_ID },
        data: {
          checkpointUpdatedAt: new Date('2026-08-02T00:00:00.000Z'),
          checkpointId: CKPT_ID,
          // itemsAcked += downloaded + skipped; bytesAcked += BigInt(bytes).
          itemsAcked: { increment: 8 },
          bytesAcked: { increment: 1000n },
        },
      });

      const runUpdate = mockPrisma.nodeBackupRun.update.mock.calls[0][0];
      expect(runUpdate.where).toEqual({ id: RUN_ID });
      expect(runUpdate.data).toMatchObject({
        itemsDownloaded: { increment: 5 },
        itemsSkipped: { increment: 3 },
        sidecarsWritten: { increment: 8 },
        bytesDownloaded: { increment: 1000n },
        errorCount: { increment: 1 },
        lastAckAt: expect.any(Date),
        cursorEndUpdatedAt: new Date('2026-08-02T00:00:00.000Z'),
        cursorEndId: CKPT_ID,
      });

      expect(result).toEqual({
        ok: true,
        checkpoint: { updatedAt: '2026-08-02T00:00:00.000Z', id: CKPT_ID },
      });
    });

    it('accepts any cursor when no checkpoint is stored yet (first ack)', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(
        makeConfig({ checkpointUpdatedAt: null, checkpointId: null }),
      );

      await expect(service.ack(USER_ID, NODE_ID, ackDto)).resolves.toMatchObject({
        ok: true,
      });
    });
  });

  // =========================================================================
  // finishRun
  // =========================================================================

  describe('finishRun', () => {
    beforeEach(() => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(makeRun());
      mockPrisma.nodeBackupRun.update.mockResolvedValue(makeRun());
      mockPrisma.nodeBackupConfig.updateMany.mockResolvedValue({ count: 1 });
    });

    it('404s for an unknown run', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(null);
      await expect(
        service.finishRun(USER_ID, NODE_ID, RUN_ID, { status: 'completed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s for another node's run (enumeration-resistant)", async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ nodeId: 'other-node' }),
      );
      await expect(
        service.finishRun(USER_ID, NODE_ID, RUN_ID, { status: 'completed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400s when the run is already terminal', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ status: 'completed' }),
      );
      await expect(
        service.finishRun(USER_ID, NODE_ID, RUN_ID, { status: 'failed' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('completed sets finishedAt and stamps config lastCompletedRunAt (incremental: no lastReconcileAt)', async () => {
      await service.finishRun(USER_ID, NODE_ID, RUN_ID, { status: 'completed' });

      expect(mockPrisma.nodeBackupRun.update).toHaveBeenCalledWith({
        where: { id: RUN_ID },
        data: expect.objectContaining({
          status: 'completed',
          finishedAt: expect.any(Date),
        }),
      });
      const cfgUpdate = mockPrisma.nodeBackupConfig.updateMany.mock.calls[0][0];
      expect(cfgUpdate.where).toEqual({ nodeId: NODE_ID });
      expect(cfgUpdate.data.lastCompletedRunAt).toBeInstanceOf(Date);
      expect(cfgUpdate.data.lastReconcileAt).toBeUndefined();
    });

    it('a completed reconcile run also stamps lastReconcileAt', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(
        makeRun({ kind: 'reconcile' }),
      );

      await service.finishRun(USER_ID, NODE_ID, RUN_ID, { status: 'completed' });

      const cfgUpdate = mockPrisma.nodeBackupConfig.updateMany.mock.calls[0][0];
      expect(cfgUpdate.data.lastReconcileAt).toBeInstanceOf(Date);
    });

    it('failed records lastError and does NOT stamp lastCompletedRunAt', async () => {
      await service.finishRun(USER_ID, NODE_ID, RUN_ID, {
        status: 'failed',
        error: 'disk full',
      });

      expect(mockPrisma.nodeBackupRun.update).toHaveBeenCalledWith({
        where: { id: RUN_ID },
        data: expect.objectContaining({ status: 'failed', lastError: 'disk full' }),
      });
      expect(mockPrisma.nodeBackupConfig.updateMany).not.toHaveBeenCalled();
    });

    it('accumulates finalStats onto the run counters when provided', async () => {
      await service.finishRun(USER_ID, NODE_ID, RUN_ID, {
        status: 'completed',
        finalStats: defaultStats,
      });

      const update = mockPrisma.nodeBackupRun.update.mock.calls[0][0];
      expect(update.data).toMatchObject({
        itemsDownloaded: { increment: 5 },
        itemsSkipped: { increment: 3 },
        sidecarsWritten: { increment: 8 },
        bytesDownloaded: { increment: 1000n },
        errorCount: { increment: 1 },
      });
    });
  });

  // =========================================================================
  // listRuns
  // =========================================================================

  describe('listRuns', () => {
    it('lists newest first with the default limit of 20 and BigInt bytes as strings', async () => {
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([makeRun()]);

      const result = await service.listRuns(USER_ID, NODE_ID);

      expect(mockPrisma.nodeBackupRun.findMany).toHaveBeenCalledWith({
        where: { nodeId: NODE_ID },
        orderBy: { startedAt: 'desc' },
        take: 20,
      });
      expect(result.runs[0]).toMatchObject({
        id: RUN_ID,
        kind: 'incremental',
        status: 'running',
        trigger: 'manual',
        bytesDownloaded: '1234',
        cliVersion: '1.2.0',
      });
    });

    it('caps limit at 100', async () => {
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([]);
      await service.listRuns(USER_ID, NODE_ID, 5000);
      expect(mockPrisma.nodeBackupRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  // =========================================================================
  // getManifest
  // =========================================================================

  describe('getManifest', () => {
    beforeEach(() => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(makeRun());
      mockPrisma.nodeBackupRun.update.mockResolvedValue(makeRun());
    });

    it('409s without a valid active run', async () => {
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(null);
      await expect(
        service.getManifest(USER_ID, NODE_ID, { runId: RUN_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refreshes lastAckAt, pages by afterId, and hard-caps the limit at 1000', async () => {
      queryService.getManifest.mockResolvedValue([
        {
          id: ITEM_ID_1,
          contentHash: 'abc',
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          deletedAt: null,
          archivedAt: null,
        },
      ]);

      const result = await service.getManifest(USER_ID, NODE_ID, {
        runId: RUN_ID,
        afterId: CKPT_ID,
        limit: 100000,
      });

      expect(mockPrisma.nodeBackupRun.update).toHaveBeenCalledWith({
        where: { id: RUN_ID },
        data: { lastAckAt: expect.any(Date) },
      });
      expect(queryService.getManifest).toHaveBeenCalledWith([CIRCLE_A], CKPT_ID, 1000);
      expect(result.items[0]).toEqual({
        id: ITEM_ID_1,
        contentHash: 'abc',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deletedAt: null,
        archivedAt: null,
      });
      expect(result.nextAfterId).toBe(ITEM_ID_1);
      expect(result.hasMore).toBe(false);
    });

    it('reports hasMore true on a full page', async () => {
      queryService.getManifest.mockResolvedValue([
        {
          id: ITEM_ID_1,
          contentHash: 'abc',
          updatedAt: new Date(),
          deletedAt: null,
          archivedAt: null,
        },
      ]);

      const result = await service.getManifest(USER_ID, NODE_ID, {
        runId: RUN_ID,
        limit: 1,
      });
      expect(result.hasMore).toBe(true);
    });
  });

  // =========================================================================
  // getDimensions
  // =========================================================================

  describe('getDimensions', () => {
    it('requires no run/config and returns catalogs plus generatedAt', async () => {
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(null);

      const result = await service.getDimensions(USER_ID, NODE_ID);

      // Unconfigured node: scope defaults to ALL owner circles (empty circleIds).
      expect(queryService.resolveScope).toHaveBeenCalledWith(OWNER_ID, []);
      expect(result).toEqual({
        albums: [],
        people: [],
        tags: [],
        generatedAt: expect.any(String),
      });
    });
  });

  // =========================================================================
  // markStaleRuns
  // =========================================================================

  describe('markStaleRuns', () => {
    it('marks only running runs whose lastAckAt fell outside runStaleMinutes', async () => {
      mockPrisma.nodeBackupRun.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.markStaleRuns();

      expect(count).toBe(2);
      const arg = mockPrisma.nodeBackupRun.updateMany.mock.calls[0][0];
      expect(arg.where.status).toBe('running');
      const cutoff: Date = arg.where.lastAckAt.lt;
      const expected = Date.now() - 15 * 60_000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
      expect(arg.data).toEqual({ status: 'stale', finishedAt: expect.any(Date) });
    });
  });

  // =========================================================================
  // Serialization — the BigInt-as-string rule
  // =========================================================================

  describe('response serialization', () => {
    it('JSON.stringify never throws on any response shape', async () => {
      // getConfig
      mockPrisma.nodeBackupConfig.findUnique.mockResolvedValue(makeConfig());
      mockPrisma.nodeBackupRun.findFirst.mockResolvedValue({ id: RUN_ID });
      const config = await service.getConfig(USER_ID, NODE_ID);
      expect(() => JSON.stringify(config)).not.toThrow();

      // startRun
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([]);
      mockPrisma.nodeBackupRun.create.mockImplementation(async (args: any) =>
        makeRun({ ...args.data, id: 'new-run-1' }),
      );
      mockPrisma.nodeBackupConfig.update.mockResolvedValue(makeConfig());
      const started = await service.startRun(USER_ID, NODE_ID, {
        kind: 'incremental',
        trigger: 'manual',
        cliVersion: '1.2.0',
      });
      expect(() => JSON.stringify(started)).not.toThrow();

      // getChanges (storage.size is a BigInt on the raw row)
      mockPrisma.nodeBackupRun.findUnique.mockResolvedValue(makeRun());
      mockPrisma.nodeBackupRun.update.mockResolvedValue(makeRun());
      queryService.getChanges.mockResolvedValue([makeFeedItem()]);
      const changes = await service.getChanges(USER_ID, NODE_ID, { runId: RUN_ID });
      expect(() => JSON.stringify(changes)).not.toThrow();

      // ack
      const acked = await service.ack(USER_ID, NODE_ID, {
        runId: RUN_ID,
        cursor: { updatedAt: '2026-08-02T00:00:00.000Z', id: CKPT_ID },
        stats: defaultStats,
      });
      expect(() => JSON.stringify(acked)).not.toThrow();

      // listRuns (bytesDownloaded BigInt on the raw row)
      mockPrisma.nodeBackupRun.findMany.mockResolvedValue([makeRun()]);
      const runs = await service.listRuns(USER_ID, NODE_ID);
      expect(() => JSON.stringify(runs)).not.toThrow();

      // manifest + dimensions
      const manifest = await service.getManifest(USER_ID, NODE_ID, { runId: RUN_ID });
      expect(() => JSON.stringify(manifest)).not.toThrow();
      const dims = await service.getDimensions(USER_ID, NODE_ID);
      expect(() => JSON.stringify(dims)).not.toThrow();
    });
  });
});

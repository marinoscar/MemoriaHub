/**
 * Unit tests for NodesService — result/failure ingestion (distributed workers).
 *
 * Covers:
 *  1. assertJobHeldByNode — 404 unknown job; 409 when not claimed by this
 *     node / not running / lease missing or expired; returns the job when held
 *  2. submitJobResult — type mismatch (400), non-node-persistable type (400),
 *     schema-invalid payload (400), happy path (persist → completeSucceeded),
 *     persist crash (completeFailed + 500, completeSucceeded NOT called)
 *  3. reportJobFailure — routes through EnrichmentTerminalService.completeFailed
 *     with the rateLimited/retryAfterMs opts; willRetry is advisory (ignored)
 *  4. getModelManifest — returns a BARE ARRAY (CLI contract), not { models },
 *     with exactly 5 entries, all carrying non-null sha256/bytes
 *  5. getJobUploadUrl — reuses the held-job guard (404/409); 400 when the job
 *     has no mediaItemId or linked StorageObject; happy path derives the
 *     thumbnails/<storageObjectId>.jpg key and returns the resolver's signed
 *     PUT URL
 *  6. getNode — owner-scoped single-node detail; shares deriveNodeHealth /
 *     getJobCountsForNodes with listNodes; 404/403 mirror assertJobHeldByNode
 *  7. heartbeat — persists `concurrency` onto the WorkerNode row when the node
 *     reports it (issue #105 concurrency-sync fix); leaves it untouched when
 *     omitted; ownership still enforced; claim() reads the persisted value
 *     fresh on its next call (simulated round-trip — no test DB available)
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { z } from 'zod';
import { NodesService } from './nodes.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentClaimService } from '../enrichment/enrichment-claim.service';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { EnrichmentTerminalService } from '../enrichment/enrichment-terminal.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { AiSettingsService } from '../ai/ai-settings.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { AutoTaggingService } from '../tagging/auto-tagging.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const NODE_ID = 'node-1';
const JOB_ID = 'job-1';

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: NODE_ID,
    createdById: USER_ID,
    status: 'online',
    eligibleTypes: ['duplicate_detection'],
    concurrency: 1,
    ...overrides,
  };
}

/** A job currently HELD by NODE_ID under a live lease. */
function makeHeldJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    type: 'duplicate_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    attempts: 1,
    rateLimitHits: 0,
    claimedByNodeId: NODE_ID,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    executor: 'node',
    ...overrides,
  };
}

describe('NodesService — result/failure ingestion', () => {
  let service: NodesService;
  let mockPrisma: MockPrismaService;
  let mockRegistry: { get: jest.Mock; types: jest.Mock };
  let mockTerminal: { completeSucceeded: jest.Mock; completeFailed: jest.Mock };
  let mockResolver: { getActiveProvider: jest.Mock };
  let mockActiveProvider: { getSignedPutUrl: jest.Mock; getBucket: jest.Mock };
  let mockClaimService: { claim: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };
  let mockObjects: { getDownloadUrl: jest.Mock; getInternalDownloadUrl: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockRegistry = { get: jest.fn(), types: jest.fn().mockReturnValue([]) };
    mockTerminal = {
      completeSucceeded: jest.fn().mockResolvedValue(undefined),
      completeFailed: jest.fn().mockResolvedValue(undefined),
    };
    mockActiveProvider = {
      getSignedPutUrl: jest.fn().mockResolvedValue('https://mock-presigned-url.example/put'),
      getBucket: jest.fn().mockReturnValue('test-bucket'),
    };
    mockResolver = {
      getActiveProvider: jest
        .fn()
        .mockResolvedValue({ id: 's3', provider: mockActiveProvider }),
    };
    mockClaimService = { claim: jest.fn().mockResolvedValue([]) };
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentClaimService, useValue: mockClaimService },
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: EnrichmentTerminalService, useValue: mockTerminal },
        {
          provide: ObjectsService,
          useValue: {
            getDownloadUrl: jest.fn(),
            getInternalDownloadUrl: jest.fn(),
          },
        },
        { provide: StorageProviderResolver, useValue: mockResolver },
        // getJobCredentials dependencies (auto_tagging/geocode transient
        // credentials) — not exercised by this spec file's existing coverage
        // (see nodes.service.credentials.spec.ts for that); stubbed here only
        // so NodesService's constructor resolves.
        { provide: EnrichmentJobService, useValue: { recordModel: jest.fn() } },
        { provide: AiSettingsService, useValue: { resolveCredentials: jest.fn() } },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: AutoTaggingService, useValue: { buildPrompt: jest.fn() } },
      ],
    }).compile();

    service = module.get(NodesService);
    mockObjects = module.get(ObjectsService);

    // Default: node exists and is owned by the caller.
    (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // assertJobHeldByNode
  // =========================================================================

  describe('assertJobHeldByNode', () => {
    it('returns the job when it is running, claimed by this node, under a live lease', async () => {
      const job = makeHeldJob();
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(job);

      await expect(service.assertJobHeldByNode(USER_ID, NODE_ID, JOB_ID)).resolves.toBe(job);
    });

    it('throws ForbiddenException when the node belongs to another user', async () => {
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ createdById: 'someone-else' }),
      );

      await expect(service.assertJobHeldByNode(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when the job does not exist', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.assertJobHeldByNode(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['claimed by another node', { claimedByNodeId: 'other-node' }],
      ['not running', { status: JobStatus.pending }],
      ['lease missing', { leaseExpiresAt: null }],
      ['lease expired', { leaseExpiresAt: new Date(Date.now() - 1_000) }],
    ])('throws ConflictException (409) when the job is %s', async (_label, override) => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob(override),
      );

      await expect(service.assertJobHeldByNode(USER_ID, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // =========================================================================
  // submitJobResult
  // =========================================================================

  describe('submitJobResult', () => {
    const resultSchema = z.object({ value: z.number() });

    function makeNodeHandler() {
      return {
        type: 'duplicate_detection',
        process: jest.fn(),
        nodeResultSchema: resultSchema,
        persistNodeResult: jest.fn().mockResolvedValue(undefined),
      };
    }

    beforeEach(() => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(makeHeldJob());
    });

    it('rejects with 400 when body.type does not match the job type', async () => {
      await expect(
        service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
          type: 'face_detection',
          result: { value: 1 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockRegistry.get).not.toHaveBeenCalled();
    });

    it('rejects with 400 when the handler is missing or not node-persistable', async () => {
      // No handler at all
      mockRegistry.get.mockReturnValue(undefined);
      await expect(
        service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
          type: 'duplicate_detection',
          result: { value: 1 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Handler without the optional node-result members
      mockRegistry.get.mockReturnValue({ type: 'duplicate_detection', process: jest.fn() });
      await expect(
        service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
          type: 'duplicate_detection',
          result: { value: 1 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with 400 when the payload fails the handler nodeResultSchema', async () => {
      const handler = makeNodeHandler();
      mockRegistry.get.mockReturnValue(handler);

      await expect(
        service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
          type: 'duplicate_detection',
          result: { value: 'not-a-number' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(handler.persistNodeResult).not.toHaveBeenCalled();
      expect(mockTerminal.completeSucceeded).not.toHaveBeenCalled();
      expect(mockTerminal.completeFailed).not.toHaveBeenCalled();
    });

    it('persists the parsed result and completes the job as succeeded', async () => {
      const handler = makeNodeHandler();
      mockRegistry.get.mockReturnValue(handler);

      const res = await service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
        type: 'duplicate_detection',
        result: { value: 42 },
      });

      expect(res).toEqual({ ok: true });
      expect(handler.persistNodeResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        { value: 42 },
      );
      expect(mockTerminal.completeSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
      );
      expect(mockTerminal.completeFailed).not.toHaveBeenCalled();
    });

    it('routes a persist crash through completeFailed and returns 500 (not succeeded)', async () => {
      const handler = makeNodeHandler();
      const boom = new Error('unique constraint violation');
      handler.persistNodeResult.mockRejectedValue(boom);
      mockRegistry.get.mockReturnValue(handler);

      await expect(
        service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
          type: 'duplicate_detection',
          result: { value: 42 },
        }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(mockTerminal.completeFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        boom,
      );
      expect(mockTerminal.completeSucceeded).not.toHaveBeenCalled();
    });

    it('rejects with 409 before touching the handler when the lease has expired', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ leaseExpiresAt: new Date(Date.now() - 1) }),
      );

      await expect(
        service.submitJobResult(USER_ID, NODE_ID, JOB_ID, {
          type: 'duplicate_detection',
          result: { value: 42 },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockRegistry.get).not.toHaveBeenCalled();
      expect(mockTerminal.completeSucceeded).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // reportJobFailure
  // =========================================================================

  describe('reportJobFailure', () => {
    beforeEach(() => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(makeHeldJob());
    });

    it('routes the failure through completeFailed with the error string and opts', async () => {
      const res = await service.reportJobFailure(USER_ID, NODE_ID, JOB_ID, {
        error: 'sharp exploded',
        rateLimited: false,
      });

      expect(res).toEqual({ ok: true });
      expect(mockTerminal.completeFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        'sharp exploded',
        { rateLimited: false, retryAfterMs: null },
      );
    });

    it('forwards rateLimited + retryAfterMs so the deferral path (and throttle trip) engages', async () => {
      await service.reportJobFailure(USER_ID, NODE_ID, JOB_ID, {
        error: 'provider said 429',
        rateLimited: true,
        retryAfterMs: 30_000,
      });

      expect(mockTerminal.completeFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        'provider said 429',
        { rateLimited: true, retryAfterMs: 30_000 },
      );
    });

    it('rejects with 409 for a job this node no longer holds', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ claimedByNodeId: 'other-node' }),
      );

      await expect(
        service.reportJobFailure(USER_ID, NODE_ID, JOB_ID, { error: 'late report' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockTerminal.completeFailed).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // heartbeat — concurrency persistence (issue #105 fix)
  //
  // The claim endpoint bounds every claim at `node.concurrency`
  // (`Math.min(max ?? node.concurrency, node.concurrency)`, see the `claim`
  // block below), which used to be written once at registration and never
  // updated — so a runtime `set-concurrency` (CLI) left the server capping
  // claims at the stale value forever. The fix has the CLI report its live
  // concurrency cap on every heartbeat; this persists it the same way
  // status/capabilities are already conditionally persisted.
  // =========================================================================

  describe('heartbeat', () => {
    it('persists concurrency onto the WorkerNode row when the node reports it', async () => {
      const res = await service.heartbeat(USER_ID, NODE_ID, { concurrency: 8 });

      expect(res).toEqual({ ok: true });
      expect(mockPrisma.workerNode.update).toHaveBeenCalledWith({
        where: { id: NODE_ID },
        data: expect.objectContaining({ concurrency: 8 }),
      });
    });

    it('leaves concurrency untouched when the heartbeat omits it', async () => {
      await service.heartbeat(USER_ID, NODE_ID, {});

      const call = (mockPrisma.workerNode.update as jest.Mock).mock.calls[0][0];
      expect(call.data).not.toHaveProperty('concurrency');
    });

    it('persists concurrency alongside status and capabilities when all three are reported', async () => {
      await service.heartbeat(USER_ID, NODE_ID, {
        status: 'draining' as never,
        capabilities: { ffmpeg: true },
        concurrency: 12,
      });

      expect(mockPrisma.workerNode.update).toHaveBeenCalledWith({
        where: { id: NODE_ID },
        data: expect.objectContaining({
          status: 'draining',
          capabilities: { ffmpeg: true },
          concurrency: 12,
        }),
      });
    });

    it('rejects with ForbiddenException when the node belongs to another user (ownership still enforced)', async () => {
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ createdById: 'someone-else' }),
      );

      await expect(
        service.heartbeat(USER_ID, NODE_ID, { concurrency: 5 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.workerNode.update).not.toHaveBeenCalled();
    });

    // NOTE ON THE CLAIM-BOUND SIDE EFFECT: proving that a *subsequent live
    // claim* is bounded by the newly-persisted value end-to-end would require
    // a real database round-trip (assertOwnership re-reads the row via
    // `workerNode.findUnique`, which this unit test stubs rather than backs
    // with Postgres) — no test DB is available in this offline environment
    // (see the repo's "Local DB & migrations" note). The next test simulates
    // the wiring instead: it persists a new concurrency via heartbeat, then
    // points the findUnique stub at a row reflecting that persisted value (as
    // a real DB read would after the update commits) and asserts `claim()`
    // reads `node.concurrency` fresh and bounds the claim limit to it.
    it('claim() bounds its limit to a concurrency value newly persisted by heartbeat (simulated DB round-trip)', async () => {
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValueOnce(
        makeNode({ concurrency: 2 }),
      );
      await service.heartbeat(USER_ID, NODE_ID, { concurrency: 10 });
      expect(mockPrisma.workerNode.update).toHaveBeenCalledWith({
        where: { id: NODE_ID },
        data: expect.objectContaining({ concurrency: 10 }),
      });

      // Simulate the row now reflecting the persisted value on the next read.
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ concurrency: 10 }),
      );
      mockClaimService.claim.mockResolvedValue([]);

      await service.claim(USER_ID, NODE_ID, 999, ['duplicate_detection']);

      expect(mockClaimService.claim).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
      );
    });
  });

  // =========================================================================
  // claim — per-job-type params resolution
  // =========================================================================

  describe('claim', () => {
    function claimedJob(overrides: Record<string, unknown> = {}) {
      return {
        id: JOB_ID,
        type: 'duplicate_detection',
        mediaItemId: null,
        circleId: null,
        payload: null,
        ...overrides,
      };
    }

    it('leaves params as job.payload for non-video_face_detection job types (unchanged behavior)', async () => {
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'duplicate_detection', payload: { foo: 'bar' } }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['duplicate_detection']);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].params).toEqual({ foo: 'bar' });
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    });

    it('defaults params to null when job.payload is null for a non-video job type', async () => {
      mockClaimService.claim.mockResolvedValue([claimedJob({ payload: null })]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['duplicate_detection']);

      expect(jobs[0].params).toBeNull();
    });

    it('merges fresh face.video.* settings into params for video_face_detection jobs', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        face: { video: { sampleIntervalSeconds: 7, maxFramesPerVideo: 42 } },
      });
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'video_face_detection', mediaItemId: 'media-1', payload: null }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['video_face_detection']);

      expect(jobs[0].params).toEqual({ sampleIntervalSeconds: 7, maxFramesPerVideo: 42 });
    });

    it('falls back to defaults (5, 60) when face.video settings are absent', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({});
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'video_face_detection', mediaItemId: 'media-1', payload: null }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['video_face_detection']);

      expect(jobs[0].params).toEqual({ sampleIntervalSeconds: 5, maxFramesPerVideo: 60 });
    });

    it('preserves existing job.payload fields when merging settings for video_face_detection', async () => {
      mockSystemSettings.getSettings.mockResolvedValue({
        face: { video: { sampleIntervalSeconds: 7, maxFramesPerVideo: 42 } },
      });
      mockClaimService.claim.mockResolvedValue([
        claimedJob({
          type: 'video_face_detection',
          mediaItemId: 'media-1',
          payload: { mode: 'sweep' },
        }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['video_face_detection']);

      expect(jobs[0].params).toEqual({
        mode: 'sweep',
        sampleIntervalSeconds: 7,
        maxFramesPerVideo: 42,
      });
    });

    // -----------------------------------------------------------------------
    // inputUrl resolution (resolveInputUrl)
    // -----------------------------------------------------------------------

    it('presigns via getInternalDownloadUrl for a still-processing object (regression: used to return null)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        storageObjectId: 'object-1',
      });
      // getInternalDownloadUrl deliberately skips the ready+auth checks that
      // made the old getDownloadUrl path throw (and swallow to null) while the
      // object was still status='processing'.
      mockObjects.getInternalDownloadUrl.mockResolvedValue(
        'https://mock-presigned-url.example/get',
      );
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'duplicate_detection', mediaItemId: 'media-1', payload: null }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['duplicate_detection']);

      expect(jobs[0].inputUrl).toBe('https://mock-presigned-url.example/get');
      expect(mockObjects.getInternalDownloadUrl).toHaveBeenCalledWith('object-1');
      // The user-facing, ready+auth-gated path must NOT be used for node claims.
      expect(mockObjects.getDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns null inputUrl for a global/system job with no mediaItemId', async () => {
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'duplicate_detection', mediaItemId: null, payload: null }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['duplicate_detection']);

      expect(jobs[0].inputUrl).toBeNull();
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
      expect(mockObjects.getInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns null inputUrl when the media item has no storageObjectId', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        storageObjectId: null,
      });
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'duplicate_detection', mediaItemId: 'media-1', payload: null }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['duplicate_detection']);

      expect(jobs[0].inputUrl).toBeNull();
      expect(mockObjects.getInternalDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns null inputUrl when the object row is absent (getInternalDownloadUrl → null)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        storageObjectId: 'missing-object',
      });
      mockObjects.getInternalDownloadUrl.mockResolvedValue(null);
      mockClaimService.claim.mockResolvedValue([
        claimedJob({ type: 'duplicate_detection', mediaItemId: 'media-1', payload: null }),
      ]);

      const { jobs } = await service.claim(USER_ID, NODE_ID, 1, ['duplicate_detection']);

      expect(jobs[0].inputUrl).toBeNull();
    });
  });

  // =========================================================================
  // getJobUploadUrl
  // =========================================================================

  describe('getJobUploadUrl', () => {
    it('reuses the held-job guard: 404 when the job does not exist', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reuses the held-job guard: 409 when the lease has expired', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ leaseExpiresAt: new Date(Date.now() - 1) }),
      );

      await expect(
        service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockResolver.getActiveProvider).not.toHaveBeenCalled();
    });

    it('rejects with 400 when the job has no mediaItemId', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ mediaItemId: null }),
      );

      await expect(
        service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects with 400 when the MediaItem has no linked StorageObject', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'thumbnail_regen' }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        storageObjectId: null,
      });

      await expect(
        service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('derives the thumbnails/<storageObjectId>.jpg key and returns the resolver-signed PUT URL (thumbnail_regen)', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'thumbnail_regen' }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        storageObjectId: 'original-object-id',
      });

      const res = await service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID);

      expect(res.storageKey).toBe('thumbnails/original-object-id.jpg');
      expect(res.url).toBe('https://mock-presigned-url.example/put');
      expect(res.expiresSeconds).toBeGreaterThan(0);
      expect(mockActiveProvider.getSignedPutUrl).toHaveBeenCalledWith(
        'thumbnails/original-object-id.jpg',
        expect.objectContaining({ contentType: 'image/jpeg' }),
      );
    });

    it('derives the same deterministic key for thumbnail_repair', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'thumbnail_repair' }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        storageObjectId: 'original-object-id',
      });

      const res = await service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID);

      expect(res.storageKey).toBe('thumbnails/original-object-id.jpg');
    });

    it('derives a fresh randomized video-faces/<mediaItemId>/<uuid>.jpg key for video_face_detection', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'video_face_detection', mediaItemId: 'media-1' }),
      );

      const res = await service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID);

      expect(res.storageKey).toMatch(/^video-faces\/media-1\/[0-9a-f-]+\.jpg$/);
      // No StorageObject lookup needed for this job type.
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
    });

    it('issues a distinct key on each call for video_face_detection (no reuse across calls)', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'video_face_detection', mediaItemId: 'media-1' }),
      );

      const first = await service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID);
      const second = await service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID);

      expect(first.storageKey).not.toBe(second.storageKey);
    });

    it('rejects with 400 for a job type that does not support upload-url issuance', async () => {
      (mockPrisma.enrichmentJob.findUnique as jest.Mock).mockResolvedValue(
        makeHeldJob({ type: 'duplicate_detection' }),
      );

      await expect(
        service.getJobUploadUrl(USER_ID, NODE_ID, JOB_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // =========================================================================
  // getModelManifest — CLI contract
  // =========================================================================

  describe('getModelManifest', () => {
    it('returns a bare array of entries (not { models: [...] })', () => {
      const manifest = service.getModelManifest();

      expect(Array.isArray(manifest)).toBe(true);
      expect((manifest as unknown[]).length).toBeGreaterThan(0);
      for (const entry of manifest as Array<Record<string, unknown>>) {
        expect(entry).toMatchObject({
          name: expect.any(String),
          url: expect.any(String),
          targetSubdir: expect.any(String),
        });
        expect(entry).toHaveProperty('sha256');
        expect(entry).toHaveProperty('bytes');
      }
    });

    it('returns exactly 5 entries', () => {
      const manifest = service.getModelManifest();

      expect(manifest).toHaveLength(5);
    });

    it('includes the blazeface-back.bin entry targeting the human subdir', () => {
      const manifest = service.getModelManifest();

      const entry = manifest.find((m) => m.name === 'blazeface-back.bin');
      expect(entry).toBeDefined();
      expect(entry?.targetSubdir).toBe('human');
    });

    it('targets the CLIP entry at the models root, not a nested "models" subdir', () => {
      // Regression test: ensureModels() in apps/cli/src/node/models.ts joins
      // `targetDir` (already the models ROOT, e.g. ~/.memoriahub/models) with
      // `targetSubdir`. A previous `targetSubdir: 'models'` value caused the
      // CLIP file to land one directory too deep
      // (~/.memoriahub/models/models/<name>), where neither
      // apps/cli/src/node/self-test.ts's testClip() nor
      // apps/cli/src/node/compute/duplicate-detection.ts look for it — so a
      // freshly-downloaded CLIP model was permanently invisible to the code
      // meant to consume it.
      const manifest = service.getModelManifest();

      const entry = manifest.find((m) => m.name === 'clip-vit-b32-vision-quantized.onnx');
      expect(entry).toBeDefined();
      expect(entry?.targetSubdir).toBe('');
      expect(entry?.targetSubdir).not.toBe('models');
    });

    it('has non-null sha256 (string) and bytes (number) on every entry', () => {
      const manifest = service.getModelManifest();

      for (const entry of manifest) {
        expect(entry.sha256).not.toBeNull();
        expect(typeof entry.sha256).toBe('string');
        expect(entry.bytes).not.toBeNull();
        expect(typeof entry.bytes).toBe('number');
      }
    });

    it('has the exact committed sha256/bytes for blazeface-back.json and blazeface-back.bin', () => {
      const manifest = service.getModelManifest();

      const json = manifest.find((m) => m.name === 'blazeface-back.json');
      expect(json).toMatchObject({
        sha256: 'a765f7b2a6c1d841ecc0b0686e5f51b141b39b7bcdf2888542dc9d9fc4384a87',
        bytes: 79043,
      });

      const bin = manifest.find((m) => m.name === 'blazeface-back.bin');
      expect(bin).toMatchObject({
        sha256: 'dc9a97fdc50bc43216554bdd69aa3e7b9361a519ee7bdd996a2f69a98a6f9b72',
        bytes: 538928,
      });
    });
  });

  // =========================================================================
  // getNode — owner-scoped single-node detail
  // =========================================================================

  describe('getNode', () => {
    it('returns { ...node, health, jobCounts } for a node owned by the caller', async () => {
      const node = makeNode({ lastHeartbeatAt: new Date() });
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(node);
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([
        { claimedByNodeId: NODE_ID, status: JobStatus.running, _count: { _all: 2 } },
        { claimedByNodeId: NODE_ID, status: JobStatus.succeeded, _count: { _all: 5 } },
        { claimedByNodeId: NODE_ID, status: JobStatus.failed, _count: { _all: 1 } },
      ]);

      const result = await service.getNode(USER_ID, NODE_ID);

      expect(result).toMatchObject({
        ...node,
        health: 'healthy',
        jobCounts: { running: 2, succeeded: 5, failed: 1 },
      });
    });

    it('defaults jobCounts to zeros when the node has no claimed jobs', async () => {
      const node = makeNode({ lastHeartbeatAt: new Date() });
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(node);
      (mockPrisma.enrichmentJob.groupBy as jest.Mock).mockResolvedValue([]);

      const result = await service.getNode(USER_ID, NODE_ID);

      expect(result.jobCounts).toEqual({ running: 0, succeeded: 0, failed: 0 });
    });

    it('throws NotFoundException when the node does not exist', async () => {
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getNode(USER_ID, NODE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when the node belongs to another user', async () => {
      (mockPrisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ createdById: 'someone-else' }),
      );

      await expect(service.getNode(USER_ID, NODE_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});

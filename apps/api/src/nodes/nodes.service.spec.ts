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
 *  4. getModelManifest — returns a BARE ARRAY (CLI contract), not { models }
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
import { ObjectsService } from '../storage/objects/objects.service';
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

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockRegistry = { get: jest.fn(), types: jest.fn().mockReturnValue([]) };
    mockTerminal = {
      completeSucceeded: jest.fn().mockResolvedValue(undefined),
      completeFailed: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrichmentClaimService, useValue: { claim: jest.fn() } },
        { provide: EnrichmentHandlerRegistry, useValue: mockRegistry },
        { provide: EnrichmentTerminalService, useValue: mockTerminal },
        { provide: ObjectsService, useValue: { getDownloadUrl: jest.fn() } },
      ],
    }).compile();

    service = module.get(NodesService);

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
  });
});

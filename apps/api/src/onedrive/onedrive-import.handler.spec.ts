/**
 * Unit tests for OneDriveImportHandler.
 *
 * Modeled on storage-migration.handler.spec.ts. Constructs the handler
 * directly (not via Test.createTestingModule) with hand-rolled mocks for
 * every collaborator, mirroring the established pattern in this codebase.
 *
 * Tests cover:
 *  - Happy path: downloads, uploads, calls createMedia with source:'import',
 *    marks item completed with mediaItemId, and finalizes the run when it is
 *    the last item
 *  - Cancel guard: run cancelled -> item marked skipped, no createMedia call,
 *    no throw
 *  - Idempotent: item already completed -> returns without re-importing
 *  - Dedup hit: createMedia returns {deduplicated:true, id} -> item still
 *    completed with that id
 *  - Terminal failure: attempts+1 >= MAX_ATTEMPTS -> item marked failed with
 *    lastError and rethrows
 *  - RateLimitError from the Graph client propagates untouched (item NOT
 *    marked failed)
 *  - Invalid payload -> throws descriptive error
 */

import {
  EnrichmentJob,
  JobReason,
  JobStatus,
  OneDriveImportItemStatus,
  OneDriveImportRunStatus,
} from '@prisma/client';
import { Readable } from 'stream';
import { OneDriveImportHandler } from './onedrive-import.handler';
import { RateLimitError } from '../enrichment/rate-limit.error';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-od-1',
    type: 'onedrive_import',
    mediaItemId: null,
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.backfill,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: {
      runId: 'run-1',
      itemId: 'item-1',
      remoteItemId: 'remote-item-1',
    },
    attempts: 0,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    circleId: 'circle-1',
    remoteFolderPath: null,
    recursive: false,
    status: OneDriveImportRunStatus.running,
    totalCount: 1,
    startedAt: new Date(),
    finishedAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    runId: 'run-1',
    remoteItemId: 'remote-item-1',
    remotePath: '/Photos/img.jpg',
    remoteName: 'img.jpg',
    remoteSize: BigInt(1024),
    status: OneDriveImportItemStatus.pending,
    mediaItemId: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAuthenticatedUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    isActive: true,
    userRoles: [
      {
        role: {
          id: 'role-1',
          name: 'contributor',
          rolePermissions: [
            { permission: { name: 'media:write' } },
            { permission: { name: 'media:read' } },
          ],
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OneDriveImportHandler', () => {
  let handler: OneDriveImportHandler;
  let mockRegistry: { register: jest.Mock };
  let mockPrisma: MockPrismaService;
  let mockAuthService: { validateJwtPayload: jest.Mock };
  let mockConnectionService: { getFreshAccessToken: jest.Mock };
  let mockGraphClient: { downloadContent: jest.Mock };
  let mockObjectsService: { createObjectFromStream: jest.Mock };
  let mockMediaService: { createMedia: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockPrisma = createMockPrismaService();
    mockAuthService = {
      validateJwtPayload: jest.fn().mockResolvedValue(makeAuthenticatedUser()),
    };
    mockConnectionService = {
      getFreshAccessToken: jest.fn().mockResolvedValue('fresh-access-token'),
    };
    mockGraphClient = {
      downloadContent: jest.fn().mockResolvedValue(Readable.from(Buffer.from('file-bytes'))),
    };
    mockObjectsService = {
      createObjectFromStream: jest.fn().mockResolvedValue({ id: 'storage-obj-1' }),
    };
    mockMediaService = {
      createMedia: jest.fn().mockResolvedValue({ id: 'media-item-1', deduplicated: false }),
    };

    handler = new OneDriveImportHandler(
      mockRegistry as any,
      mockPrisma as any,
      mockAuthService as any,
      mockConnectionService as any,
      mockGraphClient as any,
      mockObjectsService as any,
      mockMediaService as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // type / onModuleInit
  // =========================================================================

  describe('type / onModuleInit', () => {
    it('has type === "onedrive_import"', () => {
      expect(handler.type).toBe('onedrive_import');
    });

    it('registers itself with the EnrichmentHandlerRegistry', () => {
      handler.onModuleInit();

      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });
  });

  // =========================================================================
  // process() — invalid payload
  // =========================================================================

  describe('process() — invalid payload', () => {
    it('throws a descriptive error when payload is null', async () => {
      const job = makeJob({ payload: null });

      await expect(handler.process(job)).rejects.toThrow(/invalid payload/i);
    });

    it('throws a descriptive error when runId is missing', async () => {
      const job = makeJob({ payload: { itemId: 'item-1' } as any });

      await expect(handler.process(job)).rejects.toThrow(/invalid payload/i);
    });

    it('throws a descriptive error when itemId is missing', async () => {
      const job = makeJob({ payload: { runId: 'run-1' } as any });

      await expect(handler.process(job)).rejects.toThrow(/invalid payload/i);
    });
  });

  // =========================================================================
  // process() — item not found
  // =========================================================================

  describe('process() — item not found', () => {
    it('returns without throwing when the item row does not exist', async () => {
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
      expect(mockConnectionService.getFreshAccessToken).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process() — idempotent: item already completed
  // =========================================================================

  describe('process() — idempotent: item already completed', () => {
    it('returns immediately without downloading, uploading, or calling createMedia', async () => {
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(
        makeItem({ status: OneDriveImportItemStatus.completed, mediaItemId: 'media-item-1' }),
      );

      await handler.process(makeJob());

      expect(mockConnectionService.getFreshAccessToken).not.toHaveBeenCalled();
      expect(mockGraphClient.downloadContent).not.toHaveBeenCalled();
      expect(mockObjectsService.createObjectFromStream).not.toHaveBeenCalled();
      expect(mockMediaService.createMedia).not.toHaveBeenCalled();
      // The run should never even be loaded for an already-completed item.
      expect(mockPrisma.oneDriveImportRun.findUnique).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process() — run not found
  // =========================================================================

  describe('process() — run not found', () => {
    it('returns without throwing when the run row does not exist', async () => {
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
      expect(mockConnectionService.getFreshAccessToken).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process() — cancel guard
  // =========================================================================

  describe('process() — cancel guard', () => {
    it('marks the item skipped, does not call createMedia, and does not throw', async () => {
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeRun({ status: OneDriveImportRunStatus.cancelled }))
        // maybeFinalizeRun's own lookup — already-terminal (cancelled) => early return.
        .mockResolvedValueOnce(makeRun({ status: OneDriveImportRunStatus.cancelled }));
      (mockPrisma.oneDriveImportItem.update as jest.Mock).mockResolvedValue({});

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(mockPrisma.oneDriveImportItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-1' },
          data: { status: OneDriveImportItemStatus.skipped },
        }),
      );
      expect(mockMediaService.createMedia).not.toHaveBeenCalled();
      expect(mockConnectionService.getFreshAccessToken).not.toHaveBeenCalled();
      // The run must not be flipped to running/completed by the cancel path.
      expect(mockPrisma.oneDriveImportRun.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // process() — happy path
  // =========================================================================

  describe('process() — happy path', () => {
    beforeEach(() => {
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.pending, totalCount: 1 }),
      );
      (mockPrisma.oneDriveImportItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue({});
      // maybeFinalizeRun: all 1 item terminal (completed) -> run finalizes.
      (mockPrisma.oneDriveImportItem.groupBy as jest.Mock).mockResolvedValue([
        { status: OneDriveImportItemStatus.completed, _count: 1 },
      ]);
    });

    it('downloads from OneDrive and uploads via ObjectsService.createObjectFromStream', async () => {
      await handler.process(makeJob());

      expect(mockConnectionService.getFreshAccessToken).toHaveBeenCalledWith('user-1');
      expect(mockGraphClient.downloadContent).toHaveBeenCalledWith('fresh-access-token', 'remote-item-1');
      expect(mockObjectsService.createObjectFromStream).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: 'image/jpeg',
          originalName: 'img.jpg',
          uploadedById: 'user-1',
          auditUploadType: 'onedrive_import',
        }),
      );
    });

    it('calls createMedia with source:"import" and the expected provenance fields', async () => {
      await handler.process(makeJob());

      expect(mockMediaService.createMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          storageObjectId: 'storage-obj-1',
          type: 'photo',
          source: 'import',
          sourcePath: '/Photos/img.jpg',
          sourceDeviceName: 'OneDrive',
          originalFilename: 'img.jpg',
          circleId: 'circle-1',
          contentHash: expect.any(String),
        }),
        'user-1',
        expect.arrayContaining(['media:write', 'media:read']),
      );
    });

    it('marks the item completed with mediaItemId set', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.oneDriveImportItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-1' },
          data: { status: OneDriveImportItemStatus.completed, mediaItemId: 'media-item-1' },
        }),
      );
    });

    it('finalizes the run as completed when this was the last item', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.oneDriveImportRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({ status: OneDriveImportRunStatus.completed }),
        }),
      );
    });

    it('flips a pending run to running before processing', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.oneDriveImportRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({ status: OneDriveImportRunStatus.running }),
        }),
      );
    });
  });

  // =========================================================================
  // process() — dedup hit
  // =========================================================================

  describe('process() — dedup hit', () => {
    it('marks the item completed with the EXISTING MediaItem id when createMedia reports deduplicated:true', async () => {
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.running, totalCount: 1 }),
      );
      (mockPrisma.oneDriveImportItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.oneDriveImportItem.groupBy as jest.Mock).mockResolvedValue([
        { status: OneDriveImportItemStatus.completed, _count: 1 },
      ]);
      mockMediaService.createMedia.mockResolvedValue({
        id: 'pre-existing-media-item',
        deduplicated: true,
      });

      await handler.process(makeJob());

      expect(mockPrisma.oneDriveImportItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: OneDriveImportItemStatus.completed,
            mediaItemId: 'pre-existing-media-item',
          },
        }),
      );
    });
  });

  // =========================================================================
  // process() — terminal failure
  // =========================================================================

  describe('process() — terminal failure', () => {
    it('marks the item failed with lastError and rethrows when attempts+1 >= MAX_ATTEMPTS', async () => {
      const failure = new Error('OneDrive download failed: connection reset');
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.running, totalCount: 1 }),
      );
      (mockPrisma.oneDriveImportItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.oneDriveImportItem.groupBy as jest.Mock).mockResolvedValue([
        { status: OneDriveImportItemStatus.failed, _count: 1 },
      ]);
      mockGraphClient.downloadContent.mockRejectedValue(failure);

      // ENRICHMENT_MAX_ATTEMPTS defaults to 3: attempts=2 => 2+1 >= 3 => terminal.
      const terminalJob = makeJob({ attempts: 2 });

      await expect(handler.process(terminalJob)).rejects.toThrow(
        'OneDrive download failed: connection reset',
      );

      expect(mockPrisma.oneDriveImportItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-1' },
          data: {
            status: OneDriveImportItemStatus.failed,
            lastError: 'OneDrive download failed: connection reset',
          },
        }),
      );
      expect(mockPrisma.oneDriveImportRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: { lastError: 'OneDrive download failed: connection reset' },
        }),
      );
      // No MediaItem should have been created on a failed import.
      expect(mockMediaService.createMedia).not.toHaveBeenCalled();
    });

    it('does NOT mark the item failed on a non-terminal attempt (still rethrows for the worker to retry)', async () => {
      const failure = new Error('transient network error');
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.running, totalCount: 1 }),
      );
      (mockPrisma.oneDriveImportItem.update as jest.Mock).mockResolvedValue({});
      mockGraphClient.downloadContent.mockRejectedValue(failure);

      const nonTerminalJob = makeJob({ attempts: 0 });

      await expect(handler.process(nonTerminalJob)).rejects.toThrow('transient network error');

      // Only the "mark running" update should have happened — never a "failed" update.
      const failedUpdateCalls = (mockPrisma.oneDriveImportItem.update as jest.Mock).mock.calls.filter(
        (args: any[]) => args[0]?.data?.status === OneDriveImportItemStatus.failed,
      );
      expect(failedUpdateCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // process() — RateLimitError propagation
  // =========================================================================

  describe('process() — RateLimitError propagation', () => {
    it('rethrows RateLimitError untouched and does NOT mark the item failed, even on a terminal attempt', async () => {
      const rateLimitError = new RateLimitError('Microsoft Graph returned HTTP 429', 30_000, 'onedrive');
      (mockPrisma.oneDriveImportItem.findUnique as jest.Mock).mockResolvedValue(makeItem());
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.running, totalCount: 1 }),
      );
      (mockPrisma.oneDriveImportItem.update as jest.Mock).mockResolvedValue({});
      mockConnectionService.getFreshAccessToken.mockRejectedValue(rateLimitError);

      // Even on what would otherwise be a terminal attempt, RateLimitError must
      // bypass the attempts-based failure path entirely.
      const terminalJob = makeJob({ attempts: 2 });

      await expect(handler.process(terminalJob)).rejects.toBeInstanceOf(RateLimitError);

      const failedUpdateCalls = (mockPrisma.oneDriveImportItem.update as jest.Mock).mock.calls.filter(
        (args: any[]) => args[0]?.data?.status === OneDriveImportItemStatus.failed,
      );
      expect(failedUpdateCalls).toHaveLength(0);
      expect(mockPrisma.oneDriveImportRun.update).not.toHaveBeenCalled();
    });
  });
});

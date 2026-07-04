/**
 * Unit tests for OneDriveImportService.
 *
 * Tests cover:
 *  - startImport(): throws 400 when features.oneDriveImport is disabled;
 *    throws 403 when the caller lacks collaborator on the circle; throws 409
 *    when an active run already exists; happy path creates the run + items
 *    and enqueues one onedrive_import job per item with skipDedup:true; the
 *    zero-eligible-items short-circuit completes the run immediately without
 *    enqueueing anything
 *  - getRun(): recomputes per-status counts from item rows; 404 for another
 *    user's run
 *  - cancelRun(): sets cancelled for pending/running; 404 for another user's
 *    run; no-ops (returns as-is) for an already-terminal run
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OneDriveImportItemStatus, OneDriveImportRunStatus } from '@prisma/client';
import {
  OneDriveImportService,
  ONEDRIVE_IMPORT_JOB_TYPE,
} from './onedrive-import.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MicrosoftGraphClient } from './microsoft-graph.client';
import { OneDriveConnectionService } from './onedrive-connection.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const CIRCLE_ID = 'circle-1';

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: USER_ID,
    circleId: CIRCLE_ID,
    remoteFolderPath: null,
    recursive: false,
    status: OneDriveImportRunStatus.pending,
    totalCount: 2,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDriveItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'remote-1',
    name: 'photo.jpg',
    path: '/Photos/photo.jpg',
    size: 1024,
    isFolder: false,
    mimeType: 'image/jpeg',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OneDriveImportService', () => {
  let service: OneDriveImportService;
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: { isFeatureEnabled: jest.Mock };
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockConnectionService: { getFreshAccessToken: jest.Mock };
  let mockGraphClient: { listChildren: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockSystemSettings = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };
    mockCircleMembershipService = { assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }) };
    mockConnectionService = { getFreshAccessToken: jest.fn().mockResolvedValue('fresh-access-token') };
    mockGraphClient = { listChildren: jest.fn().mockResolvedValue([]) };
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    // $transaction: interactive-transaction style used by startImport.
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(mockPrisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OneDriveImportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: OneDriveConnectionService, useValue: mockConnectionService },
        { provide: MicrosoftGraphClient, useValue: mockGraphClient },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
      ],
    }).compile();

    service = module.get<OneDriveImportService>(OneDriveImportService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // startImport — guards
  // =========================================================================

  describe('startImport — guards', () => {
    it('throws BadRequestException when features.oneDriveImport is disabled', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(false);

      await expect(
        service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID }),
      ).rejects.toThrow(BadRequestException);

      // Should fail closed before ever touching circle membership or the DB.
      expect(mockCircleMembershipService.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('throws 403 (propagated ForbiddenException) when the caller lacks collaborator on the circle', async () => {
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('This action requires collaborator role or higher'),
      );

      await expect(
        service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID }),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.oneDriveImportRun.findFirst).not.toHaveBeenCalled();
    });

    it('throws ConflictException (409) when the caller already has an active (pending/running) run', async () => {
      (mockPrisma.oneDriveImportRun.findFirst as jest.Mock).mockResolvedValue(makeRun());

      await expect(
        service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID }),
      ).rejects.toThrow(ConflictException);

      expect(mockConnectionService.getFreshAccessToken).not.toHaveBeenCalled();
    });

    it('queries for an active run scoped to pending/running statuses only', async () => {
      (mockPrisma.oneDriveImportRun.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.oneDriveImportItem.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.oneDriveImportRun.create as jest.Mock).mockResolvedValue(makeRun({ totalCount: 0 }));
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue(makeRun({ totalCount: 0 }));

      await service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID });

      const findFirstArgs = (mockPrisma.oneDriveImportRun.findFirst as jest.Mock).mock.calls[0][0];
      expect(findFirstArgs.where.userId).toBe(USER_ID);
      expect(findFirstArgs.where.status.in).toEqual(
        expect.arrayContaining([OneDriveImportRunStatus.pending, OneDriveImportRunStatus.running]),
      );
    });
  });

  // =========================================================================
  // startImport — happy path
  // =========================================================================

  describe('startImport — happy path', () => {
    beforeEach(() => {
      (mockPrisma.oneDriveImportRun.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.oneDriveImportRun.create as jest.Mock).mockResolvedValue(makeRun());
      (mockPrisma.oneDriveImportItem.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      (mockPrisma.oneDriveImportItem.findMany as jest.Mock).mockResolvedValue([
        { id: 'item-1' },
        { id: 'item-2' },
      ]);
      mockGraphClient.listChildren.mockResolvedValue([
        makeDriveItem({ id: 'remote-1', name: 'a.jpg', path: '/a.jpg' }),
        makeDriveItem({ id: 'remote-2', name: 'b.png', path: '/b.png', mimeType: 'image/png' }),
      ]);
    });

    it('creates the run and item rows, then returns { runId, totalCount }', async () => {
      const result = await service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID });

      expect(mockPrisma.oneDriveImportRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER_ID,
            circleId: CIRCLE_ID,
            status: OneDriveImportRunStatus.pending,
            totalCount: 2,
          }),
        }),
      );
      expect(mockPrisma.oneDriveImportItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ runId: 'run-1', remoteItemId: 'remote-1' }),
            expect.objectContaining({ runId: 'run-1', remoteItemId: 'remote-2' }),
          ]),
        }),
      );
      expect(result).toEqual({ runId: 'run-1', totalCount: 2 });
    });

    it('enqueues exactly one onedrive_import job per created item with skipDedup:true', async () => {
      await service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID });

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(2);
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: ONEDRIVE_IMPORT_JOB_TYPE,
        circleId: CIRCLE_ID,
        mediaItemId: null,
        reason: 'backfill',
        priority: 0,
        payload: { runId: 'run-1', itemId: 'item-1' },
        skipDedup: true,
      });
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: ONEDRIVE_IMPORT_JOB_TYPE,
        circleId: CIRCLE_ID,
        mediaItemId: null,
        reason: 'backfill',
        priority: 0,
        payload: { runId: 'run-1', itemId: 'item-2' },
        skipDedup: true,
      });
    });

    it('propagates BadRequestException from getFreshAccessToken as "no connection" / "reconnect"', async () => {
      class FakeNotConnected extends Error {}
      const { OneDriveNotConnectedError } = await import('./onedrive.errors');
      mockConnectionService.getFreshAccessToken.mockRejectedValue(new OneDriveNotConnectedError());

      await expect(
        service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID }),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.oneDriveImportRun.create).not.toHaveBeenCalled();
    });
  });

  describe('startImport — zero eligible items', () => {
    it('short-circuits: marks the run completed immediately and enqueues nothing', async () => {
      (mockPrisma.oneDriveImportRun.findFirst as jest.Mock).mockResolvedValue(null);
      mockGraphClient.listChildren.mockResolvedValue([]); // nothing eligible
      (mockPrisma.oneDriveImportRun.create as jest.Mock).mockResolvedValue(makeRun({ totalCount: 0 }));
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue(
        makeRun({ totalCount: 0, status: OneDriveImportRunStatus.completed }),
      );

      const result = await service.startImport(USER_ID, ['media:write'], { circleId: CIRCLE_ID });

      expect(result).toEqual({ runId: 'run-1', totalCount: 0 });
      expect(mockPrisma.oneDriveImportRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({ status: OneDriveImportRunStatus.completed }),
        }),
      );
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getRun
  // =========================================================================

  describe('getRun', () => {
    it('recomputes per-status counts from item rows', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(makeRun());
      (mockPrisma.oneDriveImportItem.groupBy as jest.Mock).mockResolvedValue([
        { status: OneDriveImportItemStatus.completed, _count: 1 },
        { status: OneDriveImportItemStatus.failed, _count: 1 },
      ]);

      const result = await service.getRun(USER_ID, 'run-1');

      expect(result.importedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.pendingCount).toBe(0);
      expect(result.runningCount).toBe(0);
    });

    it('throws NotFoundException for another user\'s run', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ userId: 'someone-else' }),
      );

      await expect(service.getRun(USER_ID, 'run-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the run does not exist', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getRun(USER_ID, 'missing-run')).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // cancelRun
  // =========================================================================

  describe('cancelRun', () => {
    it('cancels a pending run', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.pending }),
      );
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.cancelled }),
      );
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      const result = await service.cancelRun(USER_ID, 'run-1');

      expect(mockPrisma.oneDriveImportRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({ status: OneDriveImportRunStatus.cancelled }),
        }),
      );
      expect(result.status).toBe(OneDriveImportRunStatus.cancelled);
    });

    it('cancels a running run', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.running }),
      );
      (mockPrisma.oneDriveImportRun.update as jest.Mock).mockResolvedValue(
        makeRun({ status: OneDriveImportRunStatus.cancelled }),
      );
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);

      await service.cancelRun(USER_ID, 'run-1');

      expect(mockPrisma.oneDriveImportRun.update).toHaveBeenCalled();
    });

    it('is a no-op (returns as-is, no update) for an already-terminal run', async () => {
      const terminalRun = makeRun({ status: OneDriveImportRunStatus.completed });
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(terminalRun);

      const result = await service.cancelRun(USER_ID, 'run-1');

      expect(mockPrisma.oneDriveImportRun.update).not.toHaveBeenCalled();
      expect(result).toEqual(terminalRun);
    });

    it('throws NotFoundException for another user\'s run', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(
        makeRun({ userId: 'someone-else' }),
      );

      await expect(service.cancelRun(USER_ID, 'run-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the run does not exist', async () => {
      (mockPrisma.oneDriveImportRun.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.cancelRun(USER_ID, 'missing-run')).rejects.toThrow(NotFoundException);
    });
  });
});

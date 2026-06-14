import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageObjectStatus } from '@prisma/client';
import { BackupService } from './backup.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import { LocalDiskStorageProvider } from '../../storage/providers/local/local-disk.provider';
import { TriggerBackupDto } from './dto/trigger-backup.dto';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';

describe('BackupService', () => {
  let service: BackupService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: {
    download: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
    upload: jest.Mock;
    exists: jest.Mock;
    delete: jest.Mock;
    getMetadata: jest.Mock;
    setMetadata: jest.Mock;
    getBucket: jest.Mock;
    initMultipartUpload: jest.Mock;
    getSignedUploadUrl: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let mockLocalDiskProvider: {
    upload: jest.Mock;
    download: jest.Mock;
    exists: jest.Mock;
    delete: jest.Mock;
    getMetadata: jest.Mock;
    setMetadata: jest.Mock;
    getBucket: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
    initMultipartUpload: jest.Mock;
    getSignedUploadUrl: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let tmpDir: string;

  const TEST_USER_ID = 'user-abc-123';

  const makeMediaItem = (overrides: Partial<{
    id: string;
    circleId: string;
    originalFilename: string | null;
    type: string;
    capturedAt: Date | null;
    deletedAt: Date | null;
    storageObject: {
      storageKey: string;
      storageProvider: string;
      size: bigint;
      mimeType: string;
    } | null;
  }> = {}) => ({
    id: 'media-item-1',
    circleId: 'circle-1',
    originalFilename: 'photo.jpg',
    type: 'image',
    capturedAt: new Date('2024-01-01'),
    deletedAt: null,
    storageObject: {
      storageKey: 'photos/circle-1/photo.jpg',
      storageProvider: 's3',
      size: BigInt(1024),
      mimeType: 'image/jpeg',
    },
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-svc-test-'));

    mockPrisma = createMockPrismaService();

    mockStorageProvider = {
      download: jest.fn().mockResolvedValue(Readable.from(['test content'])),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://example.com/signed-url'),
      upload: jest.fn().mockResolvedValue({ key: 'key', bucket: 'bucket', location: '/tmp/key' }),
      exists: jest.fn().mockResolvedValue(false),
      delete: jest.fn().mockResolvedValue(undefined),
      getMetadata: jest.fn().mockResolvedValue(null),
      setMetadata: jest.fn().mockResolvedValue(undefined),
      getBucket: jest.fn().mockReturnValue('test-bucket'),
      initMultipartUpload: jest.fn(),
      getSignedUploadUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
    };

    mockLocalDiskProvider = {
      upload: jest.fn().mockResolvedValue({ key: 'key', bucket: 'local-backup', location: tmpDir }),
      download: jest.fn().mockResolvedValue(Readable.from(['local content'])),
      exists: jest.fn().mockResolvedValue(false),
      delete: jest.fn().mockResolvedValue(undefined),
      getMetadata: jest.fn().mockResolvedValue(null),
      setMetadata: jest.fn().mockResolvedValue(undefined),
      getBucket: jest.fn().mockReturnValue('local-backup'),
      getSignedDownloadUrl: jest.fn().mockResolvedValue(`file://${tmpDir}/key`),
      initMultipartUpload: jest.fn(),
      getSignedUploadUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string, def?: unknown) => {
        if (key === 'storage.backup.localPath') return tmpDir;
        return def;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: LocalDiskStorageProvider, useValue: mockLocalDiskProvider },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('runBackup()', () => {
    it('calls findMany with no circleId filter when dto.all is true', async () => {
      const dto: TriggerBackupDto = { all: true };
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.runBackup(dto, TEST_USER_ID);

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ circleId: expect.anything() }),
        }),
      );
    });

    it('calls findMany with circleId when dto.circleId is provided', async () => {
      const dto: TriggerBackupDto = { circleId: 'circle-1' };
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.runBackup(dto, TEST_USER_ID);

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ circleId: 'circle-1' }),
        }),
      );
    });

    it('creates two audit events (start + complete)', async () => {
      const dto: TriggerBackupDto = { all: true };
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);

      await service.runBackup(dto, TEST_USER_ID);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledTimes(2);

      const firstCall = mockPrisma.auditEvent.create.mock.calls[0][0];
      expect(firstCall.data.action).toBe('backup.start');
      expect(firstCall.data.targetType).toBe('backup_run');
      expect(firstCall.data.actorUserId).toBe(TEST_USER_ID);

      const secondCall = mockPrisma.auditEvent.create.mock.calls[1][0];
      expect(secondCall.data.action).toBe('backup.complete');
      expect(secondCall.data.targetType).toBe('backup_run');
      expect(secondCall.data.actorUserId).toBe(TEST_USER_ID);
    });

    it('returns { runId, scope, copied, skipped, failed }', async () => {
      const dto: TriggerBackupDto = { all: true };
      mockPrisma.mediaItem.findMany.mockResolvedValue([makeMediaItem()] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.runBackup(dto, TEST_USER_ID);

      expect(result).toHaveProperty('runId');
      expect(typeof result.runId).toBe('string');
      expect(result).toHaveProperty('scope', 'all');
      expect(result).toHaveProperty('copied');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('errors');
    });

    it('increments copied for each successfully processed item', async () => {
      const dto: TriggerBackupDto = { all: true };
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ id: 'item-1', storageObject: { storageKey: 'key1', storageProvider: 's3', size: BigInt(100), mimeType: 'image/jpeg' } }),
        makeMediaItem({ id: 'item-2', storageObject: { storageKey: 'key2', storageProvider: 's3', size: BigInt(200), mimeType: 'image/jpeg' } }),
      ] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.runBackup(dto, TEST_USER_ID);

      expect(result.copied).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('skips items with no storageObject (increments skipped, not failed)', async () => {
      const dto: TriggerBackupDto = { all: true };
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ id: 'item-no-storage', storageObject: null }),
        makeMediaItem({ id: 'item-with-storage' }),
      ] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.runBackup(dto, TEST_USER_ID);

      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.copied).toBe(1);
    });

    it('catches per-item download failures; increments failed; other items continue', async () => {
      const dto: TriggerBackupDto = { all: true };
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ id: 'item-fail', storageObject: { storageKey: 'bad-key', storageProvider: 's3', size: BigInt(100), mimeType: 'image/jpeg' } }),
        makeMediaItem({ id: 'item-ok', storageObject: { storageKey: 'good-key', storageProvider: 's3', size: BigInt(200), mimeType: 'image/jpeg' } }),
      ] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      mockStorageProvider.download
        .mockRejectedValueOnce(new Error('download failed'))
        .mockResolvedValueOnce(Readable.from(['ok content']));

      const result = await service.runBackup(dto, TEST_USER_ID);

      expect(result.failed).toBe(1);
      expect(result.copied).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('item-fail');
    });

    it('records error messages in errors[] for failed items', async () => {
      const dto: TriggerBackupDto = { all: true };
      const errorMessage = 'S3 connection refused';
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ id: 'failing-item' }),
      ] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      mockStorageProvider.download.mockRejectedValue(new Error(errorMessage));

      const result = await service.runBackup(dto, TEST_USER_ID);

      expect(result.errors[0]).toContain(errorMessage);
    });

    it('scope is the circleId when circleId provided, else "all"', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result1 = await service.runBackup({ circleId: 'circle-42' }, TEST_USER_ID);
      expect(result1.scope).toBe('circle-42');

      const result2 = await service.runBackup({ all: true }, TEST_USER_ID);
      expect(result2.scope).toBe('all');
    });

    it('run IDs differ between runs', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const r1 = await service.runBackup({ all: true }, TEST_USER_ID);
      const r2 = await service.runBackup({ all: true }, TEST_USER_ID);

      expect(r1.runId).not.toBe(r2.runId);
    });
  });

  describe('getRecentRuns()', () => {
    it('calls auditEvent.findMany with targetType=backup_run and action=backup.complete', async () => {
      mockPrisma.auditEvent.findMany.mockResolvedValue([]);

      await service.getRecentRuns();

      expect(mockPrisma.auditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            targetType: 'backup_run',
            action: 'backup.complete',
          },
        }),
      );
    });

    it('returns mapped run records from audit events', async () => {
      const fakeEvent = {
        id: 'evt-1',
        targetId: 'run-id-1',
        meta: {
          scope: 'all',
          circleId: null,
          startedAt: '2024-01-01T00:00:00.000Z',
          finishedAt: '2024-01-01T01:00:00.000Z',
          copied: 5,
          skipped: 1,
          failed: 0,
          errors: [],
        },
        createdAt: new Date('2024-01-01T01:00:00.000Z'),
        actorUserId: TEST_USER_ID,
      };
      mockPrisma.auditEvent.findMany.mockResolvedValue([fakeEvent as any]);

      const result = await service.getRecentRuns();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        runId: 'run-id-1',
        scope: 'all',
        copied: 5,
        skipped: 1,
        failed: 0,
      });
    });

    it('defaults limit to 20', async () => {
      mockPrisma.auditEvent.findMany.mockResolvedValue([]);

      await service.getRecentRuns();

      expect(mockPrisma.auditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });

    it('respects custom limit', async () => {
      mockPrisma.auditEvent.findMany.mockResolvedValue([]);

      await service.getRecentRuns(5);

      expect(mockPrisma.auditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });
  });

  describe('listObjects()', () => {
    it('calls mediaItem.findMany and getSignedDownloadUrl for each item', async () => {
      const item = makeMediaItem();
      mockPrisma.mediaItem.findMany.mockResolvedValue([item] as any);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://example.com/signed');

      const result = await service.listObjects();

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalled();
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        item.storageObject!.storageKey,
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        mediaItemId: item.id,
        storageKey: item.storageObject!.storageKey,
        downloadUrl: 'https://example.com/signed',
        mimeType: item.storageObject!.mimeType,
      });
    });

    it('filters by circleId when provided', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);

      await service.listObjects('circle-99');

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ circleId: 'circle-99' }),
        }),
      );
    });

    it('does not include circleId filter when not provided', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([] as any);

      await service.listObjects();

      const callArg = mockPrisma.mediaItem.findMany.mock.calls[0]?.[0];
      expect(callArg?.where).not.toHaveProperty('circleId');
    });

    it('excludes items with no storageObject', async () => {
      mockPrisma.mediaItem.findMany.mockResolvedValue([
        makeMediaItem({ storageObject: null }),
        makeMediaItem({ id: 'item-2' }),
      ] as any);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://example.com/signed');

      const result = await service.listObjects();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].mediaItemId).toBe('item-2');
    });
  });

  describe('getRunStatus()', () => {
    it('returns completed when both start and complete events exist', async () => {
      const runId = 'run-xyz';
      mockPrisma.auditEvent.findMany.mockResolvedValue([
        { id: 'e1', action: 'backup.start', meta: {}, createdAt: new Date() },
        { id: 'e2', action: 'backup.complete', meta: {}, createdAt: new Date() },
      ] as any);

      const result = await service.getRunStatus(runId);

      expect(result.runId).toBe(runId);
      expect(result.status).toBe('completed');
      expect(result.startEvent).toBeDefined();
      expect(result.completeEvent).toBeDefined();
    });

    it('returns started when only start event exists', async () => {
      mockPrisma.auditEvent.findMany.mockResolvedValue([
        { id: 'e1', action: 'backup.start', meta: {}, createdAt: new Date() },
      ] as any);

      const result = await service.getRunStatus('run-in-progress');

      expect(result.status).toBe('started');
      expect(result.completeEvent).toBeUndefined();
    });

    it('returns unknown when no events exist for runId', async () => {
      mockPrisma.auditEvent.findMany.mockResolvedValue([]);

      const result = await service.getRunStatus('nonexistent-run');

      expect(result.status).toBe('unknown');
      expect(result.startEvent).toBeUndefined();
      expect(result.completeEvent).toBeUndefined();
    });
  });
});

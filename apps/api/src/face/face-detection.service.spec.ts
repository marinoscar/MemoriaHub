/**
 * Unit tests for FaceDetectionService.
 *
 * Tests bounding-box normalization, L2 embedding normalization, face creation,
 * status upserts, markFailed paths, and provider-not-configured error.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { FaceDetectionService } from './face-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { FaceJob, FaceJobReason, FaceJobStatus, MediaFaceStatusType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<FaceJob> = {}): FaceJob {
  return {
    id: 'job-1',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: FaceJobStatus.running,
    reason: FaceJobReason.upload,
    providerKey: null,
    modelVersion: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  width: number | null;
  height: number | null;
  storageObject: { storageKey: string } | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    width: 500,
    height: 400,
    storageObject: { storageKey: 'storage/key.jpg' },
    ...overrides,
  };
}

function makeReadable(content: Buffer = Buffer.from('fake-image')): Readable {
  return Readable.from([content]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceDetectionService', () => {
  let service: FaceDetectionService;
  let mockPrisma: MockPrismaService;
  let mockFaceSettingsService: {
    resolveCredentials: jest.Mock;
  };
  let mockRegistry: { get: jest.Mock };
  let mockProvider: { detect: jest.Mock };
  let mockStorageProvider: { download: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockProvider = { detect: jest.fn() };
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockFaceSettingsService = { resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'test-key' }) };
    mockStorageProvider = { download: jest.fn().mockResolvedValue(makeReadable()) };

    // Default system settings: face detection configured
    (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      key: 'global',
      value: {
        face: {
          features: {
            detection: { provider: 'compreface', model: 'arcface-r100-v1' },
          },
        },
      },
    });

    // Default media item
    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

    // Default upserts and mutations succeed silently
    (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.face.createMany as jest.Mock).mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FaceSettingsService, useValue: mockFaceSettingsService },
        { provide: FaceProviderRegistry, useValue: mockRegistry },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
      ],
    }).compile();

    service = module.get<FaceDetectionService>(FaceDetectionService);
  });

  // -------------------------------------------------------------------------
  // Status → processing (initial upsert)
  // -------------------------------------------------------------------------

  describe('initial status upsert', () => {
    it('upserts MediaFaceStatus to processing at the start', async () => {
      mockProvider.detect.mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      const firstUpsert = (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mock.calls[0][0];
      expect(firstUpsert.create.status).toBe(MediaFaceStatusType.processing);
      expect(firstUpsert.update.status).toBe(MediaFaceStatusType.processing);
    });
  });

  // -------------------------------------------------------------------------
  // Bounding-box normalization
  // -------------------------------------------------------------------------

  describe('bounding box normalization', () => {
    it('converts pixel coords to fractions when any coord > 1.0', async () => {
      // width=500, height=400 → x:100/500=0.2, y:200/400=0.5, w:50/500=0.1, h:80/400=0.2
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 100, y: 200, w: 50, h: 80 },
          confidence: 0.95,
          embedding: [],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      await service.processMediaItem(makeJob());

      const createManyCall = (mockPrisma.face.createMany as jest.Mock).mock.calls[0][0];
      const storedBb = createManyCall.data[0].boundingBox;
      expect(storedBb.x).toBeCloseTo(0.2, 5);
      expect(storedBb.y).toBeCloseTo(0.5, 5);
      expect(storedBb.w).toBeCloseTo(0.1, 5);
      expect(storedBb.h).toBeCloseTo(0.2, 5);
    });

    it('passes through fractional coords unchanged when all coords <= 1.0', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
          confidence: 0.88,
          embedding: [],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      await service.processMediaItem(makeJob());

      const createManyCall = (mockPrisma.face.createMany as jest.Mock).mock.calls[0][0];
      const storedBb = createManyCall.data[0].boundingBox;
      expect(storedBb.x).toBeCloseTo(0.1, 5);
      expect(storedBb.y).toBeCloseTo(0.2, 5);
      expect(storedBb.w).toBeCloseTo(0.3, 5);
      expect(storedBb.h).toBeCloseTo(0.4, 5);
    });
  });

  // -------------------------------------------------------------------------
  // L2 embedding normalization
  // -------------------------------------------------------------------------

  describe('embedding L2 normalization', () => {
    it('L2-normalizes the embedding vector', async () => {
      // [3, 4] → norm=5 → [0.6, 0.8]
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [3, 4],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      await service.processMediaItem(makeJob());

      const createManyCall = (mockPrisma.face.createMany as jest.Mock).mock.calls[0][0];
      const storedEmbedding = createManyCall.data[0].embedding;
      expect(storedEmbedding[0]).toBeCloseTo(0.6, 5);
      expect(storedEmbedding[1]).toBeCloseTo(0.8, 5);
    });

    it('stores empty embedding array when no embedding provided', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      await service.processMediaItem(makeJob());

      const createManyCall = (mockPrisma.face.createMany as jest.Mock).mock.calls[0][0];
      expect(createManyCall.data[0].embedding).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Zero faces → no_faces status
  // -------------------------------------------------------------------------

  describe('zero faces detected', () => {
    it('upserts status to no_faces when provider returns empty array', async () => {
      mockProvider.detect.mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      // Final upsert (second call)
      const calls = (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaFaceStatusType.no_faces);
      expect(finalUpsert.update.status).toBe(MediaFaceStatusType.no_faces);
    });

    it('does NOT call face.createMany when no faces detected', async () => {
      mockProvider.detect.mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.createMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-zero faces → processed status
  // -------------------------------------------------------------------------

  describe('faces detected', () => {
    it('upserts status to processed with faceCount, providerKey, and modelVersion', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      await service.processMediaItem(makeJob());

      const calls = (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaFaceStatusType.processed);
      expect(finalUpsert.create.faceCount).toBe(1);
      expect(finalUpsert.create.providerKey).toBe('compreface');
      expect(finalUpsert.create.modelVersion).toBe('arcface-r100-v1');
      expect(finalUpsert.create.processedAt).toBeInstanceOf(Date);
    });

    it('creates face rows via createMany for each detected face', async () => {
      const detectedFaces = [
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          confidence: 0.9,
          embedding: [],
          landmarks: null,
          externalFaceId: 'ext-1',
        },
        {
          boundingBox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
          confidence: 0.85,
          embedding: [],
          landmarks: null,
          externalFaceId: 'ext-2',
        },
      ];
      mockProvider.detect.mockResolvedValue(detectedFaces);

      await service.processMediaItem(makeJob());

      const createManyCall = (mockPrisma.face.createMany as jest.Mock).mock.calls[0][0];
      expect(createManyCall.data).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Prior non-manually-assigned faces deleted
  // -------------------------------------------------------------------------

  describe('idempotency: delete prior non-manual faces', () => {
    it('calls face.deleteMany with manuallyAssigned:false before creating new faces', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({
        where: {
          mediaItemId: 'media-1',
          manuallyAssigned: false,
        },
      });
    });

    it('calls face.deleteMany even when zero faces are detected', async () => {
      mockProvider.detect.mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({
        where: {
          mediaItemId: 'media-1',
          manuallyAssigned: false,
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // No provider configured → markFailed + throw
  // -------------------------------------------------------------------------

  describe('no provider configured', () => {
    it('calls markFailed and throws when face detection provider is not configured', async () => {
      // Return system settings with no face provider
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({
        key: 'global',
        value: { face: { features: { detection: { model: 'arcface-r100-v1' } } } },
      });

      await expect(service.processMediaItem(makeJob())).rejects.toThrow(
        'Face detection provider not configured in system settings',
      );

      // markFailed upserts status to failed
      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaFaceStatusType.failed }),
          update: expect.objectContaining({ status: MediaFaceStatusType.failed }),
        }),
      );
    });

    it('throws when systemSettings row is null (not configured at all)', async () => {
      (mockPrisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.processMediaItem(makeJob())).rejects.toThrow();

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaFaceStatusType.failed }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Provider detect throws → error propagates
  // -------------------------------------------------------------------------

  describe('provider detect throws', () => {
    it('propagates error from provider.detect', async () => {
      mockProvider.detect.mockRejectedValue(new Error('CompreFace unreachable'));

      await expect(service.processMediaItem(makeJob())).rejects.toThrow('CompreFace unreachable');
    });
  });

  // -------------------------------------------------------------------------
  // MediaItem not found → markFailed + throw
  // -------------------------------------------------------------------------

  describe('media item not found', () => {
    it('calls markFailed and throws when mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.processMediaItem(makeJob())).rejects.toThrow(
        'MediaItem media-1 or its StorageObject not found',
      );

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaFaceStatusType.failed }),
        }),
      );
    });

    it('calls markFailed and throws when mediaItem has no storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: null }),
      );

      await expect(service.processMediaItem(makeJob())).rejects.toThrow(
        'MediaItem media-1 or its StorageObject not found',
      );
    });
  });
});

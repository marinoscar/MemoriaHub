/**
 * Unit tests for FaceDetectionService.
 *
 * Tests bounding-box normalization, L2 embedding normalization, face creation,
 * status upserts, markFailed paths, provider-not-configured error,
 * and Phase 3 face matching after detection.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work.
 */

// Stub Docker-only packages loaded transitively via face-provider.registry.
// { virtual: true } is required for packages not installed locally.
jest.mock('@tensorflow/tfjs', () => ({
  setBackend: jest.fn().mockResolvedValue(undefined),
  ready: jest.fn().mockResolvedValue(undefined),
  tensor3d: jest.fn().mockReturnValue({ dispose: jest.fn() }),
}), { virtual: true });
jest.mock('@tensorflow/tfjs-backend-wasm', () => ({}), { virtual: true });
jest.mock('@vladmandic/human/dist/human.node-wasm.js', () => ({
  Human: jest.fn().mockImplementation(() => ({
    load: jest.fn().mockResolvedValue(undefined),
    warmup: jest.fn().mockResolvedValue(undefined),
    detect: jest.fn().mockResolvedValue({ face: [] }),
  })),
  default: jest.fn(),
}), { virtual: true });
jest.mock('sharp', () =>
  jest.fn().mockReturnValue({
    ensureAlpha: jest.fn().mockReturnThis(),
    raw: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue({ data: Buffer.alloc(0), info: { width: 1, height: 1 } }),
  }),
);

import { Test, TestingModule } from '@nestjs/testing';
import { Readable } from 'stream';
import { FaceDetectionService } from './face-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { FaceSettingsService } from './face-settings.service';
import { FaceProviderRegistry } from './providers/face-provider.registry';
import { FaceMatchingService } from './face-matching.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { EnrichmentJob, JobReason, JobStatus, MediaFaceStatusType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'face_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
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
  let mockProvider: { detect: jest.Mock; capabilities: { delegatedRecognize: boolean } };
  let mockStorageProvider: { download: jest.Mock };
  let mockMatchingService: {
    matchFaceToPerson: jest.Mock;
    matchFaceByExternalId: jest.Mock;
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockProvider = {
      detect: jest.fn(),
      capabilities: { delegatedRecognize: false },
    };
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockFaceSettingsService = { resolveCredentials: jest.fn().mockResolvedValue({ apiKey: 'test-key' }) };
    mockStorageProvider = { download: jest.fn().mockResolvedValue(makeReadable()) };
    mockMatchingService = {
      matchFaceToPerson: jest.fn().mockResolvedValue(null),
      matchFaceByExternalId: jest.fn().mockResolvedValue(null),
    };

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

    // Default face.create returns a created face
    (mockPrisma.face.create as jest.Mock).mockResolvedValue({
      id: 'face-1',
      embedding: [],
      externalFaceId: null,
    });

    // Default face.update succeeds
    (mockPrisma.face.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FaceDetectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FaceSettingsService, useValue: mockFaceSettingsService },
        { provide: FaceProviderRegistry, useValue: mockRegistry },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: FaceMatchingService, useValue: mockMatchingService },
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

      const createCall = (mockPrisma.face.create as jest.Mock).mock.calls[0][0];
      const storedBb = createCall.data.boundingBox;
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

      const createCall = (mockPrisma.face.create as jest.Mock).mock.calls[0][0];
      const storedBb = createCall.data.boundingBox;
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

      // face.create returns the normalized embedding stored
      (mockPrisma.face.create as jest.Mock).mockResolvedValue({
        id: 'face-1',
        embedding: [0.6, 0.8],
        externalFaceId: null,
      });

      await service.processMediaItem(makeJob());

      const createCall = (mockPrisma.face.create as jest.Mock).mock.calls[0][0];
      const storedEmbedding = createCall.data.embedding;
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

      const createCall = (mockPrisma.face.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.embedding).toEqual([]);
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

    it('does NOT call face.create when no faces detected', async () => {
      mockProvider.detect.mockResolvedValue([]);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.create).not.toHaveBeenCalled();
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

    it('creates face rows via face.create for each detected face', async () => {
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

      // Each create call returns a new face row
      (mockPrisma.face.create as jest.Mock)
        .mockResolvedValueOnce({ id: 'face-1', embedding: [], externalFaceId: 'ext-1' })
        .mockResolvedValueOnce({ id: 'face-2', embedding: [], externalFaceId: 'ext-2' });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.create).toHaveBeenCalledTimes(2);
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

    it('upserts MediaFaceStatus to failed when provider.detect throws', async () => {
      mockProvider.detect.mockRejectedValue(new Error('CompreFace unreachable'));

      await expect(service.processMediaItem(makeJob())).rejects.toThrow('CompreFace unreachable');

      expect(mockPrisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaFaceStatusType.failed }),
          update: expect.objectContaining({ status: MediaFaceStatusType.failed }),
        }),
      );
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

  // -------------------------------------------------------------------------
  // Phase 3: face matching after detection
  // -------------------------------------------------------------------------

  describe('Phase 3: face matching after detection', () => {
    it('assigns personId when matchFaceToPerson returns a match', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [0.6, 0.8],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      (mockPrisma.face.create as jest.Mock).mockResolvedValue({
        id: 'face-1',
        embedding: [0.6, 0.8],
        externalFaceId: null,
      });

      mockMatchingService.matchFaceToPerson.mockResolvedValue({
        personId: 'person-1',
        similarity: 0.9,
      });

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.update).toHaveBeenCalledWith({
        where: { id: 'face-1' },
        data: { personId: 'person-1' },
      });
    });

    it('leaves personId null when no match found (similarity below threshold)', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [0.6, 0.8],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      (mockPrisma.face.create as jest.Mock).mockResolvedValue({
        id: 'face-1',
        embedding: [0.6, 0.8],
        externalFaceId: null,
      });

      mockMatchingService.matchFaceToPerson.mockResolvedValue(null);

      await service.processMediaItem(makeJob());

      expect(mockPrisma.face.update).not.toHaveBeenCalled();
    });

    it('uses delegated path (matchFaceByExternalId) when provider.capabilities.delegatedRecognize is true', async () => {
      // Override provider with delegatedRecognize=true
      mockProvider.capabilities = { delegatedRecognize: true };

      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [],
          landmarks: null,
          externalFaceId: 'ext-123',
        },
      ]);

      (mockPrisma.face.create as jest.Mock).mockResolvedValue({
        id: 'face-1',
        embedding: [],
        externalFaceId: 'ext-123',
      });

      mockMatchingService.matchFaceByExternalId.mockResolvedValue({
        personId: 'person-delegated',
      });

      await service.processMediaItem(makeJob());

      expect(mockMatchingService.matchFaceByExternalId).toHaveBeenCalledWith(
        'circle-1',
        'ext-123',
      );
      expect(mockPrisma.face.update).toHaveBeenCalledWith({
        where: { id: 'face-1' },
        data: { personId: 'person-delegated' },
      });
    });

    it('matching failure is non-fatal — detection still completes', async () => {
      mockProvider.detect.mockResolvedValue([
        {
          boundingBox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          confidence: 0.9,
          embedding: [0.6, 0.8],
          landmarks: null,
          externalFaceId: null,
        },
      ]);

      (mockPrisma.face.create as jest.Mock).mockResolvedValue({
        id: 'face-1',
        embedding: [0.6, 0.8],
        externalFaceId: null,
      });

      mockMatchingService.matchFaceToPerson.mockRejectedValue(new Error('match failed'));

      // Should not throw — matching failure is non-fatal
      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();

      // Status should still be upserted to processed
      const calls = (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mock.calls;
      const finalUpsert = calls[calls.length - 1][0];
      expect(finalUpsert.create.status).toBe(MediaFaceStatusType.processed);
    });
  });
});

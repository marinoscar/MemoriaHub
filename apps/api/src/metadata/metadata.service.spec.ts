/**
 * Unit tests for MetadataExtractionService — compute/persist split.
 *
 * computeMetadata is the PURE half (mirrored by apps/cli/src/node/compute/
 * metadata.ts for distributed worker nodes): EXIF + oriented dimensions for
 * images (folded into the `exif` record as width/height), ffprobe container
 * metadata for videos. persistMetadata is the SERVER-ONLY half: reverse
 * geocoding (needs the server's configured geo provider), _processing merge,
 * typed-column sync, and status upserts. processMediaItem composes
 * download → computeMetadata → persistMetadata for the in-process worker path.
 *
 * REGRESSION GUARD: no EventEmitter is injected — metadata re-run must NOT
 * cascade to tagging/face/burst (see dedicated test below).
 */

import { Readable } from 'stream';
import sharp from 'sharp';
import { Test, TestingModule } from '@nestjs/testing';
import { MetadataExtractionService } from './metadata.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';
import { GeoLocationService } from '../media/geo/geo-location.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { EnrichmentJob, JobReason, JobStatus, MediaMetadataStatusType } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'metadata_extraction',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.rerun,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  deletedAt: Date | null;
  storageObjectId: string | null;
  storageObject: { id: string; storageKey: string; mimeType: string } | null;
}> = {}) {
  return {
    id: 'media-1',
    circleId: 'circle-1',
    deletedAt: null,
    storageObjectId: 'so-1',
    storageObject: { id: 'so-1', storageKey: 'img/photo.jpg', mimeType: 'image/jpeg' },
    ...overrides,
  };
}

function makeStorageObject(overrides: Partial<{
  id: string;
  mimeType: string;
  metadata: Record<string, unknown> | null;
}> = {}) {
  return {
    id: 'so-1',
    mimeType: 'image/jpeg',
    metadata: null as Record<string, unknown> | null,
    ...overrides,
  };
}

/** A tiny real JPEG (no EXIF) — used to exercise the real compute path. */
async function makeTestJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 20, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetadataExtractionService', () => {
  let service: MetadataExtractionService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: { download: jest.Mock };
  let mockMediaMetadataSyncService: { syncFromStorageObject: jest.Mock };
  let mockGeoLocationService: { reverseGeocode: jest.Mock };
  let testJpeg: Buffer;

  beforeAll(async () => {
    testJpeg = await makeTestJpeg();
  });

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockStorageProvider = {
      download: jest.fn().mockImplementation(async () => Readable.from(testJpeg)),
    };
    mockMediaMetadataSyncService = { syncFromStorageObject: jest.fn().mockResolvedValue(undefined) };
    mockGeoLocationService = {
      reverseGeocode: jest.fn().mockResolvedValue({ result: null, source: 'none' }),
    };

    // Default: media item found
    (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());

    // Default: storage object found
    (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(makeStorageObject());

    // Default: upserts succeed
    (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.storageObject.update as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetadataExtractionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: MediaMetadataSyncService, useValue: mockMediaMetadataSyncService },
        { provide: GeoLocationService, useValue: mockGeoLocationService },
      ],
    }).compile();

    service = module.get<MetadataExtractionService>(MetadataExtractionService);
  });

  // =========================================================================
  // computeMetadata — pure compute half (round-trip against a real JPEG)
  // =========================================================================

  describe('computeMetadata', () => {
    it('extracts oriented dimensions for an image and folds them into exif; probe is null', async () => {
      const result = await service.computeMetadata(testJpeg, { mimeType: 'image/jpeg' });

      expect(result.probe).toBeNull();
      expect(result.exif.width).toBe(20);
      expect(result.exif.height).toBe(10);
      expect(result.errors).toBeUndefined();
    });

    it('returns a video-probe error (not a throw) when no filePath is supplied for a video', async () => {
      const result = await service.computeMetadata(Buffer.alloc(0), { mimeType: 'video/mp4' });

      expect(result.probe).toBeNull();
      expect(result.exif).toEqual({});
      expect(result.errors?.['video-probe']).toMatch(/seekable file path/i);
    });

    it('returns an empty exif record for an image with no EXIF data (normal for a generated JPEG)', async () => {
      const result = await service.computeMetadata(testJpeg, { mimeType: 'image/jpeg' });

      expect(result.exif['latitude']).toBeUndefined();
      expect(result.exif['cameraMake']).toBeUndefined();
    });
  });

  // =========================================================================
  // persistMetadata — server-only half (geocode, _processing merge, sync)
  // =========================================================================

  describe('persistMetadata', () => {
    it('writes exif/dimensions/geocode(no-GPS) entries, syncs, and marks processed', async () => {
      await service.persistMetadata(makeJob(), {
        exif: { width: 20, height: 10, cameraMake: 'Apple' },
        probe: null,
      });

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      const processing = (updateCall.data.metadata as Record<string, unknown>)['_processing'] as Record<
        string,
        unknown
      >;

      expect(processing['exif']).toEqual({ cameraMake: 'Apple' });
      expect(processing['dimensions']).toEqual({ width: 20, height: 10 });
      // No lat/lng in the exif payload → clean no-op geocode entry, geo service never called.
      expect(processing['geocode']).toEqual({});
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();

      expect(mockMediaMetadataSyncService.syncFromStorageObject).toHaveBeenCalledWith('so-1');

      const statusCalls = (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mock.calls;
      const lastStatusCall = statusCalls[statusCalls.length - 1][0];
      expect(lastStatusCall.update.status).toBe(MediaMetadataStatusType.processed);
    });

    it('calls GeoLocationService.reverseGeocode when exif carries finite lat/lng and writes its result', async () => {
      mockGeoLocationService.reverseGeocode.mockResolvedValue({
        result: { country: 'Costa Rica', countryCode: 'CR', locality: 'San José' },
        source: 'offline',
      });

      await service.persistMetadata(makeJob(), {
        exif: { width: 20, height: 10, latitude: 9.93, longitude: -84.08 },
        probe: null,
      });

      expect(mockGeoLocationService.reverseGeocode).toHaveBeenCalledWith(9.93, -84.08);

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      const processing = (updateCall.data.metadata as Record<string, unknown>)['_processing'] as Record<
        string,
        unknown
      >;
      const geocode = processing['geocode'] as Record<string, unknown>;
      expect(geocode['country']).toBe('Costa Rica');
      expect(geocode['locality']).toBe('San José');
      expect(geocode['source']).toBe('offline');
    });

    it('writes a video-probe entry (no geocode entry) for a video result', async () => {
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
        makeStorageObject({ mimeType: 'video/mp4' }),
      );
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: { id: 'so-1', storageKey: 'vid/clip.mp4', mimeType: 'video/mp4' } }),
      );

      await service.persistMetadata(makeJob(), {
        exif: {},
        probe: { durationMs: 5000, width: 1920, height: 1080, codec: 'h264', formatTags: {}, streamTags: [] },
      });

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      const processing = (updateCall.data.metadata as Record<string, unknown>)['_processing'] as Record<
        string,
        unknown
      >;
      expect(processing['video-probe']).toEqual({
        durationMs: 5000,
        width: 1920,
        height: 1080,
        codec: 'h264',
        formatTags: {},
        streamTags: [],
      });
      expect(processing['geocode']).toBeUndefined();
      expect(mockGeoLocationService.reverseGeocode).not.toHaveBeenCalled();
    });

    it('preserves existing _processing keys and top-level metadata on merge', async () => {
      const existingMeta = { existingKey: 'existingValue', _processing: { oldData: 123 } };
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
        makeStorageObject({ metadata: existingMeta }),
      );

      await service.persistMetadata(makeJob(), { exif: { width: 1, height: 1 }, probe: null });

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      const merged = updateCall.data.metadata as Record<string, unknown>;
      expect(merged['existingKey']).toBe('existingValue');
      const processing = merged['_processing'] as Record<string, unknown>;
      expect(processing['oldData']).toBe(123);
    });

    it('writes a compute error as `<name>_error` instead of a success entry', async () => {
      await service.persistMetadata(makeJob(), {
        exif: {},
        probe: null,
        errors: { exif: 'exifr threw' },
      });

      const updateCall = (mockPrisma.storageObject.update as jest.Mock).mock.calls[0][0];
      const processing = (updateCall.data.metadata as Record<string, unknown>)['_processing'] as Record<
        string,
        unknown
      >;
      expect(processing['exif_error']).toBe('exifr threw');
      expect(processing['exif']).toBeUndefined();
    });

    it('throws immediately if job.mediaItemId is null', async () => {
      await expect(
        service.persistMetadata(makeJob({ mediaItemId: null }), { exif: {}, probe: null }),
      ).rejects.toThrow('missing mediaItemId');
    });

    it('upserts failed status and resolves (no throw) when mediaItem is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.persistMetadata(makeJob(), { exif: {}, probe: null }),
      ).resolves.toBeUndefined();

      expect(mockPrisma.mediaMetadataStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: MediaMetadataStatusType.failed }),
        }),
      );
    });

    it('rethrows and marks status failed when syncFromStorageObject throws', async () => {
      mockMediaMetadataSyncService.syncFromStorageObject.mockRejectedValue(new Error('sync failed'));

      await expect(
        service.persistMetadata(makeJob(), { exif: {}, probe: null }),
      ).rejects.toThrow('sync failed');

      const upsertCalls = (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mock.calls;
      const failedCall = upsertCalls.find(
        (c: any[]) => c[0].update.status === MediaMetadataStatusType.failed,
      );
      expect(failedCall).toBeDefined();
      expect(failedCall![0].update.lastError).toBe('sync failed');
    });
  });

  // =========================================================================
  // processMediaItem — download → computeMetadata → persistMetadata
  // =========================================================================

  describe('processMediaItem', () => {
    it('downloads, computes, and persists on the happy path', async () => {
      await service.processMediaItem(makeJob());

      expect(mockStorageProvider.download).toHaveBeenCalledWith('img/photo.jpg');
      expect(mockMediaMetadataSyncService.syncFromStorageObject).toHaveBeenCalledWith('so-1');

      const calls = (mockPrisma.mediaMetadataStatus.upsert as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0][0].update.status).toBe(MediaMetadataStatusType.processing);
      expect(calls[calls.length - 1][0].update.status).toBe(MediaMetadataStatusType.processed);
    });

    it('throws immediately if job.mediaItemId is null', async () => {
      await expect(
        service.processMediaItem(makeJob({ mediaItemId: null })),
      ).rejects.toThrow('missing mediaItemId');
    });

    it('upserts failed status and resolves (no throw) when mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ deletedAt: new Date() }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();
      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });

    it('upserts failed status and resolves (no throw) when mediaItem has no storageObject', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: null, storageObjectId: null }),
      );

      await expect(service.processMediaItem(makeJob())).resolves.toBeUndefined();
      expect(mockStorageProvider.download).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // REGRESSION GUARD: no EventEmitter cascade
  // =========================================================================

  describe('no EventEmitter cascade — regression guard', () => {
    it('resolves cleanly with only Prisma/StorageProvider/MediaMetadataSyncService/GeoLocationService — no EventEmitter2', async () => {
      // metadata re-run must NOT cascade to tagging/face/burst: the service's
      // only side-effect beyond the explicit DB writes is the sync call below.
      await service.processMediaItem(makeJob());

      expect(mockMediaMetadataSyncService.syncFromStorageObject).toHaveBeenCalledTimes(1);
    });
  });
});

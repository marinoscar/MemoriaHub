/**
 * Unit tests for MediaEnhancementService.
 *
 * Mocking strategy mirrors location-suggestion.service.spec.ts: a fresh
 * jest-mock-extended PrismaService plus plain jest-mock collaborators wired
 * through a NestJS TestingModule. `$transaction` is wired to pass the same
 * mock through (interactive-transaction style), matching the
 * social-media-detection.handler.spec.ts precedent, since applySystemTag runs
 * tag.upsert/mediaTag.upsert/updateMany inside a transaction.
 *
 * Covers (spec §13):
 *   - startEnhance: feature-flag-off 400, env kill-switch 400, 404 for a
 *     missing/deleted item, RBAC (collaborator), photo-only 400, no-model 400,
 *     megapixel guard 400, supersession of any prior live row, deterministic
 *     prompt compile + row creation, job enqueue shape
 *   - getEnhancement / getLatestEnhancement: RBAC (viewer), compare payload
 *     with sizes serialized as STRINGS, downscaled flag, failed row surfaces
 *     lastError, non-ready row omits original/enhanced
 *   - applyEnhancement: RBAC (collaborator), not-ready 400
 *     - keep_both: new MediaItem created with copied metadata + coordSource,
 *       contentHash nulled, system tag applied, upload enrichment enqueued,
 *       staging deleted, row -> applied/keep_both with resultMediaItemId
 *     - replace: overwrites the ORIGINAL object's key, nulls contentHash,
 *       merges the _aiEnhanced breadcrumb into existing metadata,
 *       reprocesses, re-enqueues face_detection, staging deleted, row ->
 *       applied/replace; allowReplace=false 400 (HARD, no override);
 *       downscale-block 400 unless acknowledgeDownscale passes it (#426)
 *   - discardEnhancement: RBAC (collaborator), deletes staging, row -> discarded
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole, MediaEnhancementStatus, MediaEnhancementDecision, MediaType, MediaTagSource } from '@prisma/client';
import { MediaEnhancementService } from './media-enhancement.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { MediaMetadataSyncService } from '../media/sync/media-metadata-sync.service';
import { MediaEnrichmentService } from '../media/enrichment/media-enrichment.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { EnhanceParams } from './dto/enhance-params.dto';
import { ListEnhancementsQuery } from './dto/list-enhancements-query.dto';

const USER: RequestUser = {
  id: 'user-1',
  email: 'user@example.com',
  roles: ['Contributor'],
  permissions: ['media:read', 'media:write'],
  isActive: true,
};

const MEDIA_ID = 'media-1';
const CIRCLE_ID = 'circle-1';
const ENH_ID = 'enh-1';

function makeMediaItem(overrides: Record<string, any> = {}) {
  return {
    id: MEDIA_ID,
    circleId: CIRCLE_ID,
    type: MediaType.photo,
    deletedAt: null,
    width: 1200,
    height: 900,
    source: 'web',
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    capturedAtOffset: 0,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15',
    originalFilename: 'IMG_0001.jpg',
    takenLat: 9.9,
    takenLng: -84.0,
    takenAltitude: 100,
    geoCountry: 'Costa Rica',
    geoCountryCode: 'CR',
    geoAdmin1: 'San José',
    geoAdmin2: null,
    geoLocality: 'San José',
    geoPlaceName: null,
    geoSource: 'offline',
    geocodedAt: new Date('2026-01-01T00:00:00Z'),
    coordSource: 'exif',
    metadata: null,
    storageObject: {
      id: 'obj-1',
      mimeType: 'image/jpeg',
      storageKey: 'uploads/original.jpg',
      storageProvider: 's3',
      bucket: 'bucket-1',
      size: BigInt(500_000),
    },
    ...overrides,
  };
}

function makeEnhancementRow(overrides: Record<string, any> = {}) {
  return {
    id: ENH_ID,
    mediaItemId: MEDIA_ID,
    circleId: CIRCLE_ID,
    status: MediaEnhancementStatus.ready,
    decision: null,
    params: { strength: 'balanced' },
    provider: 'openai',
    model: 'gpt-image-1',
    prompt: 'Enhance this photograph...',
    stagingStorageKey: 'enhancements/enh-1/result.jpg',
    stagingThumbnailKey: 'enhancements/enh-1/thumb.jpg',
    stagingProvider: 'r2',
    stagingBucket: 'active-bucket',
    originalWidth: 1200,
    originalHeight: 900,
    enhancedWidth: 1536,
    enhancedHeight: 1024,
    enhancedSize: BigInt(999_999),
    resultMediaItemId: null,
    lastError: null,
    createdById: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSettings(overrides: Record<string, any> = {}) {
  return {
    features: { pictureEnhancement: true, faceRecognition: false },
    ai: { features: { enhance: { provider: 'openai', model: 'gpt-image-1' } } },
    pictureEnhancement: {
      defaultQuality: 'high',
      defaultStrength: 'balanced',
      maxInputMegapixels: 50,
      allowReplace: true,
      blockReplaceOnDownscale: false,
    },
    ...overrides,
  };
}

describe('MediaEnhancementService', () => {
  let service: MediaEnhancementService;
  let mockPrisma: MockPrismaService;
  let mockMembership: { assertCircleAccess: jest.Mock };
  let mockResolver: {
    getProviderFor: jest.Mock;
    getActiveProvider: jest.Mock;
  };
  let mockRecoveryService: { reprocessObjectNow: jest.Mock };
  let mockMetadataSync: { syncFromStorageObject: jest.Mock };
  let mockMediaEnrichment: { enqueueUploadEnrichment: jest.Mock };
  let mockThumbnails: { signThumbsBatched: jest.Mock; extractThumbKey: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock; getSettingValue: jest.Mock };

  let mockObjectProvider: { getSignedDownloadUrl: jest.Mock; download: jest.Mock; upload: jest.Mock; delete: jest.Mock };
  let mockActiveProvider: { upload: jest.Mock; getBucket: jest.Mock; getSignedDownloadUrl: jest.Mock; download: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
    delete process.env['FACE_AUTO_DETECT'];

    mockPrisma = createMockPrismaService();

    mockMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: CircleRole.collaborator, isSuperAdmin: false }),
    };

    mockObjectProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/original-signed'),
      download: jest.fn(),
      upload: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    mockActiveProvider = {
      upload: jest.fn().mockResolvedValue({}),
      getBucket: jest.fn().mockReturnValue('active-bucket'),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/active-signed'),
      download: jest.fn().mockResolvedValue(streamFromString('staged-enhanced-bytes')),
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;
    mockResolver = {
      // The ORIGINAL object lives on provider 's3'; the staged/active enhancement
      // bytes live on provider 'r2' (the resolved "active" provider). Route by
      // providerId so signOriginal() and signStaging() get distinct signed URLs.
      getProviderFor: jest.fn().mockImplementation(async (providerId: string) =>
        providerId === 'r2' ? mockActiveProvider : mockObjectProvider,
      ),
      getActiveProvider: jest.fn().mockResolvedValue({ id: 'r2', provider: mockActiveProvider }),
    };

    mockRecoveryService = { reprocessObjectNow: jest.fn().mockResolvedValue(undefined) };
    mockMetadataSync = { syncFromStorageObject: jest.fn().mockResolvedValue(undefined) };
    mockMediaEnrichment = { enqueueUploadEnrichment: jest.fn().mockResolvedValue(undefined) };
    mockThumbnails = {
      signThumbsBatched: jest.fn().mockResolvedValue(new Map()),
      extractThumbKey: jest.fn().mockReturnValue(null),
    };
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue(makeSettings()),
      getSettingValue: jest.fn().mockResolvedValue(undefined),
    };

    // Interactive-transaction passthrough (applySystemTag runs tx.tag.upsert / tx.mediaTag.upsert|updateMany).
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') return arg(mockPrisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    });
    (mockPrisma.tag.upsert as jest.Mock).mockImplementation(async (args: any) => ({
      id: `tag-${args.create.name}`,
      ...args.create,
    }));
    (mockPrisma.mediaTag.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.mediaTag.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
    (mockPrisma.mediaFaceStatus.upsert as jest.Mock).mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaEnhancementService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: StorageProcessingRecoveryService, useValue: mockRecoveryService },
        { provide: MediaMetadataSyncService, useValue: mockMetadataSync },
        { provide: MediaEnrichmentService, useValue: mockMediaEnrichment },
        { provide: MediaThumbnailService, useValue: mockThumbnails },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<MediaEnhancementService>(MediaEnhancementService);
  });

  // ===========================================================================
  // startEnhance
  // ===========================================================================

  describe('startEnhance', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaEnhancement.create as jest.Mock).mockResolvedValue(makeEnhancementRow({ status: MediaEnhancementStatus.pending }));
    });

    it('throws 400 when features.pictureEnhancement is off', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ features: { pictureEnhancement: false } }));

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(BadRequestException);
      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow('Picture enhancement is disabled');
      expect(mockPrisma.mediaItem.findUnique).not.toHaveBeenCalled();
    });

    it('throws 400 when PICTURE_ENHANCEMENT_ENABLED=false, even with the feature flag on', async () => {
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(BadRequestException);
    });

    it('throws 404 when the MediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(NotFoundException);
    });

    it('throws 404 for a soft-deleted item', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem({ deletedAt: new Date() }));

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(NotFoundException);
    });

    it('asserts circle access at the collaborator level', async () => {
      await service.startEnhance(MEDIA_ID, {}, USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.collaborator,
      );
    });

    it('propagates a ForbiddenException from RBAC (non-collaborator)', async () => {
      mockMembership.assertCircleAccess.mockRejectedValue(new ForbiddenException('nope'));

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(ForbiddenException);
    });

    it('throws 400 for a non-photo item', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem({ type: MediaType.video }));

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(
        'Picture enhancement is only supported for photos',
      );
    });

    it('throws 400 for a non-image MIME type', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ storageObject: { ...makeMediaItem().storageObject, mimeType: 'application/pdf' } }),
      );

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(
        'Picture enhancement is only supported for photos',
      );
    });

    it('throws 400 when no enhancement model is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ ai: { features: { enhance: null } } }),
      );

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(
        'No enhancement model configured',
      );
    });

    it('throws 400 when the image exceeds maxInputMegapixels', async () => {
      // 12000x9000 = 108 MP > default 50 MP cap.
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ width: 12000, height: 9000 }),
      );

      await expect(service.startEnhance(MEDIA_ID, {}, USER)).rejects.toThrow(/exceeds the 50 MP limit/);
    });

    it('supersedes any prior live (pending/processing/ready) enhancement for the item', async () => {
      const priorLive = makeEnhancementRow({ id: 'enh-old', status: MediaEnhancementStatus.ready });
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([priorLive]);

      await service.startEnhance(MEDIA_ID, {}, USER);

      // Staging bytes of the old row were deleted, and it was marked discarded.
      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'active-bucket');
      expect(mockActiveProvider.delete).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
      // ...including the thumbnail derivative (issue #203).
      expect(mockActiveProvider.delete).toHaveBeenCalledWith('enhancements/enh-1/thumb.jpg');
      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: 'enh-old' },
        data: {
          status: MediaEnhancementStatus.discarded,
          stagingStorageKey: null,
          stagingThumbnailKey: null,
        },
      });
    });

    it('does not attempt to supersede when there is no live row (no staging deletion)', async () => {
      await service.startEnhance(MEDIA_ID, {}, USER);

      expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
    });

    it('creates the enhancement row with the deterministically-compiled prompt and provider/model', async () => {
      await service.startEnhance(MEDIA_ID, { intent: 'auto' }, USER);

      expect(mockPrisma.mediaEnhancement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          status: MediaEnhancementStatus.pending,
          provider: 'openai',
          model: 'gpt-image-1',
          prompt: expect.stringContaining('Enhance this photograph'),
          originalWidth: 1200,
          originalHeight: 900,
          createdById: USER.id,
        }),
      });
    });

    it('allows a per-request model override via params.model', async () => {
      await service.startEnhance(MEDIA_ID, { model: 'gpt-image-1-custom' }, USER);

      expect(mockPrisma.mediaEnhancement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ model: 'gpt-image-1-custom' }),
      });
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ modelVersion: 'gpt-image-1-custom' }),
      );
    });

    it('enqueues a picture_enhancement job referencing the new row', async () => {
      const result = await service.startEnhance(MEDIA_ID, {}, USER);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'picture_enhancement',
        mediaItemId: MEDIA_ID,
        circleId: CIRCLE_ID,
        reason: 'rerun',
        priority: 0,
        providerKey: 'openai',
        modelVersion: 'gpt-image-1',
        payload: { enhancementId: ENH_ID },
      });
      expect(result).toEqual({ data: { enhancementId: ENH_ID, jobId: 'job-1', status: 'pending' } });
    });
  });

  // ===========================================================================
  // getEnhancement / getLatestEnhancement (compare payload)
  // ===========================================================================

  describe('getEnhancement / getLatestEnhancement', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
    });

    it('asserts circle access at the viewer level', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({ status: MediaEnhancementStatus.pending, stagingStorageKey: null }),
      );

      await service.getEnhancement(MEDIA_ID, ENH_ID, USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.viewer,
      );
    });

    it('throws 404 when the enhancement row does not belong to the item', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({ mediaItemId: 'some-other-item' }),
      );

      await expect(service.getEnhancement(MEDIA_ID, ENH_ID, USER)).rejects.toThrow(NotFoundException);
    });

    it('returns { data: null } from getLatestEnhancement when no row exists', async () => {
      (mockPrisma.mediaEnhancement.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getLatestEnhancement(MEDIA_ID, USER);

      expect(result).toEqual({ data: null });
    });

    it('a pending/processing row returns only base fields (no original/enhanced)', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({ status: MediaEnhancementStatus.processing, stagingStorageKey: null }),
      );

      const result = await service.getEnhancement(MEDIA_ID, ENH_ID, USER);

      expect(result.data).toMatchObject({ id: ENH_ID, status: MediaEnhancementStatus.processing });
      expect((result.data as any).original).toBeUndefined();
      expect((result.data as any).enhanced).toBeUndefined();
    });

    it('a failed row surfaces lastError', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({
          status: MediaEnhancementStatus.failed,
          stagingStorageKey: null,
          lastError: 'OpenAI image edit exploded',
        }),
      );

      const result = await service.getEnhancement(MEDIA_ID, ENH_ID, USER);

      expect((result.data as any).lastError).toBe('OpenAI image edit exploded');
    });

    it('a ready row returns signed original/enhanced with byte sizes serialized as STRINGS', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(makeEnhancementRow());

      const result = await service.getEnhancement(MEDIA_ID, ENH_ID, USER);
      const data = result.data as any;

      expect(data.original.url).toBe('https://cdn.example.com/original-signed');
      expect(data.original.size).toBe('500000');
      expect(typeof data.original.size).toBe('string');

      expect(data.enhanced.url).toBe('https://cdn.example.com/active-signed');
      expect(data.enhanced.size).toBe('999999');
      expect(typeof data.enhanced.size).toBe('string');
      expect(data.enhanced.width).toBe(1536);
      expect(data.enhanced.height).toBe(1024);
    });

    it('sets downscaled:true when the enhanced pixel area is smaller than the original', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({ enhancedWidth: 512, enhancedHeight: 384 }), // well under 1200x900
      );

      const result = await service.getEnhancement(MEDIA_ID, ENH_ID, USER);

      expect((result.data as any).downscaled).toBe(true);
    });

    it('sets downscaled:false when the enhanced pixel area is not smaller than the original', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(makeEnhancementRow()); // 1536x1024 > 1200x900

      const result = await service.getEnhancement(MEDIA_ID, ENH_ID, USER);

      expect((result.data as any).downscaled).toBe(false);
    });
  });

  // ===========================================================================
  // applyEnhancement
  // ===========================================================================

  describe('applyEnhancement', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockImplementation(async (args: any) => {
        // Two different select shapes are used (RBAC lookup vs. keep_both/replace source lookup);
        // the fixture covers both by returning every field regardless of `select`.
        return makeMediaItem();
      });
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(makeEnhancementRow());
      (mockPrisma.storageObject.create as jest.Mock).mockResolvedValue({ id: 'new-obj-1' });
      (mockPrisma.mediaItem.create as jest.Mock).mockResolvedValue({ id: 'new-media-1' });
      (mockPrisma.mediaItem.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.storageObject.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.mediaEnhancement.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.storageObject.findUnique as jest.Mock).mockResolvedValue({
        id: 'obj-1',
        status: 'ready',
      });
    });

    it('asserts circle access at the collaborator level', async () => {
      await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.collaborator,
      );
    });

    it('throws 400 when the row is not ready (e.g. still pending)', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({ status: MediaEnhancementStatus.pending, stagingStorageKey: null }),
      );

      await expect(service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER)).rejects.toThrow(
        BadRequestException,
      );
    });

    describe('keep_both', () => {
      it('promotes the staged bytes to a fresh object on the active provider', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(mockResolver.getProviderFor).toHaveBeenCalledWith('r2', 'active-bucket');
        expect(mockActiveProvider.download).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
        expect(mockResolver.getActiveProvider).toHaveBeenCalled();
        expect(mockActiveProvider.upload).toHaveBeenCalledWith(
          expect.stringMatching(/^uploads\//),
          expect.anything(),
          expect.objectContaining({ mimeType: 'image/jpeg' }),
        );
      });

      it('creates a new MediaItem copying capture/camera/geo metadata from the source, with contentHash nulled', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(mockPrisma.mediaItem.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            circleId: CIRCLE_ID,
            type: MediaType.photo,
            capturedAt: makeMediaItem().capturedAt,
            cameraMake: 'Apple',
            cameraModel: 'iPhone 15',
            takenLat: 9.9,
            takenLng: -84.0,
            geoCountry: 'Costa Rica',
            coordSource: 'exif',
            contentHash: null,
            width: 1536,
            height: 1024,
          }),
        });
      });

      it('reprocesses the new object and best-effort syncs metadata', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(mockRecoveryService.reprocessObjectNow).toHaveBeenCalledWith({ id: 'new-obj-1' });
        expect(mockMetadataSync.syncFromStorageObject).toHaveBeenCalledWith('new-obj-1');
      });

      it('applies the "AI Enhanced" system tag to the new item', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { circleId_name: { circleId: CIRCLE_ID, name: 'AI Enhanced' } },
          }),
        );
        expect(mockPrisma.mediaTag.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ mediaItemId: 'new-media-1', source: MediaTagSource.system }),
          }),
        );
      });

      it('enqueues standard upload-time enrichment for the new item', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(mockMediaEnrichment.enqueueUploadEnrichment).toHaveBeenCalledWith({
          id: 'new-media-1',
          type: MediaType.photo,
          circleId: CIRCLE_ID,
          deletedAt: null,
        });
      });

      it('deletes the staging bytes and finalizes the row as applied/keep_both with resultMediaItemId', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(mockActiveProvider.delete).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
        expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
          where: { id: ENH_ID },
          data: {
            status: MediaEnhancementStatus.applied,
            decision: MediaEnhancementDecision.keep_both,
            resultMediaItemId: 'new-media-1',
            stagingStorageKey: null,
            stagingThumbnailKey: null,
          },
        });
      });

      it('returns the new item id, status applied, decision keep_both', async () => {
        const result = await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(result).toEqual({ data: { id: 'new-media-1', status: 'applied', decision: 'keep_both' } });
      });

      // -----------------------------------------------------------------------
      // Metadata merge (commit 256058d "copy source metadata into keep_both
      // enhanced items"): inheritableMetadata() carries user/descriptive keys
      // over, drops `_`-prefixed internal-processing-state keys AND
      // thumbnailObjectId/thumbnailStorageKey (the new item gets its own via
      // its own reprocess), then the enhancement's own breadcrumb is layered on
      // top last so it always wins on a key collision.
      // -----------------------------------------------------------------------

      describe('metadata merge', () => {
        it('carries plain/descriptive metadata keys over onto the new item', async () => {
          (mockPrisma.mediaItem.findUnique as jest.Mock).mockImplementation(async () =>
            makeMediaItem({ metadata: { caption: 'Family reunion', album: 'Summer 2024' } }),
          );

          await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

          expect(mockPrisma.mediaItem.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
              metadata: expect.objectContaining({
                caption: 'Family reunion',
                album: 'Summer 2024',
              }),
            }),
          });
        });

        it('strips `_`-prefixed internal-processing-state keys from the copied metadata', async () => {
          (mockPrisma.mediaItem.findUnique as jest.Mock).mockImplementation(async () =>
            makeMediaItem({
              metadata: {
                caption: 'Family reunion',
                _processing: { exif: 'done' },
                _processingRetryCount: 2,
                _thumbnailRepairAttempts: 1,
                _thumbnailRepairExhausted: true,
                _processedAt: '2026-01-01T00:00:00Z',
                _aiEnhanced: { model: 'old-model', enhancementId: 'old-enh' },
                _enhancedFrom: 'old-source-id',
              },
            }),
          );

          await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

          const call = (mockPrisma.mediaItem.create as jest.Mock).mock.calls[0][0];
          const meta = call.data.metadata as Record<string, unknown>;
          expect(meta['caption']).toBe('Family reunion');
          // The stale internal-processing-state keys are gone entirely.
          expect(meta).not.toHaveProperty('_processing');
          expect(meta).not.toHaveProperty('_processingRetryCount');
          expect(meta).not.toHaveProperty('_thumbnailRepairAttempts');
          expect(meta).not.toHaveProperty('_thumbnailRepairExhausted');
          expect(meta).not.toHaveProperty('_processedAt');
          // The only surviving underscore-prefixed keys are the FRESH
          // breadcrumb this enhancement writes, layered on top of (not merged
          // with) whatever stale `_aiEnhanced`/`_enhancedFrom` the source had.
          expect(Object.keys(meta).filter((k) => k.startsWith('_')).sort()).toEqual([
            '_aiEnhanced',
            '_enhancedFrom',
          ]);
          expect((meta['_aiEnhanced'] as Record<string, unknown>)['model']).toBe('gpt-image-1');
        });

        it('strips thumbnailObjectId/thumbnailStorageKey from the copied metadata (new item gets its own)', async () => {
          (mockPrisma.mediaItem.findUnique as jest.Mock).mockImplementation(async () =>
            makeMediaItem({
              metadata: {
                caption: 'Family reunion',
                thumbnailObjectId: 'old-thumb-obj-id',
                thumbnailStorageKey: 'thumbnails/old-thumb.jpg',
              },
            }),
          );

          await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

          const call = (mockPrisma.mediaItem.create as jest.Mock).mock.calls[0][0];
          const meta = call.data.metadata as Record<string, unknown>;
          expect(meta).not.toHaveProperty('thumbnailObjectId');
          expect(meta).not.toHaveProperty('thumbnailStorageKey');
          expect(meta['caption']).toBe('Family reunion');
        });

        it("the enhancement's own breadcrumb keys (_aiEnhanced, _enhancedFrom) win on any collision with copied source metadata", async () => {
          (mockPrisma.mediaItem.findUnique as jest.Mock).mockImplementation(async () =>
            makeMediaItem({
              id: MEDIA_ID,
              metadata: {
                // A prior _aiEnhanced/_enhancedFrom would be stripped anyway
                // (underscore rule), but this asserts the WIN-ON-COLLISION
                // guarantee explicitly, independent of the strip rule.
                _aiEnhanced: { model: 'stale-model', enhancementId: 'stale-enh', at: 'stale', fromId: 'stale-from' },
                _enhancedFrom: 'stale-source-id',
              },
            }),
          );

          await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

          const call = (mockPrisma.mediaItem.create as jest.Mock).mock.calls[0][0];
          const meta = call.data.metadata as Record<string, unknown>;
          expect(meta['_enhancedFrom']).toBe(MEDIA_ID);
          expect((meta['_aiEnhanced'] as Record<string, unknown>)['model']).toBe('gpt-image-1');
          expect((meta['_aiEnhanced'] as Record<string, unknown>)['enhancementId']).toBe(ENH_ID);
          expect((meta['_aiEnhanced'] as Record<string, unknown>)['fromId']).toBe(MEDIA_ID);
        });

        it('produces just the breadcrumb metadata when the source has none', async () => {
          (mockPrisma.mediaItem.findUnique as jest.Mock).mockImplementation(async () =>
            makeMediaItem({ metadata: null }),
          );

          await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

          const call = (mockPrisma.mediaItem.create as jest.Mock).mock.calls[0][0];
          const meta = call.data.metadata as Record<string, unknown>;
          expect(Object.keys(meta).sort()).toEqual(['_aiEnhanced', '_enhancedFrom']);
        });
      });
    });

    describe('replace', () => {
      it('overwrites the ORIGINAL object key on its own provider (not the staging/active provider)', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-1');
        expect(mockObjectProvider.upload).toHaveBeenCalledWith(
          'uploads/original.jpg',
          expect.anything(),
          expect.objectContaining({ mimeType: 'image/jpeg' }),
        );
      });

      it('nulls contentHash and resets orientation/dims in the same transaction as the storage object size update', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockPrisma.$transaction).toHaveBeenCalled();
        expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
          where: { id: MEDIA_ID },
          data: expect.objectContaining({
            contentHash: null,
            orientation: 1,
            width: 1536,
            height: 1024,
          }),
        });
      });

      it('merges the _aiEnhanced breadcrumb into existing metadata rather than overwriting it', async () => {
        (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
          makeMediaItem({ metadata: { someExistingKey: 'keepme' } }),
        );

        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        const call = (mockPrisma.mediaItem.update as jest.Mock).mock.calls.find(
          (c: any[]) => c[0].where.id === MEDIA_ID,
        );
        expect(call[0].data.metadata).toMatchObject({
          someExistingKey: 'keepme',
          _aiEnhanced: expect.objectContaining({ model: 'gpt-image-1', enhancementId: ENH_ID }),
        });
      });

      it('reprocesses the (same) storage object after overwrite', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockRecoveryService.reprocessObjectNow).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'obj-1' }),
        );
      });

      it('re-enqueues face_detection when features.faceRecognition is on', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ features: { faceRecognition: true, pictureEnhancement: true } }));

        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'face_detection', mediaItemId: MEDIA_ID, circleId: CIRCLE_ID }),
        );
      });

      it('does NOT re-enqueue face_detection when features.faceRecognition is off', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'face_detection' }),
        );
      });

      it('applies the "AI Enhanced" system tag to the source item', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockPrisma.tag.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { circleId_name: { circleId: CIRCLE_ID, name: 'AI Enhanced' } },
          }),
        );
      });

      it('deletes the staging bytes and finalizes the row as applied/replace', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockActiveProvider.delete).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
        expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
          where: { id: ENH_ID },
          data: {
            status: MediaEnhancementStatus.applied,
            decision: MediaEnhancementDecision.replace,
            stagingStorageKey: null,
            stagingThumbnailKey: null,
          },
        });
      });

      it('throws 400 when replace is disabled by admin policy (allowReplace:false)', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, allowReplace: false } }),
        );

        await expect(service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER)).rejects.toThrow(
          'Replace is disabled by administrator policy',
        );
        expect(mockObjectProvider.upload).not.toHaveBeenCalled();
      });

      it('throws 400 when blockReplaceOnDownscale is set and the enhanced image is smaller', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({
            pictureEnhancement: { ...makeSettings().pictureEnhancement, blockReplaceOnDownscale: true },
          }),
        );
        (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
          makeEnhancementRow({ enhancedWidth: 512, enhancedHeight: 384 }),
        );

        await expect(service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER)).rejects.toThrow(
          /lower resolution than the original/,
        );
        expect(mockObjectProvider.upload).not.toHaveBeenCalled();
      });

      it('allows a downscaled replace when blockReplaceOnDownscale is not set (default)', async () => {
        (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
          makeEnhancementRow({ enhancedWidth: 512, enhancedHeight: 384 }),
        );

        await expect(service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER)).resolves.toBeDefined();
      });

      // Issue #426. gpt-image-1 caps output at ~1.6 MP, so `downscaled` is true
      // for essentially every real photo; treating the guard as absolute made
      // replace permanently unreachable. It is a confirm-through speed bump.
      it('allows a downscaled replace when the caller acknowledges the downscale', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({
            pictureEnhancement: { ...makeSettings().pictureEnhancement, blockReplaceOnDownscale: true },
          }),
        );
        (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
          makeEnhancementRow({ enhancedWidth: 512, enhancedHeight: 384 }),
        );

        await expect(
          service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER, {
            acknowledgeDownscale: true,
          }),
        ).resolves.toBeDefined();
        expect(mockObjectProvider.upload).toHaveBeenCalled();
      });

      it('records the acknowledged override in the audit event', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({
            pictureEnhancement: { ...makeSettings().pictureEnhancement, blockReplaceOnDownscale: true },
          }),
        );
        (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
          makeEnhancementRow({ enhancedWidth: 512, enhancedHeight: 384 }),
        );

        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER, {
          acknowledgeDownscale: true,
        });

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                decision: 'replace',
                downscaled: true,
                downscaleAcknowledged: true,
              }),
            }),
          }),
        );
      });

      // `allowReplace: false` is a HARD policy — no acknowledgement passes it.
      it('still 400s on allowReplace:false even with acknowledgeDownscale', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({
            pictureEnhancement: { ...makeSettings().pictureEnhancement, allowReplace: false },
          }),
        );

        await expect(
          service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER, {
            acknowledgeDownscale: true,
          }),
        ).rejects.toThrow('Replace is disabled by administrator policy');
        expect(mockObjectProvider.upload).not.toHaveBeenCalled();
      });

      // The acknowledgement must not become a blanket "skip the guard" flag —
      // it only ever applies to a result that IS downscaled.
      it('leaves a non-downscaled acknowledged replace unaffected', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({
            pictureEnhancement: { ...makeSettings().pictureEnhancement, blockReplaceOnDownscale: true },
          }),
        );

        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER, {
          acknowledgeDownscale: true,
        });

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                downscaled: false,
                downscaleAcknowledged: false,
              }),
            }),
          }),
        );
      });
    });
  });

  // ===========================================================================
  // discardEnhancement
  // ===========================================================================

  describe('discardEnhancement', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(makeEnhancementRow());
      (mockPrisma.mediaEnhancement.update as jest.Mock).mockResolvedValue({});
    });

    it('asserts circle access at the collaborator level', async () => {
      await service.discardEnhancement(MEDIA_ID, ENH_ID, USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.collaborator,
      );
    });

    it('deletes the staged bytes and marks the row discarded', async () => {
      await service.discardEnhancement(MEDIA_ID, ENH_ID, USER);

      expect(mockActiveProvider.delete).toHaveBeenCalledWith('enhancements/enh-1/result.jpg');
      expect(mockActiveProvider.delete).toHaveBeenCalledWith('enhancements/enh-1/thumb.jpg');
      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: ENH_ID },
        data: {
          status: MediaEnhancementStatus.discarded,
          stagingStorageKey: null,
          stagingThumbnailKey: null,
        },
      });
    });

    it('is a no-op on staging deletion for a row with no staged bytes (already superseded)', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({
          stagingStorageKey: null,
          stagingThumbnailKey: null,
          stagingProvider: null,
        }),
      );

      await service.discardEnhancement(MEDIA_ID, ENH_ID, USER);

      expect(mockActiveProvider.delete).not.toHaveBeenCalled();
      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalled();
    });

    it('propagates a ForbiddenException from RBAC (viewer cannot discard)', async () => {
      mockMembership.assertCircleAccess.mockRejectedValue(new ForbiddenException('viewer cannot write'));

      await expect(service.discardEnhancement(MEDIA_ID, ENH_ID, USER)).rejects.toThrow(ForbiddenException);
    });
  });

  // ===========================================================================
  // listEnhancements (GET /api/media/enhancements — issue #201)
  // ===========================================================================

  describe('listEnhancements', () => {
    function makeListQuery(overrides: Partial<ListEnhancementsQuery> = {}): ListEnhancementsQuery {
      return {
        circleId: CIRCLE_ID,
        page: 1,
        pageSize: 24,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        ...overrides,
      };
    }

    /** Same shape as makeEnhancementRow, plus the `createdBy` relation the `include` pulls in. */
    function makeEnhancementListRow(overrides: Record<string, any> = {}) {
      return {
        ...makeEnhancementRow(),
        createdBy: null,
        ...overrides,
      };
    }

    function makeSourceItem(overrides: Record<string, any> = {}) {
      return {
        id: MEDIA_ID,
        metadata: null,
        originalFilename: 'IMG_0001.jpg',
        capturedAt: new Date('2026-01-01T00:00:00Z'),
        width: 1200,
        height: 900,
        storageObject: { size: BigInt(500_000) },
        ...overrides,
      };
    }

    beforeEach(() => {
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaEnhancement.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
      mockThumbnails.signThumbsBatched.mockResolvedValue(new Map());
      mockThumbnails.extractThumbKey.mockReturnValue(null);
      mockSystemSettings.getSettingValue.mockResolvedValue(168);
    });

    // -------------------------------------------------------------------------
    // 1. Circle access
    // -------------------------------------------------------------------------

    it('asserts circle access at the viewer level before touching the database', async () => {
      await service.listEnhancements(makeListQuery(), USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.viewer,
      );
    });

    it('propagates a ForbiddenException from RBAC without ever calling mediaEnhancement.findMany', async () => {
      mockMembership.assertCircleAccess.mockRejectedValueOnce(new ForbiddenException('not a member'));

      await expect(service.listEnhancements(makeListQuery(), USER)).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.mediaEnhancement.findMany).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // 2. Status alias expansion
    // -------------------------------------------------------------------------

    describe('status filtering', () => {
      it.each<[string, MediaEnhancementStatus[]]>([
        ['in_progress', [MediaEnhancementStatus.pending, MediaEnhancementStatus.processing]],
        ['awaiting_decision', [MediaEnhancementStatus.ready]],
        [
          'terminal',
          [
            MediaEnhancementStatus.applied,
            MediaEnhancementStatus.discarded,
            MediaEnhancementStatus.expired,
          ],
        ],
        ['ready', [MediaEnhancementStatus.ready]],
      ])(
        'expands status=%s into where.status.in for both findMany and count',
        async (status, expectedStatuses) => {
          await service.listEnhancements(
            makeListQuery({ status: status as ListEnhancementsQuery['status'] }),
            USER,
          );

          const expectedWhere = { circleId: CIRCLE_ID, status: { in: expectedStatuses } };
          expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expectedWhere }),
          );
          expect(mockPrisma.mediaEnhancement.count).toHaveBeenCalledWith({ where: expectedWhere });
        },
      );

      it('omits the status key entirely from where when status is not provided', async () => {
        await service.listEnhancements(makeListQuery(), USER);

        expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { circleId: CIRCLE_ID } }),
        );
        expect(mockPrisma.mediaEnhancement.count).toHaveBeenCalledWith({
          where: { circleId: CIRCLE_ID },
        });
      });
    });

    // -------------------------------------------------------------------------
    // 3. Pagination + sort
    // -------------------------------------------------------------------------

    describe('pagination and sort', () => {
      it('derives skip/take from a non-default page/pageSize', async () => {
        await service.listEnhancements(makeListQuery({ page: 3, pageSize: 10 }), USER);

        expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ skip: 20, take: 10 }),
        );
      });

      it('orderBy is [{ createdAt: desc }, { id: desc }] for the default sort', async () => {
        await service.listEnhancements(makeListQuery(), USER);

        expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        );
      });

      it('orderBy reflects a non-default sortBy/sortOrder, still with the id tiebreaker', async () => {
        await service.listEnhancements(makeListQuery({ sortBy: 'updatedAt', sortOrder: 'asc' }), USER);

        expect(mockPrisma.mediaEnhancement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: [{ updatedAt: 'asc' }, { id: 'desc' }] }),
        );
      });

      it('ceils totalPages for a non-exact division of totalItems by pageSize', async () => {
        (mockPrisma.mediaEnhancement.count as jest.Mock).mockResolvedValue(25);

        const result = await service.listEnhancements(makeListQuery({ page: 1, pageSize: 10 }), USER);

        expect(result.meta).toEqual({ page: 1, pageSize: 10, totalItems: 25, totalPages: 3 });
      });
    });

    // -------------------------------------------------------------------------
    // 4. BigInt -> string, JSON.stringify survival
    // -------------------------------------------------------------------------

    it('serializes both size fields as strings and the whole payload survives JSON.stringify', async () => {
      const row = makeEnhancementListRow({
        id: 'enh-1',
        mediaItemId: 'media-a',
        enhancedSize: BigInt(123_456_789_012),
      });
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
        makeSourceItem({ id: 'media-a', storageObject: { size: BigInt(987_654_321_098) } }),
      ]);

      const result = await service.listEnhancements(makeListQuery(), USER);
      const item = result.items[0] as any;

      expect(typeof item.original.size).toBe('string');
      expect(item.original.size).toBe('987654321098');
      expect(typeof item.enhanced.size).toBe('string');
      expect(item.enhanced.size).toBe('123456789012');
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    // -------------------------------------------------------------------------
    // 5. No N+1: one mediaItem.findMany + one signThumbsBatched per page
    // -------------------------------------------------------------------------

    describe('batched loading (no N+1)', () => {
      it('calls mediaItem.findMany and signThumbsBatched exactly once for a page spanning multiple distinct items', async () => {
        const rowA = makeEnhancementListRow({ id: 'enh-a', mediaItemId: 'media-a' });
        const rowB = makeEnhancementListRow({ id: 'enh-b', mediaItemId: 'media-b' });
        const rowC = makeEnhancementListRow({ id: 'enh-c', mediaItemId: 'media-a' }); // shares media-a with rowA
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([rowA, rowB, rowC]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a' }),
          makeSourceItem({ id: 'media-b' }),
        ]);

        await service.listEnhancements(makeListQuery(), USER);

        expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: { in: ['media-a', 'media-b'] } } }),
        );
        expect(mockThumbnails.signThumbsBatched).toHaveBeenCalledTimes(1);
      });

      it('never calls mediaItem.findMany for an empty page', async () => {
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);

        await service.listEnhancements(makeListQuery(), USER);

        expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------------
    // 6. expiresAt + single getSettingValue read per call
    // -------------------------------------------------------------------------

    describe('expiresAt / retention', () => {
      it('sets expiresAt from updatedAt + retentionHours for ready/failed rows, null for every other status, reading the setting exactly once', async () => {
        mockSystemSettings.getSettingValue.mockResolvedValue(48);
        const updatedAt = new Date('2026-01-10T00:00:00Z');

        const rowReady = makeEnhancementListRow({
          id: 'enh-ready',
          mediaItemId: 'm1',
          status: MediaEnhancementStatus.ready,
          updatedAt,
        });
        const rowFailed = makeEnhancementListRow({
          id: 'enh-failed',
          mediaItemId: 'm2',
          status: MediaEnhancementStatus.failed,
          stagingStorageKey: null,
          stagingProvider: null,
          updatedAt,
        });
        const rowPending = makeEnhancementListRow({
          id: 'enh-pending',
          mediaItemId: 'm3',
          status: MediaEnhancementStatus.pending,
          stagingStorageKey: null,
          stagingProvider: null,
          updatedAt,
        });
        const rowApplied = makeEnhancementListRow({
          id: 'enh-applied',
          mediaItemId: 'm4',
          status: MediaEnhancementStatus.applied,
          stagingStorageKey: null,
          stagingProvider: null,
          updatedAt,
        });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
          rowReady,
          rowFailed,
          rowPending,
          rowApplied,
        ]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);

        const result = await service.listEnhancements(makeListQuery(), USER);
        const byId = new Map(result.items.map((i: any) => [i.id, i]));

        expect(mockSystemSettings.getSettingValue).toHaveBeenCalledTimes(1);
        expect(mockSystemSettings.getSettingValue).toHaveBeenCalledWith(
          'pictureEnhancement.retentionHours',
        );

        const expected = new Date(updatedAt.getTime() + 48 * 3_600_000);
        expect((byId.get('enh-ready') as any).expiresAt).toEqual(expected);
        expect((byId.get('enh-failed') as any).expiresAt).toEqual(expected);
        expect((byId.get('enh-pending') as any).expiresAt).toBeNull();
        expect((byId.get('enh-applied') as any).expiresAt).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    // 7. `enhanced` section population rules
    // -------------------------------------------------------------------------

    describe('enhanced section', () => {
      it('populates enhanced.* from staged bytes only when status is ready with staging present', async () => {
        const row = makeEnhancementListRow({ id: 'enh-1', mediaItemId: 'media-a' }); // default: ready + staged
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a' }),
        ]);

        const result = await service.listEnhancements(makeListQuery(), USER);
        const item = result.items[0] as any;

        expect(item.enhanced.thumbnailUrl).toBe('https://cdn.example.com/active-signed');
        expect(item.enhanced.previewUrl).toBe('https://cdn.example.com/active-signed');
        expect(item.enhanced.width).toBe(1536);
        expect(item.enhanced.height).toBe(1024);
        expect(item.enhanced.size).toBe('999999');
      });

      it('signs the THUMBNAIL derivative for thumbnailUrl and the full-resolution staged object for previewUrl (issue #203)', async () => {
        const row = makeEnhancementListRow({ id: 'enh-1', mediaItemId: 'media-a' });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a' }),
        ]);
        // Distinguish the two signed keys so the mapping is asserted, not assumed.
        mockActiveProvider.getSignedDownloadUrl.mockImplementation(
          async (key: string) => `https://cdn.example.com/${key}`,
        );

        const result = await service.listEnhancements(makeListQuery(), USER);
        const item = result.items[0] as any;

        expect(item.enhanced.thumbnailUrl).toBe(
          'https://cdn.example.com/enhancements/enh-1/thumb.jpg',
        );
        expect(item.enhanced.previewUrl).toBe(
          'https://cdn.example.com/enhancements/enh-1/result.jpg',
        );
        // ONE provider resolution for the page, not one per signed key.
        expect(mockResolver.getProviderFor).toHaveBeenCalledTimes(1);
      });

      it('leaves thumbnailUrl null but still returns previewUrl for a row with no thumbnail derivative (pre-#203 / failed render)', async () => {
        const row = makeEnhancementListRow({
          id: 'enh-1',
          mediaItemId: 'media-a',
          stagingThumbnailKey: null,
        });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a' }),
        ]);
        mockActiveProvider.getSignedDownloadUrl.mockImplementation(
          async (key: string) => `https://cdn.example.com/${key}`,
        );

        const result = await service.listEnhancements(makeListQuery(), USER);
        const item = result.items[0] as any;

        expect(item.enhanced.thumbnailUrl).toBeNull();
        expect(item.enhanced.previewUrl).toBe(
          'https://cdn.example.com/enhancements/enh-1/result.jpg',
        );
      });

      it('suppresses enhanced.* to null for a non-ready row even when the row still carries stale enhancedWidth/Height/enhancedSize', async () => {
        const row = makeEnhancementListRow({
          id: 'enh-1',
          mediaItemId: 'media-a',
          status: MediaEnhancementStatus.applied,
          stagingStorageKey: null,
          stagingProvider: null,
          // Stale leftovers from before apply cleared staging — must NOT leak through.
          enhancedWidth: 1536,
          enhancedHeight: 1024,
          enhancedSize: BigInt(999_999),
        });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a' }),
        ]);

        const result = await service.listEnhancements(makeListQuery(), USER);
        const item = result.items[0] as any;

        expect(item.enhanced).toEqual({
          thumbnailUrl: null,
          previewUrl: null,
          width: null,
          height: null,
          size: null,
        });
      });

      it('degrades enhanced.thumbnailUrl to null (without throwing) when signing the staged URL fails, leaving the rest of the page intact', async () => {
        const rowA = makeEnhancementListRow({
          id: 'enh-a',
          mediaItemId: 'media-a',
          stagingStorageKey: 'enhancements/enh-a/result.jpg',
          stagingThumbnailKey: 'enhancements/enh-a/thumb.jpg',
        });
        const rowB = makeEnhancementListRow({
          id: 'enh-b',
          mediaItemId: 'media-b',
          stagingStorageKey: 'enhancements/enh-b/result.jpg',
          stagingThumbnailKey: 'enhancements/enh-b/thumb.jpg',
        });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([rowA, rowB]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a' }),
          makeSourceItem({ id: 'media-b' }),
        ]);
        // First signed key of the page is row A's THUMBNAIL — failing it must
        // degrade that one field only, not the row and not the page.
        mockActiveProvider.getSignedDownloadUrl.mockRejectedValueOnce(new Error('signing exploded'));

        const result = await service.listEnhancements(makeListQuery(), USER);
        const byId = new Map(result.items.map((i: any) => [i.id, i]));

        expect((byId.get('enh-a') as any).enhanced.thumbnailUrl).toBeNull();
        expect((byId.get('enh-a') as any).enhanced.previewUrl).toBe(
          'https://cdn.example.com/active-signed',
        );
        expect((byId.get('enh-b') as any).enhanced.thumbnailUrl).toBe(
          'https://cdn.example.com/active-signed',
        );
      });
    });

    // -------------------------------------------------------------------------
    // 8. `downscaled`
    // -------------------------------------------------------------------------

    describe('downscaled', () => {
      it('is true when the enhanced pixel area is smaller than the (live) item dims', async () => {
        const row = makeEnhancementListRow({
          id: 'enh-1',
          mediaItemId: 'media-a',
          enhancedWidth: 512,
          enhancedHeight: 384,
        });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a', width: 1200, height: 900 }),
        ]);

        const result = await service.listEnhancements(makeListQuery(), USER);
        expect((result.items[0] as any).downscaled).toBe(true);
      });

      it('is false when the enhanced pixel area is not smaller than the (live) item dims', async () => {
        const row = makeEnhancementListRow({ id: 'enh-1', mediaItemId: 'media-a' }); // default 1536x1024 > 1200x900
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
          makeSourceItem({ id: 'media-a', width: 1200, height: 900 }),
        ]);

        const result = await service.listEnhancements(makeListQuery(), USER);
        expect((result.items[0] as any).downscaled).toBe(false);
      });

      it('falls back to the row snapshot originalWidth/Height when the source item no longer exists', async () => {
        const row = makeEnhancementListRow({
          id: 'enh-1',
          mediaItemId: 'missing-item',
          originalWidth: 1200,
          originalHeight: 900,
          enhancedWidth: 512,
          enhancedHeight: 384,
        });
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([row]);
        (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]); // item deleted/missing

        const result = await service.listEnhancements(makeListQuery(), USER);
        const item = result.items[0] as any;

        expect(item.downscaled).toBe(true);
        expect(item.original.width).toBe(1200);
        expect(item.original.height).toBe(900);
        expect(item.original.size).toBeNull();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamFromString(s: string) {
  const { Readable } = require('stream');
  return Readable.from(Buffer.from(s));
}

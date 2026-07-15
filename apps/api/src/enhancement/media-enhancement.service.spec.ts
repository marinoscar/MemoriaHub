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
 *       applied/replace; allowReplace=false 400; downscale-block 400
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
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { EnhanceParams } from './dto/enhance-params.dto';

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
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { getSettings: jest.Mock };

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
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };
    mockSystemSettings = { getSettings: jest.fn().mockResolvedValue(makeSettings()) };

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
      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: 'enh-old' },
        data: { status: MediaEnhancementStatus.discarded, stagingStorageKey: null },
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
          },
        });
      });

      it('returns the new item id, status applied, decision keep_both', async () => {
        const result = await service.applyEnhancement(MEDIA_ID, ENH_ID, 'keep_both', USER);

        expect(result).toEqual({ data: { id: 'new-media-1', status: 'applied', decision: 'keep_both' } });
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
      expect(mockPrisma.mediaEnhancement.update).toHaveBeenCalledWith({
        where: { id: ENH_ID },
        data: { status: MediaEnhancementStatus.discarded, stagingStorageKey: null },
      });
    });

    it('is a no-op on staging deletion for a row with no staged bytes (already superseded)', async () => {
      (mockPrisma.mediaEnhancement.findUnique as jest.Mock).mockResolvedValue(
        makeEnhancementRow({ stagingStorageKey: null, stagingProvider: null }),
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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamFromString(s: string) {
  const { Readable } = require('stream');
  return Readable.from(Buffer.from(s));
}

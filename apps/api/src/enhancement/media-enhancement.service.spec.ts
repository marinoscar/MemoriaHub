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
 *   - startBatchByFilter (issue #424): auth-before-count (information-leak
 *     guard), the three server-pinned predicates (deletedAt/archivedAt/type),
 *     people-filter composition via wherePeople, never-truncate cap refusal
 *     (+ the error envelope through the REAL HttpExceptionFilter), zero-match
 *     400, and delegation to the shared createBatchFrom (source:'filter',
 *     alreadyLive still skipped, priority:50/skipDedup:true)
 */

import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
import { BulkEnhance } from './dto/bulk-enhance.dto';
import { BulkEnhanceByFilter } from './dto/bulk-enhance-by-filter.dto';
import { ListEnhancementsQuery } from './dto/list-enhancements-query.dto';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { buildMediaWhere } from '../search/media-where.builder';

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
        // Required: dedup would otherwise return the superseded row's job.
        skipDedup: true,
        providerKey: 'openai',
        modelVersion: 'gpt-image-1',
        payload: { enhancementId: ENH_ID },
      });
      expect(result).toEqual({ data: { enhancementId: ENH_ID, jobId: 'job-1', status: 'pending' } });
    });

    it('regression: startEnhance enqueues with skipDedup:true (a plain requeue would silently hand back the superseded job)', async () => {
      await service.startEnhance(MEDIA_ID, {}, USER);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ skipDedup: true }),
      );
    });
  });

  // ===========================================================================
  // startBatch (POST /api/media/bulk/enhance — issue #421)
  // ===========================================================================

  describe('startBatch', () => {
    const CIRCLE_ID_2 = 'circle-2';

    /** Bulk-enhance-flavored media item fixture: only the fields createBatchFrom selects. */
    function makeBatchItem(overrides: Record<string, any> = {}) {
      return {
        id: 'media-x',
        circleId: CIRCLE_ID,
        type: MediaType.photo,
        width: 1200,
        height: 900,
        storageObject: { id: 'obj-x', mimeType: 'image/jpeg' },
        ...overrides,
      };
    }

    function makeBulkDto(overrides: Partial<BulkEnhance> = {}): BulkEnhance {
      return {
        circleId: CIRCLE_ID,
        ids: ['media-a', 'media-b'],
        params: {},
        ...overrides,
      } as BulkEnhance;
    }

    /**
     * Wires mediaItem.findMany for BOTH call shapes startBatch's flow uses on the
     * same mock function: assertAllInCircle's existence check (`select: { id: true }`
     * only) and createBatchFrom's full item fetch (everything else). Routing on the
     * select shape — rather than on call order — keeps every test independent of how
     * many times each is invoked.
     */
    function wireMediaItems(items: Array<Record<string, any>>) {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockImplementation(async (args: any) => {
        const ids: string[] = args.where.id.in;
        const selectKeys = args.select ? Object.keys(args.select) : [];
        const isExistenceCheck = selectKeys.length === 1 && selectKeys[0] === 'id';
        const matched = items.filter((i) => ids.includes(i.id));
        return isExistenceCheck ? matched.map((i) => ({ id: i.id })) : matched;
      });
    }

    let createdEnhancementIds: string[];

    beforeEach(() => {
      createdEnhancementIds = [];
      (mockPrisma.mediaEnhancementBatch.create as jest.Mock).mockImplementation(
        async (args: any) => ({ id: 'batch-1', queuedCount: 0, ...args.data }),
      );
      (mockPrisma.mediaEnhancementBatch.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]); // no live rows by default
      (mockPrisma.mediaEnhancement.create as jest.Mock).mockImplementation(async (args: any) => {
        const id = `enh-${args.data.mediaItemId}`;
        createdEnhancementIds.push(id);
        return { id, ...args.data };
      });
      wireMediaItems([makeBatchItem({ id: 'media-a' }), makeBatchItem({ id: 'media-b' })]);
    });

    // -------------------------------------------------------------------------
    // Feature gate / config guards (mirror startEnhance's)
    // -------------------------------------------------------------------------

    it('throws 400 when features.pictureEnhancement is off', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ features: { pictureEnhancement: false } }));

      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow(BadRequestException);
      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow('Picture enhancement is disabled');
      expect(mockMembership.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('throws 400 when PICTURE_ENHANCEMENT_ENABLED=false, even with the feature flag on', async () => {
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';

      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow(BadRequestException);
    });

    it('throws 400 when no enhancement model is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ ai: { features: { enhance: null } } }),
      );

      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow(
        'No enhancement model configured',
      );
    });

    // -------------------------------------------------------------------------
    // Batch-size cap
    // -------------------------------------------------------------------------

    it('throws 400 naming BOTH the requested count and the configured cap when the (deduped) selection exceeds maxBatchSize', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 3 } }),
      );
      const dto = makeBulkDto({ ids: ['m1', 'm2', 'm3', 'm4', 'm5'] });

      await expect(service.startBatch(dto, USER)).rejects.toThrow(BadRequestException);
      await expect(service.startBatch(dto, USER)).rejects.toThrow(
        'Cannot enhance 5 items in one batch; the limit is 3',
      );
      expect(mockMembership.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('falls back to a cap of 25 when pictureEnhancement.maxBatchSize is unset', async () => {
      const dto = makeBulkDto({ ids: Array.from({ length: 26 }, (_, i) => `m${i}`) });

      await expect(service.startBatch(dto, USER)).rejects.toThrow('the limit is 25');
    });

    // -------------------------------------------------------------------------
    // RBAC / existence
    // -------------------------------------------------------------------------

    it('asserts circle access at the collaborator level before touching media items', async () => {
      await service.startBatch(makeBulkDto(), USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.collaborator,
      );
    });

    it('propagates a ForbiddenException from RBAC (non-collaborator)', async () => {
      mockMembership.assertCircleAccess.mockRejectedValue(new ForbiddenException('nope'));

      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException naming ids that are missing or belong to another circle', async () => {
      // Only media-a exists in the circle; media-b does not resolve.
      wireMediaItems([makeBatchItem({ id: 'media-a' })]);

      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow(NotFoundException);
      await expect(service.startBatch(makeBulkDto(), USER)).rejects.toThrow(/media-b/);
      expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Partition logic — each skip reason independently, and every id lands in
    // EXACTLY ONE bucket.
    // -------------------------------------------------------------------------

    describe('partitioning', () => {
      it('counts a non-photo MediaType as notPhoto', async () => {
        wireMediaItems([makeBatchItem({ id: 'media-a', type: MediaType.video })]);

        const result = await service.startBatch(makeBulkDto({ ids: ['media-a'] }), USER);

        expect(result.data.skipped).toEqual({ notPhoto: 1, tooLarge: 0, alreadyLive: 0 });
        expect(result.data.queued).toBe(0);
      });

      it('counts an image/* mimeType mismatch as notPhoto (photo type, non-image storage object)', async () => {
        wireMediaItems([
          makeBatchItem({ id: 'media-a', storageObject: { id: 'obj-x', mimeType: 'application/pdf' } }),
        ]);

        const result = await service.startBatch(makeBulkDto({ ids: ['media-a'] }), USER);

        expect(result.data.skipped).toEqual({ notPhoto: 1, tooLarge: 0, alreadyLive: 0 });
      });

      it('counts an oversized item as tooLarge (maxInputMegapixels exceeded)', async () => {
        // 12000x9000 = 108 MP > default 50 MP cap.
        wireMediaItems([makeBatchItem({ id: 'media-a', width: 12000, height: 9000 })]);

        const result = await service.startBatch(makeBulkDto({ ids: ['media-a'] }), USER);

        expect(result.data.skipped).toEqual({ notPhoto: 0, tooLarge: 1, alreadyLive: 0 });
      });

      it.each([
        ['pending', MediaEnhancementStatus.pending],
        ['processing', MediaEnhancementStatus.processing],
        ['ready', MediaEnhancementStatus.ready],
      ])('counts an item with an existing %s enhancement as alreadyLive', async (_label, status) => {
        wireMediaItems([makeBatchItem({ id: 'media-a' })]);
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
          { mediaItemId: 'media-a' },
        ]);
        void status; // the live-row query only returns mediaItemId — status is asserted via the it.each label

        const result = await service.startBatch(makeBulkDto({ ids: ['media-a'] }), USER);

        expect(result.data.skipped).toEqual({ notPhoto: 0, tooLarge: 0, alreadyLive: 1 });
        expect(result.data.queued).toBe(0);
      });

      it('places every id in exactly one bucket, and the counts sum to `requested`', async () => {
        const items = [
          makeBatchItem({ id: 'notphoto-1', type: MediaType.video }),
          makeBatchItem({ id: 'notphoto-2', storageObject: { id: 'o', mimeType: 'application/pdf' } }),
          makeBatchItem({ id: 'toolarge-1', width: 12000, height: 9000 }),
          makeBatchItem({ id: 'live-1' }),
          makeBatchItem({ id: 'live-2' }),
          makeBatchItem({ id: 'live-3' }),
          makeBatchItem({ id: 'eligible-1' }),
        ];
        wireMediaItems(items);
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
          { mediaItemId: 'live-1' },
          { mediaItemId: 'live-2' },
          { mediaItemId: 'live-3' },
        ]);
        const dto = makeBulkDto({ ids: items.map((i) => i.id) });

        const result = await service.startBatch(dto, USER);

        expect(result.data.skipped).toEqual({ notPhoto: 2, tooLarge: 1, alreadyLive: 3 });
        expect(result.data.queued).toBe(1);
        expect(result.data.requested).toBe(7);
        const sumSkipped = Object.values(result.data.skipped).reduce((a: number, b: any) => a + b, 0);
        expect(sumSkipped + result.data.queued).toBe(result.data.requested);
      });

      it('counts an id that vanishes between the RBAC existence check and the item fetch (a concurrent hard delete) as notPhoto', async () => {
        // assertAllInCircle sees both ids; the createBatchFrom item fetch only
        // resolves media-a — media-b raced away in between.
        (mockPrisma.mediaItem.findMany as jest.Mock).mockImplementation(async (args: any) => {
          const ids: string[] = args.where.id.in;
          const selectKeys = args.select ? Object.keys(args.select) : [];
          const isExistenceCheck = selectKeys.length === 1 && selectKeys[0] === 'id';
          if (isExistenceCheck) return ids.map((id) => ({ id }));
          return [makeBatchItem({ id: 'media-a' })]; // media-b vanished
        });

        const result = await service.startBatch(makeBulkDto({ ids: ['media-a', 'media-b'] }), USER);

        expect(result.data.skipped.notPhoto).toBe(1);
        expect(result.data.queued).toBe(1);
      });
    });

    // -------------------------------------------------------------------------
    // THE ANTI-SUPERSEDE TEST — the criterion most likely to regress silently.
    //
    // A bulk enhance must NEVER call supersedeLive()/deleteStaging() on an
    // item's existing `ready` enhancement: that row is a completed,
    // already-billed gpt-image-1 result awaiting a human keep/replace/discard
    // decision. Losing it silently (and the money that produced it) because
    // the item happened to be re-selected in a later batch is exactly the
    // defect DIVERGENCE 1 in media-enhancement.service.ts exists to prevent.
    // -------------------------------------------------------------------------

    it('NEVER supersedes a live `ready` enhancement: no discard, no staging-key mutation, no provider delete', async () => {
      const liveReadyRow = makeEnhancementRow({
        id: 'enh-live',
        mediaItemId: 'media-a',
        status: MediaEnhancementStatus.ready,
        stagingStorageKey: 'enhancements/enh-live/result.jpg',
        stagingThumbnailKey: 'enhancements/enh-live/thumb.jpg',
      });
      wireMediaItems([makeBatchItem({ id: 'media-a' })]);
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
        { mediaItemId: 'media-a' },
      ]);
      // Sanity: the row is real and would be discarded by supersedeLive() if it ran.
      void liveReadyRow;

      const result = await service.startBatch(makeBulkDto({ ids: ['media-a'] }), USER);

      expect(result.data.skipped.alreadyLive).toBe(1);
      expect(result.data.queued).toBe(0);
      // The staged bytes were never touched.
      expect(mockActiveProvider.delete).not.toHaveBeenCalled();
      expect(mockObjectProvider.delete).not.toHaveBeenCalled();
      // No enhancement row anywhere was updated (discarded or otherwise) —
      // startBatch only ever CREATEs new rows for eligible items.
      expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
      // No new (superseding) enhancement row was created for this item either.
      expect(mockPrisma.mediaEnhancement.create).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Enqueue shape
    // -------------------------------------------------------------------------

    describe('enqueue options', () => {
      it('every enqueued job carries priority:50, skipDedup:true, reason:rerun, type:picture_enhancement, and payload.enhancementId for the row just created', async () => {
        await service.startBatch(makeBulkDto({ ids: ['media-a', 'media-b'] }), USER);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(2);
        for (const call of (mockEnrichmentJobService.enqueue as jest.Mock).mock.calls) {
          const [opts] = call;
          expect(opts).toMatchObject({
            type: 'picture_enhancement',
            reason: 'rerun',
            priority: 50,
            skipDedup: true,
            providerKey: 'openai',
            modelVersion: 'gpt-image-1',
          });
          expect(opts.payload).toEqual({ enhancementId: `enh-${opts.mediaItemId}` });
        }
      });
    });

    // -------------------------------------------------------------------------
    // Dedup of duplicate ids
    // -------------------------------------------------------------------------

    it('dedupes duplicate ids in the request before the cap check, producing one enhancement per unique id', async () => {
      const dto = makeBulkDto({ ids: ['media-a', 'media-a', 'media-b'] });

      const result = await service.startBatch(dto, USER);

      expect(result.data.requested).toBe(2);
      expect(result.data.queued).toBe(2);
      expect(mockPrisma.mediaEnhancement.create).toHaveBeenCalledTimes(2);
      // assertAllInCircle's existence check also only ever sees the 2 unique ids.
      const existenceCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls.find(
        (c: any[]) => c[0].select && Object.keys(c[0].select).length === 1 && c[0].select.id === true,
      );
      expect(existenceCall![0].where.id.in).toEqual(['media-a', 'media-b']);
    });

    // -------------------------------------------------------------------------
    // Zero-eligible edge case
    // -------------------------------------------------------------------------

    it('creates the batch row and returns queued:0 when nothing is eligible', async () => {
      wireMediaItems([makeBatchItem({ id: 'media-a', type: MediaType.video })]);

      const result = await service.startBatch(makeBulkDto({ ids: ['media-a'] }), USER);

      expect(mockPrisma.mediaEnhancementBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          circleId: CIRCLE_ID,
          requestedCount: 1,
          queuedCount: 0,
          source: 'selection',
          createdById: USER.id,
        }),
      });
      expect(result).toEqual({
        data: {
          batchId: 'batch-1',
          requested: 1,
          queued: 0,
          skipped: { notPhoto: 1, tooLarge: 0, alreadyLive: 0 },
        },
      });
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('uses CIRCLE_ID_2 to prove the batch row is scoped to dto.circleId, not a hard-coded default', async () => {
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.collaborator,
        isSuperAdmin: false,
      });
      wireMediaItems([makeBatchItem({ id: 'media-a', circleId: CIRCLE_ID_2 })]);

      await service.startBatch(makeBulkDto({ circleId: CIRCLE_ID_2, ids: ['media-a'] }), USER);

      expect(mockPrisma.mediaEnhancementBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ circleId: CIRCLE_ID_2 }),
      });
    });
  });

  // ===========================================================================
  // startBatchByFilter (POST /api/media/bulk/enhance/by-filter — issue #424)
  // ===========================================================================

  describe('startBatchByFilter', () => {
    /** Bulk-enhance-flavored media item fixture, same shape as startBatch's. */
    function makeFilterBatchItem(overrides: Record<string, any> = {}) {
      return {
        id: 'media-x',
        circleId: CIRCLE_ID,
        type: MediaType.photo,
        width: 1200,
        height: 900,
        storageObject: { id: 'obj-x', mimeType: 'image/jpeg' },
        ...overrides,
      };
    }

    function makeFilterDto(overrides: Partial<BulkEnhanceByFilter> = {}): BulkEnhanceByFilter {
      return {
        circleId: CIRCLE_ID,
        params: {},
        ...overrides,
      } as BulkEnhanceByFilter;
    }

    /**
     * Wires `mediaItem.count` / `mediaItem.findMany` for the by-filter flow's
     * TWO distinct findMany call shapes on the same mock function:
     *   1. `resolveFilterWhere`'s own match-id fetch — `select: { id: true }`,
     *      `where` is the RESOLVED FILTER (no `where.id.in`).
     *   2. `createBatchFrom`'s full item fetch — `where: { id: { in: ids } }`.
     * Routed on `where.id.in` presence rather than call order, so every test
     * stays independent of how many times each is invoked. Also captures the
     * LAST `where` passed to `count`/the id-only `findMany`, so a test can
     * assert on the actual resolved Prisma filter.
     */
    let lastFilterWhere: any;
    function wireFilterItems(matchedItems: Array<Record<string, any>>) {
      (mockPrisma.mediaItem.count as jest.Mock).mockImplementation(async (args: any) => {
        lastFilterWhere = args.where;
        return matchedItems.length;
      });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockImplementation(async (args: any) => {
        if (args.where?.id?.in) {
          const ids: string[] = args.where.id.in;
          return matchedItems.filter((i) => ids.includes(i.id));
        }
        lastFilterWhere = args.where;
        return matchedItems.map((i) => ({ id: i.id }));
      });
    }

    beforeEach(() => {
      lastFilterWhere = undefined;
      (mockPrisma.mediaEnhancementBatch.create as jest.Mock).mockImplementation(
        async (args: any) => ({ id: 'batch-1', queuedCount: 0, ...args.data }),
      );
      (mockPrisma.mediaEnhancementBatch.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]); // no live rows by default
      (mockPrisma.mediaEnhancement.create as jest.Mock).mockImplementation(async (args: any) => ({
        id: `enh-${args.data.mediaItemId}`,
        ...args.data,
      }));
      wireFilterItems([makeFilterBatchItem({ id: 'media-a' }), makeFilterBatchItem({ id: 'media-b' })]);
    });

    // -------------------------------------------------------------------------
    // Feature gate / config guards (mirror startBatch's / startEnhance's)
    // -------------------------------------------------------------------------

    it('throws 400 when features.pictureEnhancement is off', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(makeSettings({ features: { pictureEnhancement: false } }));

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(BadRequestException);
      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow('Picture enhancement is disabled');
      expect(mockMembership.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('throws 400 when PICTURE_ENHANCEMENT_ENABLED=false, even with the feature flag on', async () => {
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(BadRequestException);
    });

    it('throws 400 when no enhancement model is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ ai: { features: { enhance: null } } }),
      );

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        'No enhancement model configured',
      );
    });

    // -------------------------------------------------------------------------
    // Authorization runs BEFORE the count — an information-leak guard.
    //
    // Unlike startBatch's cap check (a pure count of client-supplied ids),
    // startBatchByFilter's cap check requires COUNTING ROWS IN THE CIRCLE.
    // Reporting `matchedCount` to a caller who turns out not to be a member
    // would leak how many photos the circle holds under a given filter. If a
    // future edit reorders this, a non-member could learn the circle's size
    // through the over-cap 400's `matchedCount` before ever being told they
    // lack access.
    // -------------------------------------------------------------------------

    describe('authorization precedes the count (information-leak guard)', () => {
      it('propagates ForbiddenException from RBAC and NEVER calls mediaItem.count', async () => {
        mockMembership.assertCircleAccess.mockRejectedValue(new ForbiddenException('nope'));

        await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(ForbiddenException);

        expect(mockPrisma.mediaItem.count).not.toHaveBeenCalled();
        expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
      });

      it('asserts circle access at the collaborator level, scoped to dto.circleId', async () => {
        await service.startBatchByFilter(makeFilterDto(), USER);

        expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
          USER.id,
          CIRCLE_ID,
          USER.permissions,
          CircleRole.collaborator,
        );
      });
    });

    // -------------------------------------------------------------------------
    // The three server-pinned predicates — each independently, per the task's
    // explicit call-out. None may be implied by another: an over-eager reader
    // could conflate `archivedAt: null` with `excludeArchived`, or assume
    // `deletedAt: null` is redundant with buildMediaWhere's own base shape.
    // -------------------------------------------------------------------------

    describe('server-pinned predicates', () => {
      it('THE HIGH-CONSEQUENCE GUARD: pins deletedAt: null so a by-filter enhance never re-renders trashed photos', async () => {
        await service.startBatchByFilter(makeFilterDto(), USER);

        expect(lastFilterWhere).toMatchObject({ deletedAt: null });
      });

      it('pins archivedAt: null independently of any `excludeArchived` flag (which is never forwarded to buildMediaWhere here)', async () => {
        await service.startBatchByFilter(makeFilterDto(), USER);

        expect(lastFilterWhere).toMatchObject({ archivedAt: null });
      });

      it('pins type: photo IN THE SQL — never a post-filter — so the reported count equals what would actually run', async () => {
        await service.startBatchByFilter(makeFilterDto(), USER);

        expect(lastFilterWhere).toMatchObject({ type: MediaType.photo });
        // The SAME where object (with the photo pin already applied) is reused
        // for the subsequent findMany that resolves the match ids — there is
        // no separate, unpinned query anywhere in the flow.
        expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ type: MediaType.photo }) }),
        );
      });

      it('a caller who explicitly filters type: video still gets the type:photo pin — the where ANDs an impossible video=photo condition rather than silently dropping the pin', async () => {
        await service.startBatchByFilter(makeFilterDto({ type: 'video' as any }), USER);

        // The server pin always wins as a top-level key; buildMediaWhere's own
        // AND array separately carries the caller's `type: 'video'` fragment —
        // together an unsatisfiable AND, which is the HONEST outcome (a real
        // DB would return zero rows for it), never a silently-ignored filter.
        expect(lastFilterWhere.type).toBe(MediaType.photo);
        expect(lastFilterWhere.AND).toEqual(
          expect.arrayContaining([{ type: 'video' }]),
        );
      });

      it('a filter matching zero rows (e.g. type: video against real data) is the honest "no photos match" 400, never silently ignored', async () => {
        wireFilterItems([]); // simulates the DB engine returning zero rows for the contradiction above
        const dto = makeFilterDto({ type: 'video' as any });

        await expect(service.startBatchByFilter(dto, USER)).rejects.toThrow('No photos match this filter');
      });
    });

    // -------------------------------------------------------------------------
    // Filter parity: EVERY mediaFilterFields key resolveFilterWhere destructures
    // must reach buildMediaWhere unchanged. A field added to the DTO/registry but
    // forgotten in the passthrough is the realistic failure this guards against —
    // it would silently widen the match set (the field is accepted but never
    // filters anything), the exact failure class this endpoint's whole "never
    // surprise the user with an unseen match" design exists to prevent.
    //
    // Rather than hand-modeling what each field does to the where clause (fragile
    // and duplicative of media-where.builder's own tests), this computes the
    // REAL buildMediaWhere(...) output for the identical filter subset and
    // diffs it against what startBatchByFilter actually sent — proving true 1:1
    // passthrough rather than merely "some filtering happened".
    // -------------------------------------------------------------------------

    it('forwards EVERY mediaFilterFields key (type/dates/album/favorite/tag/geo/hash/camera/device/missing-*/noFaces) to buildMediaWhere unchanged', async () => {
      const filterSubset = {
        type: 'photo' as const,
        capturedAtFrom: new Date('2024-01-01T00:00:00Z'),
        capturedAtTo: new Date('2024-12-31T00:00:00Z'),
        albumId: 'album-1',
        favorite: true,
        tag: 'Beach',
        country: 'Costa Rica',
        region: 'San José',
        locality: 'Escazú',
        place: 'Central Park',
        location: 'somewhere',
        contentHash: 'hash123',
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15',
        sourceDeviceId: 'device-1',
        sourceDeviceName: 'My Phone',
        missingGeo: true,
        missingCapturedAt: true,
        missingCamera: true,
        noFaces: true,
      };

      await service.startBatchByFilter(makeFilterDto({ circleId: CIRCLE_ID, ...filterSubset }), USER);

      const expectedFromBuildMediaWhere = buildMediaWhere(CIRCLE_ID, filterSubset);

      // resolveFilterWhere's ONLY divergence from a bare buildMediaWhere(...) call
      // is the addition of `archivedAt: null` and the top-level `type` override
      // (deletedAt is already `null` in buildMediaWhere's own base shape, so
      // pinning it again is a same-value no-op) — every filter fragment must be
      // otherwise byte-identical.
      expect(lastFilterWhere).toEqual({
        ...expectedFromBuildMediaWhere,
        archivedAt: null,
        type: MediaType.photo,
      });
    });

    // -------------------------------------------------------------------------
    // People-filter composition via wherePeople (peopleMatch: 'all' | 'any')
    // -------------------------------------------------------------------------

    describe('people filter composition', () => {
      it('mode "any" composes a `faces.some.personId.in` clause alongside the server-pinned predicates', async () => {
        const dto = makeFilterDto({ personIds: ['person-1', 'person-2'], peopleMatch: 'any' });

        await service.startBatchByFilter(dto, USER);

        expect(lastFilterWhere).toMatchObject({
          faces: { some: { personId: { in: ['person-1', 'person-2'] } } },
          deletedAt: null,
          archivedAt: null,
          type: MediaType.photo,
        });
      });

      it('mode "all" AND-composes one faces.some clause per person id', async () => {
        const dto = makeFilterDto({ personIds: ['person-1', 'person-2'], peopleMatch: 'all' });

        await service.startBatchByFilter(dto, USER);

        expect(lastFilterWhere.AND).toEqual([
          { faces: { some: { personId: 'person-1' } } },
          { faces: { some: { personId: 'person-2' } } },
        ]);
      });

      it('a single `personId` (no `personIds` array) is folded into a one-element people filter', async () => {
        const dto = makeFilterDto({ personId: 'person-solo', peopleMatch: 'any' });

        await service.startBatchByFilter(dto, USER);

        expect(lastFilterWhere).toMatchObject({
          faces: { some: { personId: { in: ['person-solo'] } } },
        });
      });

      it('defaults to mode "any" when peopleMatch is omitted', async () => {
        const dto = makeFilterDto({ personIds: ['person-1'] });
        delete (dto as any).peopleMatch;

        await service.startBatchByFilter(dto, USER);

        expect(lastFilterWhere).toMatchObject({
          faces: { some: { personId: { in: ['person-1'] } } },
        });
      });

      it('no people filter is added when neither personId nor personIds is supplied', async () => {
        await service.startBatchByFilter(makeFilterDto(), USER);

        expect(lastFilterWhere).not.toHaveProperty('faces');
      });
    });

    // -------------------------------------------------------------------------
    // Cap refusal — NEVER truncated
    // -------------------------------------------------------------------------

    describe('cap refusal (never truncates)', () => {
      it('refuses with 400 naming BOTH matchedCount and maxBatchSize when the filter matches more than the cap', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 3 } }),
        );
        wireFilterItems(
          Array.from({ length: 5 }, (_, i) => makeFilterBatchItem({ id: `m${i}` })),
        );

        await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(BadRequestException);
        await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
          '5 photos match this filter; the limit is 3 per batch.',
        );
      });

      it('NEVER creates a batch row and NEVER enqueues a job when the match exceeds the cap', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 3 } }),
        );
        wireFilterItems(
          Array.from({ length: 5 }, (_, i) => makeFilterBatchItem({ id: `m${i}` })),
        );

        await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(BadRequestException);

        expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
        expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
        // Nor does it ever fetch the full match set — the over-cap check
        // happens strictly before the (potentially large) findMany.
        expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
      });

      it('does NOT truncate to the first maxBatchSize matches — there is no silent partial batch', async () => {
        mockSystemSettings.getSettings.mockResolvedValue(
          makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 2 } }),
        );
        wireFilterItems([
          makeFilterBatchItem({ id: 'm0' }),
          makeFilterBatchItem({ id: 'm1' }),
          makeFilterBatchItem({ id: 'm2' }),
        ]);

        let caught: unknown;
        try {
          await service.startBatchByFilter(makeFilterDto(), USER);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BadRequestException);
        expect(mockPrisma.mediaEnhancement.create).not.toHaveBeenCalled();
      });

      it('falls back to a cap of 25 when pictureEnhancement.maxBatchSize is unset', async () => {
        wireFilterItems(Array.from({ length: 26 }, (_, i) => makeFilterBatchItem({ id: `m${i}` })));

        await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow('the limit is 25');
      });
    });

    // -------------------------------------------------------------------------
    // Zero-match — a 400, never an empty batch
    // -------------------------------------------------------------------------

    it('throws 400 "No photos match this filter" when nothing matches, and creates no batch', async () => {
      wireFilterItems([]);

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        'No photos match this filter',
      );
      expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Delegation to the shared createBatchFrom internals — source: 'filter',
    // and the alreadyLive skip still applies (never superseded).
    // -------------------------------------------------------------------------

    describe('delegation to createBatchFrom (shared with startBatch)', () => {
      it('creates the batch with source: "filter" and a provenance snapshot of the resolved filter under params._filter', async () => {
        const dto = makeFilterDto({ tag: 'Beach', favorite: true });

        await service.startBatchByFilter(dto, USER);

        expect(mockPrisma.mediaEnhancementBatch.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            circleId: CIRCLE_ID,
            source: 'filter',
            requestedCount: 2,
            params: expect.objectContaining({
              _filter: expect.objectContaining({ tag: 'Beach', favorite: true }),
            }),
          }),
        });
      });

      it('an item with an existing live enhancement is skipped and counted as alreadyLive, never superseded (filter source too)', async () => {
        wireFilterItems([makeFilterBatchItem({ id: 'media-a' })]);
        (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
          { mediaItemId: 'media-a' },
        ]);

        const result = await service.startBatchByFilter(makeFilterDto(), USER);

        expect(result.data.skipped).toEqual({ notPhoto: 0, tooLarge: 0, alreadyLive: 1 });
        expect(result.data.queued).toBe(0);
        expect(mockActiveProvider.delete).not.toHaveBeenCalled();
        expect(mockObjectProvider.delete).not.toHaveBeenCalled();
        expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
      });

      it('an oversized match is skipped as tooLarge, same partition rule as startBatch', async () => {
        wireFilterItems([makeFilterBatchItem({ id: 'media-a', width: 12000, height: 9000 })]);

        const result = await service.startBatchByFilter(makeFilterDto(), USER);

        expect(result.data.skipped).toEqual({ notPhoto: 0, tooLarge: 1, alreadyLive: 0 });
      });
    });

    // -------------------------------------------------------------------------
    // Enqueue shape — priority: 50, skipDedup: true (bulk, not interactive)
    // -------------------------------------------------------------------------

    describe('enqueue options', () => {
      it('every enqueued job carries priority:50 and skipDedup:true, matching startBatch', async () => {
        await service.startBatchByFilter(makeFilterDto(), USER);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(2);
        for (const call of (mockEnrichmentJobService.enqueue as jest.Mock).mock.calls) {
          const [opts] = call;
          expect(opts).toMatchObject({
            type: 'picture_enhancement',
            reason: 'rerun',
            priority: 50,
            skipDedup: true,
          });
        }
      });
    });
  });

  // ===========================================================================
  // startBatchByFilter — error envelope through the REAL HttpExceptionFilter
  //
  // The over-cap 400 carries `details.matchedCount`/`details.maxBatchSize`.
  // `HttpExceptionFilter` rebuilds every response body from a FIXED KEY
  // ALLOWLIST (message, code, details, error, error_description, startedAt),
  // so a payload field proven present only via `err.getResponse()` can still be
  // silently dropped on the wire. This is a documented repo gotcha (CLAUDE.md
  // "Gotchas / Lessons Learned") that has bitten this exact shape before
  // (issue #343's `activeRunId`). Harness mirrors
  // db-backup-admin.service.spec.ts's `sendThroughFilter`.
  // ===========================================================================

  describe('startBatchByFilter — over-cap error envelope (HttpExceptionFilter)', () => {
    function sendThroughFilter(exception: unknown): any {
      const response = {
        code: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
      };
      const host = {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => ({ url: '/api/media/bulk/enhance/by-filter', method: 'POST' }),
        }),
      } as unknown as ArgumentsHost;

      new HttpExceptionFilter().catch(exception, host);
      return response.send.mock.calls[0][0];
    }

    it('the SERIALIZED response body (post-filter) carries details.matchedCount and details.maxBatchSize', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 3 } }),
      );
      (mockPrisma.mediaItem.count as jest.Mock).mockResolvedValue(7);
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);

      let caught: unknown;
      try {
        await service.startBatchByFilter(
          { circleId: CIRCLE_ID, params: {} } as BulkEnhanceByFilter,
          USER,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);

      const wireBody = sendThroughFilter(caught);
      expect(wireBody.details).toEqual({ matchedCount: 7, maxBatchSize: 3 });
      // Sanity that getResponse() alone would have looked fine too — the point
      // is that BOTH must be checked, not that getResponse() lies.
      expect((caught as BadRequestException).getResponse()).toMatchObject({
        details: { matchedCount: 7, maxBatchSize: 3 },
      });
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

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

import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole, MediaEnhancementStatus, MediaEnhancementDecision, MediaType, MediaTagSource } from '@prisma/client';
import { MediaEnhancementService } from './media-enhancement.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProcessingRecoveryService } from '../storage/tasks/storage-processing-recovery.service';
import { ThumbnailPruneService } from '../storage/processing/thumbnail-prune.service';
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

/**
 * Run a thrown exception through the REAL app-wide `HttpExceptionFilter` and
 * return the body the client would actually receive.
 *
 * Load-bearing for issue #424's over-the-cap 400: the filter rebuilds every
 * response from a fixed allowlist (message, code, details, error,
 * error_description, startedAt), so a payload field asserted only via
 * `getResponse()` can still be silently dropped on the wire. Copied from the
 * harness in `db-backup/db-backup-admin.service.spec.ts`, which in turn mirrors
 * `common/filters/http-exception.filter.spec.ts`.
 */
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
  let mockThumbnailPrune: { pruneSupersededThumbnails: jest.Mock };
  /** Records sync-vs-prune ordering on the replace path (issue #434). */
  let replaceCallOrder: string[];
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
    replaceCallOrder = [];
    mockMetadataSync = {
      syncFromStorageObject: jest.fn().mockImplementation(async () => {
        replaceCallOrder.push('sync');
      }),
    };
    mockThumbnailPrune = {
      pruneSupersededThumbnails: jest.fn().mockImplementation(async () => {
        replaceCallOrder.push('prune');
        return 1;
      }),
    };
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
        { provide: ThumbnailPruneService, useValue: mockThumbnailPrune },
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
  //
  // The matched set is resolved server-side, so the WHERE clause is the whole
  // safety story: every photo it matches costs a real, billed gpt-image-1 call.
  // These tests assert the clause itself (trash / archive / video exclusion,
  // people composition), the refuse-never-truncate cap, and that everything
  // downstream is DELEGATED to the same createBatchFrom internals startBatch
  // uses rather than reimplemented.
  // ===========================================================================

  describe('startBatchByFilter', () => {
    /** Same shape createBatchFrom selects (see makeBatchItem in startBatch). */
    function makeFilterItem(overrides: Record<string, any> = {}) {
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

    function makeFilterDto(overrides: Record<string, any> = {}): BulkEnhanceByFilter {
      return {
        circleId: CIRCLE_ID,
        params: {},
        peopleMatch: 'any',
        ...overrides,
      } as BulkEnhanceByFilter;
    }

    /**
     * Wires the count + both findMany shapes off ONE in-memory item list:
     *
     *  - `count`    -> startBatchByFilter's cap/zero-match check
     *  - findMany with `select: { id: true }` -> the id resolution
     *  - findMany with the full select        -> createBatchFrom's item fetch
     *
     * The where clause is captured (not interpreted) so the tests can assert it
     * directly; that is the point of this suite.
     */
    let capturedWhere: any;
    function wireFilterMatches(items: Array<Record<string, any>>) {
      capturedWhere = undefined;
      (mockPrisma.mediaItem.count as jest.Mock).mockImplementation(async (args: any) => {
        capturedWhere = args.where;
        return items.length;
      });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockImplementation(async (args: any) => {
        const selectKeys = args.select ? Object.keys(args.select) : [];
        const idsOnly = selectKeys.length === 1 && selectKeys[0] === 'id';
        if (idsOnly && !args.where?.id) {
          // The by-filter id resolution (filter where, not an id list).
          capturedWhere = args.where;
          return items.map((i) => ({ id: i.id }));
        }
        const ids: string[] = args.where?.id?.in ?? items.map((i) => i.id);
        return items.filter((i) => ids.includes(i.id));
      });
    }

    beforeEach(() => {
      (mockPrisma.mediaEnhancementBatch.create as jest.Mock).mockImplementation(
        async (args: any) => ({ id: 'batch-f1', queuedCount: 0, ...args.data }),
      );
      (mockPrisma.mediaEnhancementBatch.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.mediaEnhancement.create as jest.Mock).mockImplementation(async (args: any) => ({
        id: `enh-${args.data.mediaItemId}`,
        ...args.data,
      }));
      wireFilterMatches([makeFilterItem({ id: 'media-a' }), makeFilterItem({ id: 'media-b' })]);
    });

    // -------------------------------------------------------------------------
    // THE TRASH TEST — highest-consequence regression in this feature.
    //
    // buildMediaWhere's `excludeArchived` flag governs ONLY archivedAt, and its
    // deletedAt handling is an incidental detail of that builder rather than a
    // contract this endpoint may lean on. A by-filter enhance that reaches into
    // the Trash does not render a wrong pixel — it spends real money on photos
    // the user already threw away.
    // -------------------------------------------------------------------------

    it('EXCLUDES trashed items: the matched-set where asserts deletedAt: null explicitly', async () => {
      await service.startBatchByFilter(makeFilterDto(), USER);

      expect(capturedWhere).toMatchObject({ deletedAt: null });
      // And on the count query specifically — the number shown to the user and
      // checked against the cap must come from the same restricted set.
      const countWhere = (mockPrisma.mediaItem.count as jest.Mock).mock.calls[0][0].where;
      expect(countWhere.deletedAt).toBeNull();
    });

    it('EXCLUDES archived items: the matched-set where asserts archivedAt: null explicitly', async () => {
      await service.startBatchByFilter(makeFilterDto(), USER);

      expect(capturedWhere).toMatchObject({ archivedAt: null });
      const countWhere = (mockPrisma.mediaItem.count as jest.Mock).mock.calls[0][0].where;
      expect(countWhere.archivedAt).toBeNull();
    });

    it('EXCLUDES videos in SQL (type: photo on the where), not as a post-filter', async () => {
      await service.startBatchByFilter(makeFilterDto(), USER);

      expect(capturedWhere).toMatchObject({ type: MediaType.photo });
      // The cap is checked against the same photo-only count, so it cannot lie.
      const countWhere = (mockPrisma.mediaItem.count as jest.Mock).mock.calls[0][0].where;
      expect(countWhere.type).toBe(MediaType.photo);
    });

    // -------------------------------------------------------------------------
    // Filter composition
    // -------------------------------------------------------------------------

    it('AND-composes the buildMediaWhere fragment rather than spreading it, so a people clause cannot clobber it', async () => {
      await service.startBatchByFilter(
        makeFilterDto({ tag: 'birthday', personIds: ['p1', 'p2'], peopleMatch: 'all' }),
        USER,
      );

      // Both fragments survive as SEPARATE AND elements. A spread-merge would
      // have let wherePeople's own top-level AND overwrite the tag filter.
      const and = capturedWhere.AND as any[];
      expect(and).toHaveLength(2);
      const flat = JSON.stringify(and);
      expect(flat).toContain('birthday');
      expect(flat).toContain('p1');
      expect(flat).toContain('p2');
    });

    it("composes peopleMatch:'all' as one faces.some clause per person (every person in the same photo)", async () => {
      await service.startBatchByFilter(
        makeFilterDto({ personIds: ['p1', 'p2'], peopleMatch: 'all' }),
        USER,
      );

      const people = (capturedWhere.AND as any[]).find((f) => f.AND);
      expect(people.AND).toEqual([
        { faces: { some: { personId: 'p1' } } },
        { faces: { some: { personId: 'p2' } } },
      ]);
    });

    it("composes peopleMatch:'any' as a single personId IN clause", async () => {
      await service.startBatchByFilter(
        makeFilterDto({ personIds: ['p1', 'p2'], peopleMatch: 'any' }),
        USER,
      );

      const people = (capturedWhere.AND as any[]).find((f) => f.faces);
      expect(people).toEqual({ faces: { some: { personId: { in: ['p1', 'p2'] } } } });
    });

    it('falls back to the singular personId when personIds is absent', async () => {
      await service.startBatchByFilter(makeFilterDto({ personId: 'p9' }), USER);

      const flat = JSON.stringify(capturedWhere.AND);
      expect(flat).toContain('p9');
    });

    it('adds no people fragment at all when neither personId nor personIds is supplied', async () => {
      await service.startBatchByFilter(makeFilterDto({ tag: 'beach' }), USER);

      expect((capturedWhere.AND as any[]).some((f) => JSON.stringify(f).includes('personId'))).toBe(
        false,
      );
    });

    // -------------------------------------------------------------------------
    // Gates (identical to the by-selection endpoint's)
    // -------------------------------------------------------------------------

    it('throws 400 when features.pictureEnhancement is off, before any query runs', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ features: { pictureEnhancement: false } }),
      );

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        'Picture enhancement is disabled',
      );
      expect(mockMembership.assertCircleAccess).not.toHaveBeenCalled();
      expect(mockPrisma.mediaItem.count).not.toHaveBeenCalled();
    });

    it('throws 400 when PICTURE_ENHANCEMENT_ENABLED=false, even with the feature flag on', async () => {
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws 400 when no enhancement model is configured', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ ai: { features: { enhance: null } } }),
      );

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        'No enhancement model configured',
      );
    });

    it('asserts collaborator access BEFORE running any query on the caller behalf', async () => {
      mockMembership.assertCircleAccess.mockRejectedValue(new ForbiddenException('nope'));

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.mediaItem.count).not.toHaveBeenCalled();
      expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
    });

    it('asserts circle access at the collaborator level', async () => {
      await service.startBatchByFilter(makeFilterDto(), USER);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER.id,
        CIRCLE_ID,
        USER.permissions,
        CircleRole.collaborator,
      );
    });

    // -------------------------------------------------------------------------
    // Zero-match and cap — refuse, never truncate
    // -------------------------------------------------------------------------

    it('throws 400 when the filter matches nothing, without creating a batch row', async () => {
      wireFilterMatches([]);

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        'No photos match this filter',
      );
      expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('REFUSES a filter matching more than maxBatchSize, naming both numbers — never truncating to the first N', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 3 } }),
      );
      wireFilterMatches(
        Array.from({ length: 7 }, (_, i) => makeFilterItem({ id: `media-${i}` })),
      );

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        '7 photos match this filter; the limit is 3 per batch.',
      );
      // The whole point of refusing: nothing was queued, nothing was billed.
      expect(mockPrisma.mediaEnhancementBatch.create).not.toHaveBeenCalled();
      expect(mockPrisma.mediaEnhancement.create).not.toHaveBeenCalled();
      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('falls back to a cap of 25 when pictureEnhancement.maxBatchSize is unset', async () => {
      wireFilterMatches(
        Array.from({ length: 26 }, (_, i) => makeFilterItem({ id: `media-${i}` })),
      );

      await expect(service.startBatchByFilter(makeFilterDto(), USER)).rejects.toThrow(
        '26 photos match this filter; the limit is 25 per batch.',
      );
    });

    it('accepts a match count exactly AT the cap (the boundary is inclusive)', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 2 } }),
      );

      const result = await service.startBatchByFilter(makeFilterDto(), USER);

      expect(result.data.queued).toBe(2);
    });

    // -------------------------------------------------------------------------
    // THE ERROR-ENVELOPE TEST — asserted THROUGH the real HttpExceptionFilter.
    //
    // A getResponse() assertion proves nothing about the wire: the filter
    // rebuilds every body from a fixed key allowlist (message, code, details,
    // error, error_description, startedAt), so a top-level `matchedCount` would
    // pass a naive unit test and still be silently dropped for the client that
    // needs it to render "412 photos match; the limit is 25".
    // -------------------------------------------------------------------------

    it('carries matchedCount and maxBatchSize under `details` THROUGH the real HttpExceptionFilter', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(
        makeSettings({ pictureEnhancement: { ...makeSettings().pictureEnhancement, maxBatchSize: 3 } }),
      );
      wireFilterMatches(
        Array.from({ length: 7 }, (_, i) => makeFilterItem({ id: `media-${i}` })),
      );

      let thrown: unknown;
      try {
        await service.startBatchByFilter(makeFilterDto(), USER);
      } catch (err) {
        thrown = err;
      }

      const body = sendThroughFilter(thrown);
      expect(body).toMatchObject({
        statusCode: 400,
        message: '7 photos match this filter; the limit is 3 per batch.',
        details: { matchedCount: 7, maxBatchSize: 3 },
      });
    });

    // -------------------------------------------------------------------------
    // Delegation — the by-filter path owns "which items" and nothing else.
    // -------------------------------------------------------------------------

    it('delegates to the shared createBatchFrom internals: same response shape, same skip partition, source `filter`', async () => {
      wireFilterMatches([
        makeFilterItem({ id: 'ok-1' }),
        makeFilterItem({ id: 'toolarge-1', width: 12000, height: 9000 }),
      ]);

      const result = await service.startBatchByFilter(makeFilterDto(), USER);

      expect(result).toEqual({
        data: {
          batchId: 'batch-f1',
          requested: 2,
          queued: 1,
          skipped: { notPhoto: 0, tooLarge: 1, alreadyLive: 0 },
        },
      });
      expect(mockPrisma.mediaEnhancementBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          circleId: CIRCLE_ID,
          requestedCount: 2,
          source: 'filter',
          createdById: USER.id,
        }),
      });
    });

    it('still applies the alreadyLive skip — a filter cannot know which photos already have an unreviewed result', async () => {
      wireFilterMatches([makeFilterItem({ id: 'media-a' })]);
      (mockPrisma.mediaEnhancement.findMany as jest.Mock).mockResolvedValue([
        { mediaItemId: 'media-a' },
      ]);

      const result = await service.startBatchByFilter(makeFilterDto(), USER);

      expect(result.data.skipped.alreadyLive).toBe(1);
      expect(result.data.queued).toBe(0);
      // The staged bytes of the live row were never touched (see the anti-
      // supersede test on startBatch — the same rule applies here).
      expect(mockActiveProvider.delete).not.toHaveBeenCalled();
      expect(mockPrisma.mediaEnhancement.update).not.toHaveBeenCalled();
    });

    it('enqueues at priority 50 with skipDedup, exactly like the by-selection batch', async () => {
      await service.startBatchByFilter(makeFilterDto(), USER);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledTimes(2);
      for (const [opts] of (mockEnrichmentJobService.enqueue as jest.Mock).mock.calls) {
        expect(opts).toMatchObject({
          type: 'picture_enhancement',
          reason: 'rerun',
          priority: 50,
          skipDedup: true,
        });
      }
    });

    it('snapshots the resolved filter on the batch row for provenance, without polluting the per-item enhance params', async () => {
      await service.startBatchByFilter(
        makeFilterDto({ tag: 'beach', params: { strength: 'strong' } }),
        USER,
      );

      const batchParams = (mockPrisma.mediaEnhancementBatch.create as jest.Mock).mock
        .calls[0][0].data.params;
      expect(batchParams).toMatchObject({
        strength: 'strong',
        _filter: expect.objectContaining({ circleId: CIRCLE_ID, tag: 'beach' }),
      });
      expect(batchParams._filter).not.toHaveProperty('params');

      // The per-enhancement params (which compile the prompt) stay clean.
      const enhParams = (mockPrisma.mediaEnhancement.create as jest.Mock).mock.calls[0][0].data
        .params;
      expect(enhParams).toEqual({ strength: 'strong' });
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

      // -------------------------------------------------------------------
      // Issue #434 — the grid tile must not keep the pre-enhancement image
      // -------------------------------------------------------------------

      it('AWAITS syncFromStorageObject instead of racing the fire-and-forget OBJECT_PROCESSED_EVENT listener', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        // Both repoints the MediaItem at the NEW content-addressed thumbnail key
        // and delivers the contentHash recompute the nulled column depends on.
        expect(mockMetadataSync.syncFromStorageObject).toHaveBeenCalledWith('obj-1');
      });

      it('prunes the superseded thumbnail ONLY AFTER the MediaItem has been repointed at the new key', async () => {
        await service.applyEnhancement(MEDIA_ID, ENH_ID, 'replace', USER);

        expect(mockThumbnailPrune.pruneSupersededThumbnails).toHaveBeenCalledWith('obj-1');
        expect(replaceCallOrder).toEqual(['sync', 'prune']);
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

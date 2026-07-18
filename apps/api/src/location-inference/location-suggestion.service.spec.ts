/**
 * Unit tests for LocationSuggestionService.
 *
 * Covers:
 *  - listSuggestions: RBAC (viewer), response shape, thumbnail signing chain
 *  - acceptSuggestion: 404, RBAC (collaborator), 400 on non-pending,
 *    unmodified accept -> coordSource:'inferred', adjusted accept ->
 *    coordSource:'manual', audit event
 *  - rejectSuggestion: 404, 400 on non-pending, audit event
 *  - revertSuggestion: 404, 400 when not auto_applied, GEO_CLEAR_COLUMNS,
 *    audit event
 *  - bulkAcceptSuggestions: RBAC (collaborator), dedup-safe async enqueue of a
 *    location_bulk_accept job, returns { data: { jobId, status } }
 *  - processBulkAccept: bounded-batch drain loop, pending+confidence filter,
 *    always coordSource:'inferred', exactly one audit event with final count
 *  - inferLocation: 404, RBAC (collaborator) runs BEFORE other guards, 400 on
 *    non-photo, success enqueue shape
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole, JobReason, LocationSuggestionStatus, MediaType } from '@prisma/client';
import { LocationSuggestionService } from './location-suggestion.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { GEO_LOCATION_PROVIDER } from '../media/geo/geo-location-provider.interface';
import { GEO_CLEAR_COLUMNS } from '../media/geo/geo-result.mapper';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { LocationSuggestionQueryDto } from './dto/location-suggestion-query.dto';
import { AcceptLocationSuggestionDto } from './dto/accept-location-suggestion.dto';
import { BulkAcceptLocationSuggestionsDto } from './dto/bulk-accept-location-suggestions.dto';

const USER_ID = 'user-1';
const CIRCLE_ID = 'circle-1';
const SUGGESTION_ID = 'suggestion-1';
const MEDIA_ID = 'media-1';

const PERMS = ['media:read', 'media:write'];

function makeSuggestion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SUGGESTION_ID,
    mediaItemId: MEDIA_ID,
    circleId: CIRCLE_ID,
    status: LocationSuggestionStatus.pending,
    lat: 9.9281,
    lng: -84.0907,
    confidence: 0.8,
    method: 'interpolated',
    anchorBeforeId: 'a1',
    anchorAfterId: 'a2',
    gapBeforeSeconds: 60,
    gapAfterSeconds: 60,
    anchorDistanceKm: 0.5,
    impliedSpeedKmh: 10,
    resolvedById: null,
    resolvedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('LocationSuggestionService', () => {
  let service: LocationSuggestionService;
  let mockPrisma: MockPrismaService;
  let mockMembership: { assertCircleAccess: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockStorageProvider: { getSignedDownloadUrl: jest.Mock };
  let mockResolver: { getProviderFor: jest.Mock };
  let mockGeoProvider: { reverseGeocode: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    mockEnrichmentJobService = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }) };
    mockStorageProvider = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://cdn.example.com/signed'),
    };
    mockResolver = { getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider) };
    mockGeoProvider = { reverseGeocode: jest.fn().mockResolvedValue(null) };

    (mockPrisma.$transaction as jest.Mock).mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    // Batched thumbnail signing (MediaThumbnailService.signThumbsBatched, used
    // by listSuggestions) issues one storageObject.findMany call. Default to
    // no matching rows -> falls back to the legacy static STORAGE_PROVIDER.
    // Tests asserting provider-routed signing set findMany explicitly.
    (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationSuggestionService,
        // Real MediaThumbnailService, reusing the same PrismaService/
        // STORAGE_PROVIDER/StorageProviderResolver mocks registered below.
        MediaThumbnailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: StorageProviderResolver, useValue: mockResolver },
        { provide: GEO_LOCATION_PROVIDER, useValue: mockGeoProvider },
      ],
    }).compile();

    service = module.get<LocationSuggestionService>(LocationSuggestionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // listSuggestions
  // -------------------------------------------------------------------------

  describe('listSuggestions', () => {
    function makeQuery(overrides: Partial<LocationSuggestionQueryDto> = {}): LocationSuggestionQueryDto {
      return {
        circleId: CIRCLE_ID,
        status: 'pending',
        page: 1,
        pageSize: 20,
        ...overrides,
      } as LocationSuggestionQueryDto;
    }

    it('asserts circle access at the viewer level', async () => {
      (mockPrisma.locationSuggestion.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);

      await service.listSuggestions(makeQuery(), USER_ID, PERMS);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        CircleRole.viewer,
      );
    });

    it('returns { items, meta: { total, page, pageSize } }', async () => {
      (mockPrisma.locationSuggestion.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([
        {
          ...makeSuggestion(),
          mediaItem: { id: MEDIA_ID, capturedAt: new Date(), metadata: null, cameraMake: 'Canon', cameraModel: 'R5' },
        },
      ]);

      const result = await service.listSuggestions(makeQuery({ page: 2, pageSize: 10 }), USER_ID, PERMS);

      expect(result.meta).toEqual({ total: 1, page: 2, pageSize: 10 });
      expect(result.items).toHaveLength(1);
    });

    it('signs the thumbnail via storageObject -> resolver -> getSignedDownloadUrl when metadata has thumbnailStorageKey', async () => {
      (mockPrisma.locationSuggestion.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([
        {
          ...makeSuggestion(),
          mediaItem: {
            id: MEDIA_ID,
            capturedAt: new Date(),
            metadata: { thumbnailStorageKey: 'thumbs/x.jpg' },
            cameraMake: 'Canon',
            cameraModel: 'R5',
          },
        },
      ]);
      (mockPrisma.storageObject.findMany as jest.Mock).mockResolvedValue([
        { storageKey: 'thumbs/x.jpg', storageProvider: 's3', bucket: 'bucket-1' },
      ]);

      const result = await service.listSuggestions(makeQuery(), USER_ID, PERMS);

      expect(mockResolver.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-1');
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith('thumbs/x.jpg', {
        expiresIn: 86400,
      });
      expect(result.items[0].thumbnailUrl).toBe('https://cdn.example.com/signed');
    });

    it('returns thumbnailUrl: null when mediaItem.metadata has no thumbnailStorageKey', async () => {
      (mockPrisma.locationSuggestion.count as jest.Mock).mockResolvedValue(1);
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([
        {
          ...makeSuggestion(),
          mediaItem: { id: MEDIA_ID, capturedAt: new Date(), metadata: null, cameraMake: null, cameraModel: null },
        },
      ]);

      const result = await service.listSuggestions(makeQuery(), USER_ID, PERMS);

      expect(result.items[0].thumbnailUrl).toBeNull();
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('includes mediaItemId in the where clause when provided', async () => {
      (mockPrisma.locationSuggestion.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);

      await service.listSuggestions(makeQuery({ mediaItemId: MEDIA_ID }), USER_ID, PERMS);

      expect(mockPrisma.locationSuggestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ mediaItemId: MEDIA_ID }),
        }),
      );
      expect(mockPrisma.locationSuggestion.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ mediaItemId: MEDIA_ID }),
        }),
      );
    });

    it('omits mediaItemId from the where clause when not provided', async () => {
      (mockPrisma.locationSuggestion.count as jest.Mock).mockResolvedValue(0);
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValue([]);

      await service.listSuggestions(makeQuery(), USER_ID, PERMS);

      expect(mockPrisma.locationSuggestion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId: CIRCLE_ID, status: LocationSuggestionStatus.pending },
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // acceptSuggestion
  // -------------------------------------------------------------------------

  describe('acceptSuggestion', () => {
    function makeDto(overrides: Partial<AcceptLocationSuggestionDto> = {}): AcceptLocationSuggestionDto {
      return { ...overrides } as AcceptLocationSuggestionDto;
    }

    it('throws NotFoundException when the suggestion does not exist', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.acceptSuggestion(SUGGESTION_ID, makeDto(), USER_ID, PERMS)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('checks circle access at the collaborator level', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(makeSuggestion());

      await service.acceptSuggestion(SUGGESTION_ID, makeDto(), USER_ID, PERMS);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        CircleRole.collaborator,
      );
    });

    it('throws BadRequestException when the suggestion is not pending', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(
        makeSuggestion({ status: LocationSuggestionStatus.accepted }),
      );

      await expect(service.acceptSuggestion(SUGGESTION_ID, makeDto(), USER_ID, PERMS)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('unmodified accept (no lat/lng override) writes coordSource:"inferred"', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(makeSuggestion());

      await service.acceptSuggestion(SUGGESTION_ID, makeDto(), USER_ID, PERMS);

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MEDIA_ID },
          data: expect.objectContaining({ coordSource: 'inferred' }),
        }),
      );
      expect(mockPrisma.locationSuggestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUGGESTION_ID },
          data: expect.objectContaining({
            status: LocationSuggestionStatus.accepted,
            resolvedById: USER_ID,
          }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'location_suggestion:accepted' }),
        }),
      );
    });

    it('accept with lat/lng equal to stored values is treated as unmodified -> "inferred"', async () => {
      const suggestion = makeSuggestion();
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(suggestion);

      await service.acceptSuggestion(
        SUGGESTION_ID,
        makeDto({ lat: suggestion.lat, lng: suggestion.lng }),
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ coordSource: 'inferred' }) }),
      );
    });

    it('adjusted accept (lat/lng differ from stored) writes coordSource:"manual"', async () => {
      const suggestion = makeSuggestion();
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(suggestion);

      await service.acceptSuggestion(
        SUGGESTION_ID,
        makeDto({ lat: suggestion.lat + 1, lng: suggestion.lng }),
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ coordSource: 'manual' }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // rejectSuggestion
  // -------------------------------------------------------------------------

  describe('rejectSuggestion', () => {
    it('throws NotFoundException when the suggestion does not exist', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.rejectSuggestion(SUGGESTION_ID, USER_ID, PERMS)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the suggestion is not pending', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(
        makeSuggestion({ status: LocationSuggestionStatus.accepted }),
      );

      await expect(service.rejectSuggestion(SUGGESTION_ID, USER_ID, PERMS)).rejects.toThrow(BadRequestException);
    });

    it('success sets status:rejected, resolvedById/At, and writes an audit event', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(makeSuggestion());

      await service.rejectSuggestion(SUGGESTION_ID, USER_ID, PERMS);

      expect(mockPrisma.locationSuggestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUGGESTION_ID },
          data: expect.objectContaining({
            status: LocationSuggestionStatus.rejected,
            resolvedById: USER_ID,
          }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'location_suggestion:rejected' }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // revertSuggestion
  // -------------------------------------------------------------------------

  describe('revertSuggestion', () => {
    it('throws NotFoundException when the suggestion does not exist', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.revertSuggestion(SUGGESTION_ID, USER_ID, PERMS)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the suggestion is not auto_applied', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(
        makeSuggestion({ status: LocationSuggestionStatus.pending }),
      );

      await expect(service.revertSuggestion(SUGGESTION_ID, USER_ID, PERMS)).rejects.toThrow(BadRequestException);
    });

    it('success applies GEO_CLEAR_COLUMNS exactly, sets status:reverted, and writes an audit event', async () => {
      (mockPrisma.locationSuggestion.findUnique as jest.Mock).mockResolvedValue(
        makeSuggestion({ status: LocationSuggestionStatus.auto_applied }),
      );

      await service.revertSuggestion(SUGGESTION_ID, USER_ID, PERMS);

      expect(mockPrisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: MEDIA_ID },
        data: { ...GEO_CLEAR_COLUMNS },
      });
      expect(mockPrisma.locationSuggestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SUGGESTION_ID },
          data: expect.objectContaining({
            status: LocationSuggestionStatus.reverted,
            resolvedById: USER_ID,
          }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'location_suggestion:reverted' }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // bulkAcceptSuggestions
  // -------------------------------------------------------------------------

  describe('bulkAcceptSuggestions', () => {
    function makeDto(overrides: Partial<BulkAcceptLocationSuggestionsDto> = {}): BulkAcceptLocationSuggestionsDto {
      return { circleId: CIRCLE_ID, minConfidence: 0.7, ...overrides } as BulkAcceptLocationSuggestionsDto;
    }

    it('checks circle access at the collaborator level', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);

      await service.bulkAcceptSuggestions(makeDto(), USER_ID, PERMS);

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        CircleRole.collaborator,
      );
    });

    it('enqueues a location_bulk_accept job with circleId/minConfidence/requestedById and returns { data: { jobId, status } }', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue(null);
      (mockEnrichmentJobService.enqueue as jest.Mock).mockResolvedValue({ id: 'job-99', status: 'pending' });

      const result = await service.bulkAcceptSuggestions(makeDto({ minConfidence: 0.85 }), USER_ID, PERMS);

      expect(mockPrisma.enrichmentJob.findFirst).toHaveBeenCalledWith({
        where: {
          type: 'location_bulk_accept',
          circleId: CIRCLE_ID,
          status: { in: ['pending', 'running'] },
        },
      });
      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'location_bulk_accept',
        mediaItemId: null,
        circleId: CIRCLE_ID,
        reason: JobReason.rerun,
        priority: 0,
        skipDedup: true,
        payload: { minConfidence: 0.85, requestedById: USER_ID },
      });
      expect(result).toEqual({ data: { jobId: 'job-99', status: 'pending' } });
    });

    it('is idempotent — returns the existing pending/running job instead of enqueueing a second one', async () => {
      (mockPrisma.enrichmentJob.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-job', status: 'running' });

      const result = await service.bulkAcceptSuggestions(makeDto(), USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
      expect(result).toEqual({ data: { jobId: 'existing-job', status: 'running' } });
    });
  });

  // -------------------------------------------------------------------------
  // processBulkAccept
  // -------------------------------------------------------------------------

  describe('processBulkAccept', () => {
    const BATCH_SIZE = 100;

    function makeBatch(count: number, prefix: string): ReturnType<typeof makeSuggestion>[] {
      return Array.from({ length: count }, (_, i) =>
        makeSuggestion({ id: `${prefix}-${i}`, mediaItemId: `${prefix}-media-${i}` }),
      );
    }

    it('drains a multi-batch backlog: full batch -> partial batch -> stop, applying coordSource:"inferred" and marking each suggestion accepted', async () => {
      const findMany = mockPrisma.locationSuggestion.findMany as jest.Mock;
      findMany
        .mockResolvedValueOnce(makeBatch(BATCH_SIZE, 'b1'))
        .mockResolvedValueOnce(makeBatch(40, 'b2'));

      const accepted = await service.processBulkAccept(CIRCLE_ID, 0.7, USER_ID);

      expect(accepted).toBe(BATCH_SIZE + 40);
      expect(findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.mediaItem.update).toHaveBeenCalledTimes(BATCH_SIZE + 40);
      for (const call of (mockPrisma.mediaItem.update as jest.Mock).mock.calls) {
        expect(call[0].data.coordSource).toBe('inferred');
      }
      expect(mockPrisma.locationSuggestion.update).toHaveBeenCalledTimes(BATCH_SIZE + 40);
      for (const call of (mockPrisma.locationSuggestion.update as jest.Mock).mock.calls) {
        expect(call[0].data).toEqual(
          expect.objectContaining({ status: LocationSuggestionStatus.accepted, resolvedById: USER_ID }),
        );
      }
    });

    it('stops after an empty batch and never calls applyLocation/update when there are no pending suggestions', async () => {
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValueOnce([]);

      const accepted = await service.processBulkAccept(CIRCLE_ID, 0.7, USER_ID);

      expect(accepted).toBe(0);
      expect(mockPrisma.mediaItem.update).not.toHaveBeenCalled();
      expect(mockPrisma.locationSuggestion.update).not.toHaveBeenCalled();
    });

    it('filters by circleId, status:pending, and confidence >= minConfidence, ordered by createdAt asc', async () => {
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.processBulkAccept(CIRCLE_ID, 0.85, USER_ID);

      expect(mockPrisma.locationSuggestion.findMany).toHaveBeenCalledWith({
        where: {
          circleId: CIRCLE_ID,
          status: LocationSuggestionStatus.pending,
          confidence: { gte: 0.85 },
        },
        take: BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
      });
    });

    it('emits exactly ONE location_suggestion:bulk_accepted audit event with the final total count', async () => {
      const findMany = mockPrisma.locationSuggestion.findMany as jest.Mock;
      findMany
        .mockResolvedValueOnce(makeBatch(BATCH_SIZE, 'b1'))
        .mockResolvedValueOnce(makeBatch(5, 'b2'));

      await service.processBulkAccept(CIRCLE_ID, 0.6, USER_ID);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'location_suggestion:bulk_accepted',
            targetId: CIRCLE_ID,
            meta: expect.objectContaining({ count: BATCH_SIZE + 5, minConfidence: 0.6 }),
          }),
        }),
      );
    });

    it('emits the audit event with count:0 when there is nothing to accept', async () => {
      (mockPrisma.locationSuggestion.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.processBulkAccept(CIRCLE_ID, 0.7, USER_ID);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ meta: expect.objectContaining({ count: 0 }) }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // inferLocation
  // -------------------------------------------------------------------------

  describe('inferLocation', () => {
    it('throws NotFoundException when the mediaItem does not exist', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.inferLocation(MEDIA_ID, USER_ID, PERMS)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the mediaItem is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: new Date(),
        type: MediaType.photo,
      });

      await expect(service.inferLocation(MEDIA_ID, USER_ID, PERMS)).rejects.toThrow(NotFoundException);
    });

    it('checks circle access at the collaborator level BEFORE the type check (mirrors the duplicate-detection rerun fix)', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.video, // would also fail the type check
      });
      const forbiddenError = new Error('membership check ran first');
      mockMembership.assertCircleAccess.mockRejectedValueOnce(forbiddenError);

      await expect(service.inferLocation(MEDIA_ID, USER_ID, PERMS)).rejects.toThrow(forbiddenError);
      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        CircleRole.collaborator,
      );
    });

    it('throws BadRequestException when the mediaItem is not a photo', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.video,
      });

      await expect(service.inferLocation(MEDIA_ID, USER_ID, PERMS)).rejects.toThrow(BadRequestException);
    });

    it('success enqueues a location_inference rerun job and returns { jobId, status }', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: null,
        type: MediaType.photo,
      });

      const result = await service.inferLocation(MEDIA_ID, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith({
        type: 'location_inference',
        mediaItemId: MEDIA_ID,
        circleId: CIRCLE_ID,
        reason: JobReason.rerun,
        priority: 0,
      });
      expect(result).toEqual({ data: { jobId: 'job-1', status: 'pending' } });
    });
  });
});

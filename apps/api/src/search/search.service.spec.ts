/**
 * Unit tests for SearchService.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { SemanticSearchService } from './semantic-search.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const CIRCLE_ID = 'circle-search-test';
const USER_ID = 'user-search-test';

function makeDto(overrides: Record<string, unknown> = {}) {
  return {
    circleId: CIRCLE_ID,
    filters: {},
    page: 1,
    pageSize: 20,
    sortBy: 'capturedAt' as const,
    sortOrder: 'desc' as const,
    ...overrides,
  };
}

const mockMediaItem = {
  id: 'media-1',
  circleId: CIRCLE_ID,
  type: 'photo',
  favorite: false,
  deletedAt: null,
  capturedAt: new Date('2023-06-01'),
  importedAt: new Date('2023-06-02'),
  createdAt: new Date('2023-06-02'),
  updatedAt: new Date('2023-06-02'),
  addedById: USER_ID,
  contentHash: 'abc123',
  mimeType: 'image/jpeg',
  fileSize: 1024,
  storageObjectId: 'obj-1',
  geoCountry: null,
  geoCountryCode: null,
  geoAdmin1: null,
  geoLocality: null,
  geoPlaceName: null,
  takenLat: null,
  takenLng: null,
  cameraMake: null,
  cameraModel: null,
  sourceDeviceId: null,
  sourceDeviceName: null,
  width: null,
  height: null,
  durationSec: null,
  originalFilename: 'photo.jpg',
};

describe('SearchService', () => {
  let service: SearchService;
  let mockPrisma: MockPrismaService;
  let mockCircleMembership: { assertCircleAccess: jest.Mock };
  let mockSemanticSearch: { embedQuery: jest.Mock; knnMediaIds: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockCircleMembership = {
      assertCircleAccess: jest.fn(),
    };
    mockSemanticSearch = {
      embedQuery: jest.fn().mockResolvedValue(null), // default: no embedding
      knnMediaIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembership },
        { provide: SemanticSearchService, useValue: mockSemanticSearch },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  describe('search (via DTO)', () => {
    it('throws ForbiddenException when user is not a member', async () => {
      mockCircleMembership.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('You are not a member of this circle'),
      );
      // These won't be reached, but set them so they're not an unrelated failure
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      const dto = makeDto();
      await expect(service.search(dto as any, USER_ID, [])).rejects.toThrow(ForbiddenException);
    });

    it('returns paginated result for a member', async () => {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'viewer',
        isSuperAdmin: false,
      });
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(1);

      const dto = makeDto();
      const result = await service.search(dto as any, USER_ID, []);

      expect(result).toEqual({
        items: [mockMediaItem],
        meta: {
          page: 1,
          pageSize: 20,
          totalItems: 1,
          totalPages: 1,
        },
      });
    });

    it('calculates totalPages correctly for multiple pages', async () => {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'viewer',
        isSuperAdmin: false,
      });
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(45);

      const dto = makeDto({ pageSize: 20 });
      const result = await service.search(dto as any, USER_ID, []);

      expect(result.meta).toEqual({
        page: 1,
        pageSize: 20,
        totalItems: 45,
        totalPages: 3, // ceil(45/20)
      });
    });
  });

  describe('runSearch', () => {
    it('always includes circleId from the parameter in the where clause', async () => {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'viewer',
        isSuperAdmin: false,
      });
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      await service.runSearch(USER_ID, CIRCLE_ID, [], {});

      const findManyCall = mockPrisma.mediaItem.findMany.mock.calls[0]?.[0];
      expect(findManyCall?.where).toMatchObject({
        circleId: CIRCLE_ID,
        deletedAt: null,
      });
    });

    it('passes permissions to assertCircleAccess', async () => {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'circle_admin',
        isSuperAdmin: true,
      });
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      const permissions = ['circles:manage_any'];
      await service.runSearch(USER_ID, CIRCLE_ID, permissions, {});

      expect(mockCircleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        permissions,
        expect.any(String),
      );
    });

    it('uses page=1 and pageSize=20 as defaults', async () => {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'viewer',
        isSuperAdmin: false,
      });
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);
      mockPrisma.mediaItem.count.mockResolvedValue(0);

      const result = await service.runSearch(USER_ID, CIRCLE_ID, [], {});

      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(20);
    });

    it('uses provided paging parameters', async () => {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'viewer',
        isSuperAdmin: false,
      });
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(50);

      const result = await service.runSearch(USER_ID, CIRCLE_ID, [], {}, {
        page: 3,
        pageSize: 10,
        sortBy: 'importedAt',
        sortOrder: 'asc',
      });

      expect(result.meta.page).toBe(3);
      expect(result.meta.pageSize).toBe(10);

      const findManyCall = mockPrisma.mediaItem.findMany.mock.calls[0]?.[0];
      expect(findManyCall?.skip).toBe(20); // (3-1)*10
      expect(findManyCall?.take).toBe(10);
    });
  });

  describe('getFields', () => {
    it('returns an array with known field keys', () => {
      const fields = service.getFields();
      const keys = fields.map((f) => f.key);
      expect(keys).toContain('tag');
      expect(keys).toContain('type');
      expect(keys).toContain('country');
      expect(keys).toContain('favorite');
    });

    it('each field has key, label, type, and description', () => {
      const fields = service.getFields();
      for (const field of fields) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.label).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.description).toBe('string');
      }
    });

    it('does not expose buildWhere function in the returned descriptors', () => {
      const fields = service.getFields();
      for (const field of fields) {
        expect((field as any).buildWhere).toBeUndefined();
      }
    });

    it('includes semanticQuery as a field descriptor', () => {
      const fields = service.getFields();
      const keys = fields.map((f) => f.key);
      expect(keys).toContain('semanticQuery');
    });
  });

  // -------------------------------------------------------------------------
  // Semantic search path via runSearch
  // -------------------------------------------------------------------------

  describe('runSearch — semantic path (semanticQuery)', () => {
    const vectorResult = [0.1, 0.2, 0.3];

    function setupMemberAccess() {
      mockCircleMembership.assertCircleAccess.mockResolvedValue({
        role: 'viewer',
        isSuperAdmin: false,
      });
    }

    it('falls back to filter-only path when embedQuery returns null', async () => {
      setupMemberAccess();
      mockSemanticSearch.embedQuery.mockResolvedValue(null);
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(1);

      const result = await service.runSearch(
        USER_ID, CIRCLE_ID, [], {}, { page: 1, pageSize: 20 }, 'find beach photos',
      );

      // Falls back to normal path: findMany and count are called
      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalled();
      expect(mockPrisma.mediaItem.count).toHaveBeenCalled();
      // knnMediaIds must NOT be called
      expect(mockSemanticSearch.knnMediaIds).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('calls knnMediaIds when embedQuery returns a vector', async () => {
      setupMemberAccess();
      mockSemanticSearch.embedQuery.mockResolvedValue(vectorResult);
      mockSemanticSearch.knnMediaIds.mockResolvedValue([
        { id: 'media-1', distance: 0.1 },
        { id: 'media-2', distance: 0.2 },
      ]);
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);

      await service.runSearch(
        USER_ID, CIRCLE_ID, [], {}, { page: 1, pageSize: 20 }, 'beach at sunset',
      );

      expect(mockSemanticSearch.knnMediaIds).toHaveBeenCalledWith(
        CIRCLE_ID,
        vectorResult,
        expect.any(Number),
      );
    });

    it('returns empty page immediately when knnMediaIds returns empty array', async () => {
      setupMemberAccess();
      mockSemanticSearch.embedQuery.mockResolvedValue(vectorResult);
      mockSemanticSearch.knnMediaIds.mockResolvedValue([]);

      const result = await service.runSearch(
        USER_ID, CIRCLE_ID, [], {}, { page: 1, pageSize: 20 }, 'something obscure',
      );

      expect(result).toEqual({
        items: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });
      // findMany must NOT be called (early return)
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('re-orders results by KNN rank (closest first)', async () => {
      setupMemberAccess();
      mockSemanticSearch.embedQuery.mockResolvedValue(vectorResult);
      // KNN returns media-2 closer than media-1
      mockSemanticSearch.knnMediaIds.mockResolvedValue([
        { id: 'media-2', distance: 0.05 },
        { id: 'media-1', distance: 0.2 },
      ]);
      const media1 = { ...mockMediaItem, id: 'media-1' };
      const media2 = { ...mockMediaItem, id: 'media-2' };
      // findMany returns them in DB order (not KNN order)
      mockPrisma.mediaItem.findMany.mockResolvedValue([media1, media2] as any);

      const result = await service.runSearch(
        USER_ID, CIRCLE_ID, [], {}, { page: 1, pageSize: 20 }, 'beach',
      );

      // Should be re-ordered: media-2 first (closer), media-1 second
      expect(result.items[0].id).toBe('media-2');
      expect(result.items[1].id).toBe('media-1');
    });

    it('intersects KNN ids with structured filter (id: { in: orderedIds })', async () => {
      setupMemberAccess();
      mockSemanticSearch.embedQuery.mockResolvedValue(vectorResult);
      mockSemanticSearch.knnMediaIds.mockResolvedValue([
        { id: 'media-knn-1', distance: 0.1 },
        { id: 'media-knn-2', distance: 0.2 },
      ]);
      mockPrisma.mediaItem.findMany.mockResolvedValue([]);

      await service.runSearch(
        USER_ID, CIRCLE_ID, [], {}, { page: 1, pageSize: 20 }, 'beach',
      );

      const findManyCall = mockPrisma.mediaItem.findMany.mock.calls[0]?.[0];
      expect(findManyCall?.where).toMatchObject({
        id: { in: ['media-knn-1', 'media-knn-2'] },
        circleId: CIRCLE_ID,
        deletedAt: null,
      });
    });

    it('paginates the KNN-filtered intersection in app (page 2)', async () => {
      setupMemberAccess();
      mockSemanticSearch.embedQuery.mockResolvedValue(vectorResult);
      // 3 items in KNN order
      mockSemanticSearch.knnMediaIds.mockResolvedValue([
        { id: 'media-1', distance: 0.1 },
        { id: 'media-2', distance: 0.2 },
        { id: 'media-3', distance: 0.3 },
      ]);
      const media1 = { ...mockMediaItem, id: 'media-1' };
      const media2 = { ...mockMediaItem, id: 'media-2' };
      const media3 = { ...mockMediaItem, id: 'media-3' };
      mockPrisma.mediaItem.findMany.mockResolvedValue([media1, media2, media3] as any);

      const result = await service.runSearch(
        USER_ID, CIRCLE_ID, [], {}, { page: 2, pageSize: 2 }, 'beach',
      );

      // Page 2 of page-size 2 from 3 total → just media-3
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('media-3');
      expect(result.meta).toMatchObject({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
    });

    it('uses the normal filter-only path when no semanticQuery is provided', async () => {
      setupMemberAccess();
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(1);

      const result = await service.runSearch(USER_ID, CIRCLE_ID, [], {});

      // embedQuery must NOT have been called
      expect(mockSemanticSearch.embedQuery).not.toHaveBeenCalled();
      expect(result.meta.totalItems).toBe(1);
    });

    it('uses the normal filter-only path when semanticQuery is an empty string', async () => {
      setupMemberAccess();
      mockPrisma.mediaItem.findMany.mockResolvedValue([mockMediaItem] as any);
      mockPrisma.mediaItem.count.mockResolvedValue(1);

      await service.runSearch(USER_ID, CIRCLE_ID, [], {}, { page: 1, pageSize: 20 }, '');

      expect(mockSemanticSearch.embedQuery).not.toHaveBeenCalled();
    });
  });
});

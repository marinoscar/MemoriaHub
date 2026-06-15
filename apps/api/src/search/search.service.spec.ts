/**
 * Unit tests for SearchService.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
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
  classification: null,
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

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockCircleMembership = {
      assertCircleAccess: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembership },
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
  });
});

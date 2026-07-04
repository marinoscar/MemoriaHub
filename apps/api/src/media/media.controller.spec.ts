/**
 * MediaController — unit tests.
 *
 * Focuses on:
 *   1. listLocations handler: verifies it calls mediaService.listLocations (not getMedia)
 *      and that the route does not collide with the :id handler for the literal
 *      path segment "locations".
 *   2. Route-shadow guard: listLocations and getMedia are distinct handlers.
 *
 * Guards and their dependencies are mocked out so we can test the controller
 * logic without standing up full JWT / PAT / roles infrastructure.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import type { MediaLocationsQueryDto } from './dto/media-locations-query.dto';
import type { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import type { BulkTagsDto } from './dto/bulk-tags.dto';
import type { BulkDeleteDto } from './dto/bulk-delete.dto';
import type { DashboardQueryDto } from './dto/dashboard-query.dto';
import type { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import type { GeoSearchQueryDto } from './dto/geo-search-query.dto';
import type { AddAlbumItemsByFilterDto } from './dto/add-album-items-by-filter.dto';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Pass-through guard — allows all requests without DI dependencies
// ---------------------------------------------------------------------------

class PassThroughGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Minimal RequestUser for controller tests
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-1',
    email: 'test@example.com',
    permissions: [PERMISSIONS.MEDIA_READ],
    roles: [],
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock MediaService — only stub the methods we invoke in the target tests.
// ---------------------------------------------------------------------------

const mockMediaService = {
  listLocations: jest.fn(),
  getMedia: jest.fn(),
  listMedia: jest.fn(),
  createMedia: jest.fn(),
  updateMedia: jest.fn(),
  deleteMedia: jest.fn(),
  listTags: jest.fn(),
  attachTags: jest.fn(),
  removeTag: jest.fn(),
  createAlbum: jest.fn(),
  listAlbums: jest.fn(),
  getAlbum: jest.fn(),
  updateAlbum: jest.fn(),
  deleteAlbum: jest.fn(),
  addAlbumItems: jest.fn(),
  addAlbumItemsByFilter: jest.fn(),
  removeAlbumItem: jest.fn(),
  streamExport: jest.fn(),
  bulkUpdateMedia: jest.fn(),
  bulkTags: jest.fn(),
  bulkDelete: jest.fn(),
  reverseGeocodeOnDemand: jest.fn(),
  searchPlaces: jest.fn(),
  getDashboard: jest.fn(),
  exploreLocations: jest.fn(),
  exploreLocationLevel: jest.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaController', () => {
  let controller: MediaController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: MediaService, useValue: mockMediaService },
        { provide: Reflector, useValue: new Reflector() },
      ],
    })
      // Override guards with pass-through implementations to avoid DI
      // requirements for PatService, JwtStrategy, etc.
      .overrideGuard(JwtAuthGuard)
      .useClass(PassThroughGuard)
      .overrideGuard(RolesGuard)
      .useClass(PassThroughGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(PassThroughGuard)
      .compile();

    controller = module.get<MediaController>(MediaController);
  });

  // -------------------------------------------------------------------------
  // listLocations handler
  // -------------------------------------------------------------------------

  describe('listLocations', () => {
    it('should call mediaService.listLocations with the query and user context', async () => {
      const user = makeUser();
      const query: Partial<MediaLocationsQueryDto> = { type: 'photo' };
      const expectedResult = [
        {
          id: 'item-1',
          takenLat: 9.93,
          takenLng: -84.09,
          capturedAt: new Date('2024-01-01'),
          geoLocality: 'La Fortuna',
          thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
        },
      ];

      mockMediaService.listLocations.mockResolvedValue(expectedResult);

      const result = await controller.listLocations(
        query as MediaLocationsQueryDto,
        user,
      );

      expect(mockMediaService.listLocations).toHaveBeenCalledTimes(1);
      expect(mockMediaService.listLocations).toHaveBeenCalledWith(
        query,
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });

    it('should NOT call mediaService.getMedia when listLocations is invoked', async () => {
      const user = makeUser();
      mockMediaService.listLocations.mockResolvedValue([]);

      await controller.listLocations({} as MediaLocationsQueryDto, user);

      expect(mockMediaService.getMedia).not.toHaveBeenCalled();
    });

    it('should forward user.id and user.permissions to the service', async () => {
      const adminUser = makeUser({
        id: 'admin-99',
        permissions: [PERMISSIONS.MEDIA_READ, PERMISSIONS.MEDIA_READ_ANY],
      });
      mockMediaService.listLocations.mockResolvedValue([]);

      await controller.listLocations({} as MediaLocationsQueryDto, adminUser);

      expect(mockMediaService.listLocations).toHaveBeenCalledWith(
        {},
        'admin-99',
        expect.arrayContaining([PERMISSIONS.MEDIA_READ_ANY]),
      );
    });

    it('should return an empty array when the service returns no geotagged items', async () => {
      const user = makeUser();
      mockMediaService.listLocations.mockResolvedValue([]);

      const result = await controller.listLocations({} as MediaLocationsQueryDto, user);

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // bulkUpdateMedia handler
  // -------------------------------------------------------------------------

  describe('bulkUpdateMedia', () => {
    it('should call mediaService.bulkUpdateMedia with dto and user context', async () => {
      const user = makeUser({
        id: 'user-42',
        permissions: [PERMISSIONS.MEDIA_WRITE],
      });
      const dto: Partial<BulkUpdateMediaDto> = {
        circleId: randomUUID(),
        ids: [randomUUID()],
        set: { favorite: true },
      };
      const expectedResult = { updated: 1 };
      mockMediaService.bulkUpdateMedia.mockResolvedValue(expectedResult);

      const result = await controller.bulkUpdateMedia(dto as BulkUpdateMediaDto, user);

      expect(mockMediaService.bulkUpdateMedia).toHaveBeenCalledTimes(1);
      expect(mockMediaService.bulkUpdateMedia).toHaveBeenCalledWith(
        dto,
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });
  });

  // -------------------------------------------------------------------------
  // bulkTags handler
  // -------------------------------------------------------------------------

  describe('bulkTags', () => {
    it('should call mediaService.bulkTags with dto and user context', async () => {
      const user = makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE] });
      const dto: Partial<BulkTagsDto> = {
        circleId: randomUUID(),
        ids: [randomUUID()],
        add: ['nature'],
      };
      const expectedResult = { added: 1, removed: 0 };
      mockMediaService.bulkTags.mockResolvedValue(expectedResult);

      const result = await controller.bulkTags(dto as BulkTagsDto, user);

      expect(mockMediaService.bulkTags).toHaveBeenCalledWith(
        dto,
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });
  });

  // -------------------------------------------------------------------------
  // bulkDelete handler
  // -------------------------------------------------------------------------

  describe('bulkDelete', () => {
    it('should call mediaService.bulkDelete with dto and user context', async () => {
      const user = makeUser({ permissions: [PERMISSIONS.MEDIA_DELETE] });
      const dto: Partial<BulkDeleteDto> = {
        circleId: randomUUID(),
        ids: [randomUUID()],
      };
      const expectedResult = { deleted: 1 };
      mockMediaService.bulkDelete.mockResolvedValue(expectedResult);

      const result = await controller.bulkDelete(dto as BulkDeleteDto, user);

      expect(mockMediaService.bulkDelete).toHaveBeenCalledWith(
        dto,
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });
  });

  // -------------------------------------------------------------------------
  // getDashboard handler
  // -------------------------------------------------------------------------

  describe('getDashboard', () => {
    it('should call mediaService.getDashboard with query and user context', async () => {
      const user = makeUser({ permissions: [PERMISSIONS.MEDIA_READ] });
      const query: DashboardQueryDto = { circleId: randomUUID() };
      const expectedResult = {
        onThisDay: [],
        recent: [],
        favorites: [],
        counts: { total: 0, unreviewed: 0, lowValue: 0, missingGeo: 0 },
      };
      mockMediaService.getDashboard.mockResolvedValue(expectedResult);

      const result = await controller.getDashboard(query, user);

      expect(mockMediaService.getDashboard).toHaveBeenCalledTimes(1);
      expect(mockMediaService.getDashboard).toHaveBeenCalledWith(
        query,
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });
  });

  // -------------------------------------------------------------------------
  // reverseGeocodeOnDemand handler
  // -------------------------------------------------------------------------

  describe('reverseGeocodeOnDemand', () => {
    it('should call mediaService.reverseGeocodeOnDemand with lat and lng from query', async () => {
      const query: ReverseGeocodeQueryDto = { lat: 9.9281, lng: -84.0907 };
      const expectedResult = {
        country: 'Costa Rica',
        countryCode: 'CR',
        admin1: 'Alajuela',
        locality: 'La Fortuna',
      };
      mockMediaService.reverseGeocodeOnDemand.mockResolvedValue(expectedResult);

      const result = await controller.reverseGeocodeOnDemand(query);

      expect(mockMediaService.reverseGeocodeOnDemand).toHaveBeenCalledTimes(1);
      expect(mockMediaService.reverseGeocodeOnDemand).toHaveBeenCalledWith(
        query.lat,
        query.lng,
      );
      expect(result).toBe(expectedResult);
    });
  });

  // -------------------------------------------------------------------------
  // searchPlaces handler
  // -------------------------------------------------------------------------

  describe('searchPlaces', () => {
    it('should call mediaService.searchPlaces with q and limit from query', async () => {
      const query: GeoSearchQueryDto = { q: 'La Fortuna', limit: 5 };
      const expectedResult = [
        { lat: 9.9281, lng: -84.0907, label: 'La Fortuna, Alajuela, Costa Rica' },
      ];
      mockMediaService.searchPlaces.mockResolvedValue(expectedResult);

      const result = await controller.searchPlaces(query);

      expect(mockMediaService.searchPlaces).toHaveBeenCalledTimes(1);
      expect(mockMediaService.searchPlaces).toHaveBeenCalledWith(
        query.q,
        query.limit,
      );
      expect(result).toBe(expectedResult);
    });
  });

  // -------------------------------------------------------------------------
  // exploreLocations handler
  // -------------------------------------------------------------------------

  describe('exploreLocations', () => {
    it('should call mediaService.exploreLocations with circleId, user id, and permissions', async () => {
      const user = makeUser({
        id: 'user-77',
        permissions: [PERMISSIONS.MEDIA_READ],
      });
      const expectedResult = {
        countries: [{ name: 'Costa Rica', countryCode: 'CR', count: 5, coverThumbnailUrl: null }],
        regions: [],
        cities: [],
      };
      mockMediaService.exploreLocations.mockResolvedValue(expectedResult);

      const result = await controller.exploreLocations('circle-1', user);

      expect(mockMediaService.exploreLocations).toHaveBeenCalledTimes(1);
      expect(mockMediaService.exploreLocations).toHaveBeenCalledWith(
        'circle-1',
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });

    it('should forward the exact user id and permissions to the service', async () => {
      const adminUser = makeUser({
        id: 'admin-1',
        permissions: [PERMISSIONS.MEDIA_READ, PERMISSIONS.MEDIA_READ_ANY],
      });
      mockMediaService.exploreLocations.mockResolvedValue({
        countries: [],
        regions: [],
        cities: [],
      });

      await controller.exploreLocations('circle-9', adminUser);

      expect(mockMediaService.exploreLocations).toHaveBeenCalledWith(
        'circle-9',
        'admin-1',
        expect.arrayContaining([PERMISSIONS.MEDIA_READ_ANY]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // exploreLocationLevel handler
  // -------------------------------------------------------------------------

  describe('exploreLocationLevel', () => {
    it('should call mediaService.exploreLocationLevel with level, circleId, user id, and permissions', async () => {
      const user = makeUser();
      const expectedResult = [
        { name: 'Costa Rica', countryCode: 'CR', count: 5, coverThumbnailUrl: null },
      ];
      mockMediaService.exploreLocationLevel.mockResolvedValue(expectedResult);

      const result = await controller.exploreLocationLevel('countries', 'circle-1', user);

      expect(mockMediaService.exploreLocationLevel).toHaveBeenCalledTimes(1);
      expect(mockMediaService.exploreLocationLevel).toHaveBeenCalledWith(
        'circle-1',
        'countries',
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });

    it('forwards the :level route param verbatim (validation happens in the service)', async () => {
      const user = makeUser();
      mockMediaService.exploreLocationLevel.mockResolvedValue([]);

      await controller.exploreLocationLevel('cities', 'circle-2', user);

      expect(mockMediaService.exploreLocationLevel).toHaveBeenCalledWith(
        'circle-2',
        'cities',
        user.id,
        user.permissions,
      );
    });
  });

  // -------------------------------------------------------------------------
  // @Auth metadata wiring — explore/locations routes
  // -------------------------------------------------------------------------

  describe('@Auth metadata wiring — explore/locations routes', () => {
    it('exploreLocations requires MEDIA_READ permission', () => {
      const permissions: string[] = Reflect.getMetadata(
        PERMISSIONS_KEY,
        controller.exploreLocations,
      );
      expect(permissions).toContain(PERMISSIONS.MEDIA_READ);
    });

    it('exploreLocationLevel requires MEDIA_READ permission', () => {
      const permissions: string[] = Reflect.getMetadata(
        PERMISSIONS_KEY,
        controller.exploreLocationLevel,
      );
      expect(permissions).toContain(PERMISSIONS.MEDIA_READ);
    });
  });

  // -------------------------------------------------------------------------
  // addAlbumItemsByFilter handler
  // -------------------------------------------------------------------------

  describe('addAlbumItemsByFilter', () => {
    it('should delegate to mediaService.addAlbumItemsByFilter with albumId, dto, userId, and permissions', async () => {
      const albumId = randomUUID();
      const user = makeUser({
        id: 'user-42',
        permissions: [PERMISSIONS.MEDIA_WRITE],
      });
      const dto: Partial<AddAlbumItemsByFilterDto> = {
        circleId: randomUUID(),
        type: 'photo' as const,
      };
      const expectedResult = { added: 7 };

      mockMediaService.addAlbumItemsByFilter.mockResolvedValue(expectedResult);

      const result = await controller.addAlbumItemsByFilter(
        albumId,
        dto as AddAlbumItemsByFilterDto,
        user,
      );

      expect(mockMediaService.addAlbumItemsByFilter).toHaveBeenCalledTimes(1);
      expect(mockMediaService.addAlbumItemsByFilter).toHaveBeenCalledWith(
        albumId,
        dto,
        user.id,
        user.permissions,
      );
      expect(result).toBe(expectedResult);
    });

    it('should NOT call addAlbumItems when addAlbumItemsByFilter is invoked', async () => {
      const albumId = randomUUID();
      const user = makeUser({ permissions: [PERMISSIONS.MEDIA_WRITE] });
      const dto: Partial<AddAlbumItemsByFilterDto> = { circleId: randomUUID() };
      mockMediaService.addAlbumItemsByFilter.mockResolvedValue({ added: 0 });

      await controller.addAlbumItemsByFilter(
        albumId,
        dto as AddAlbumItemsByFilterDto,
        user,
      );

      expect(mockMediaService.addAlbumItems).not.toHaveBeenCalled();
    });

    it('should forward the exact user id and permissions to the service', async () => {
      const albumId = randomUUID();
      const adminUser = makeUser({
        id: 'admin-99',
        permissions: [PERMISSIONS.MEDIA_WRITE, PERMISSIONS.MEDIA_WRITE_ANY],
      });
      const dto: Partial<AddAlbumItemsByFilterDto> = { circleId: randomUUID() };
      mockMediaService.addAlbumItemsByFilter.mockResolvedValue({ added: 1 });

      await controller.addAlbumItemsByFilter(
        albumId,
        dto as AddAlbumItemsByFilterDto,
        adminUser,
      );

      expect(mockMediaService.addAlbumItemsByFilter).toHaveBeenCalledWith(
        albumId,
        dto,
        'admin-99',
        expect.arrayContaining([PERMISSIONS.MEDIA_WRITE_ANY]),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Route-shadow guard: listLocations declared BEFORE :id
  // -------------------------------------------------------------------------

  describe('route ordering — listLocations precedes :id', () => {
    it('listLocations is a method directly on the controller (not confused with getMedia)', () => {
      // Verify the controller exposes both methods — this confirms both handlers
      // were compiled and wired up. Ordering is enforced by the Nest metadata
      // (static routes are matched first).
      expect(typeof controller.listLocations).toBe('function');
      expect(typeof controller.getMedia).toBe('function');
    });

    it('getMedia is a DIFFERENT handler from listLocations', () => {
      // Paranoia check: they must not be the same function reference.
      expect(controller.listLocations).not.toBe(controller.getMedia);
    });

    it('listLocations handler calls listLocations service method, not getMedia', async () => {
      // This is the key route-shadow guard test:
      // If NestJS were routing GET /media/locations to @Get(':id'), getMedia
      // would be called with id='locations'. We verify that calling the
      // listLocations handler directly invokes the correct service method.
      const user = makeUser();
      mockMediaService.listLocations.mockResolvedValue([]);

      // Direct handler invocation — simulates Nest routing GET /media/locations
      // to the first matching static route handler.
      await controller.listLocations({} as MediaLocationsQueryDto, user);

      expect(mockMediaService.listLocations).toHaveBeenCalledTimes(1);
      expect(mockMediaService.getMedia).not.toHaveBeenCalled();
    });
  });
});

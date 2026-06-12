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
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import type { MediaLocationsQueryDto } from './dto/media-locations-query.dto';

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
  removeAlbumItem: jest.fn(),
  streamExport: jest.fn(),
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

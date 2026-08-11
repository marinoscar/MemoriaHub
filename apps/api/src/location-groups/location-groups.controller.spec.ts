/**
 * Unit tests for LocationGroupsController / LocationGroupsAdminController
 * (issue #374).
 *
 * Two things are verified:
 *
 *  1. Handler delegation to LocationGroupsService.
 *  2. RBAC. Rather than only reading the `@Auth` metadata back, the REAL
 *     RolesGuard and PermissionsGuard are driven against each handler with a
 *     synthetic user, so "non-admin ⇒ 403" and "geo_settings:read can list but
 *     not mutate" are asserted as enforcement, not as decorator trivia.
 */
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { LocationGroupsController } from './location-groups.controller';
import { LocationGroupsAdminController } from './location-groups-admin.controller';
import { LocationGroupsService } from './location-groups.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS, ROLES } from '../common/constants/roles.constants';

const mockService = {
  list: jest.fn(),
  get: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  addMembers: jest.fn(),
  removeMembers: jest.fn(),
  listValues: jest.fn(),
  suggestions: jest.fn(),
  merge: jest.fn(),
  triggerRebuild: jest.fn(),
};

const controller = new LocationGroupsController(
  mockService as unknown as LocationGroupsService,
);
const adminController = new LocationGroupsAdminController(
  mockService as unknown as LocationGroupsService,
);

/**
 * Build an ExecutionContext the real guards accept, pointing at one handler.
 */
function contextFor(
  handler: (...args: any[]) => unknown,
  cls: object,
  user: { roles: string[]; permissions: string[] } | null,
): ExecutionContext {
  const request: Record<string, unknown> = {};
  if (user) {
    // Shaped as `toRequestUser` expects: roles and permissions arrive nested
    // under userRoles → role → rolePermissions → permission, exactly as the JWT
    // strategy attaches them.
    request['user'] = {
      id: 'u1',
      email: 'admin@example.com',
      isActive: true,
      userRoles: user.roles.map((name) => ({
        role: {
          name,
          rolePermissions: user.permissions.map((permission) => ({
            permission: { name: permission },
          })),
        },
      })),
    };
  }
  return {
    getHandler: () => handler,
    getClass: () => cls.constructor,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Run both RBAC guards; returns true only when both allow. */
function authorize(
  handler: (...args: any[]) => unknown,
  cls: object,
  user: { roles: string[]; permissions: string[] } | null,
): boolean {
  const reflector = new Reflector();
  const ctx = contextFor(handler, cls, user);
  return (
    new RolesGuard(reflector).canActivate(ctx) &&
    new PermissionsGuard(reflector).canActivate(ctx)
  );
}

const ADMIN_READER = {
  roles: [ROLES.ADMIN],
  permissions: [PERMISSIONS.GEO_SETTINGS_READ],
};
const ADMIN_WRITER = {
  roles: [ROLES.ADMIN],
  permissions: [PERMISSIONS.GEO_SETTINGS_READ, PERMISSIONS.GEO_SETTINGS_WRITE],
};
const CONTRIBUTOR = {
  // A non-admin who somehow holds the permissions still fails the ROLE gate.
  roles: [ROLES.CONTRIBUTOR],
  permissions: [PERMISSIONS.GEO_SETTINGS_READ, PERMISSIONS.GEO_SETTINGS_WRITE],
};

const READ_HANDLERS: Array<[string, (...args: any[]) => unknown, object]> = [
  ['GET /location-groups', controller.list, controller],
  ['GET /location-groups/values', controller.listValues, controller],
  ['GET /location-groups/suggestions', controller.suggestions, controller],
  ['GET /location-groups/:id', controller.get, controller],
];

const WRITE_HANDLERS: Array<[string, (...args: any[]) => unknown, object]> = [
  ['POST /location-groups', controller.create, controller],
  ['POST /location-groups/merge', controller.merge, controller],
  ['PATCH /location-groups/:id', controller.update, controller],
  ['DELETE /location-groups/:id', controller.remove, controller],
  ['POST /location-groups/:id/members', controller.addMembers, controller],
  ['DELETE /location-groups/:id/members', controller.removeMembers, controller],
  ['POST /admin/location-groups/rebuild', adminController.rebuild, adminController],
];

const ALL_HANDLERS = [...READ_HANDLERS, ...WRITE_HANDLERS];

describe('LocationGroupsController', () => {
  beforeEach(() => jest.clearAllMocks());

  // =========================================================================
  // Delegation
  // =========================================================================

  describe('delegation', () => {
    it('list passes the query through', async () => {
      mockService.list.mockResolvedValue({ items: [], meta: {} });
      const query = { page: 1, pageSize: 50 } as any;

      await controller.list(query);

      expect(mockService.list).toHaveBeenCalledWith(query);
    });

    it('get passes the id through', async () => {
      mockService.get.mockResolvedValue({});
      await controller.get('group-1');
      expect(mockService.get).toHaveBeenCalledWith('group-1');
    });

    it('create passes the dto and the current user id', async () => {
      mockService.create.mockResolvedValue({});
      const dto = { level: 'region', canonicalName: 'Heredia' } as any;

      await controller.create(dto, 'user-1');

      expect(mockService.create).toHaveBeenCalledWith(dto, 'user-1');
    });

    it('create tolerates a missing user id (passes null, never undefined)', async () => {
      mockService.create.mockResolvedValue({});
      await controller.create({} as any, undefined as unknown as string);
      expect(mockService.create).toHaveBeenCalledWith({}, null);
    });

    it('update passes id and dto through', async () => {
      mockService.update.mockResolvedValue({});
      const dto = { enabled: false } as any;
      await controller.update('group-1', dto);
      expect(mockService.update).toHaveBeenCalledWith('group-1', dto);
    });

    it('remove returns nothing (204) and delegates', async () => {
      mockService.remove.mockResolvedValue(undefined);
      await expect(controller.remove('group-1')).resolves.toBeUndefined();
      expect(mockService.remove).toHaveBeenCalledWith('group-1');
    });

    it('addMembers / removeMembers unwrap the values array', async () => {
      mockService.addMembers.mockResolvedValue({ added: 1 });
      mockService.removeMembers.mockResolvedValue({ removed: 1 });

      await controller.addMembers('group-1', { values: ['Heredia'] } as any);
      await controller.removeMembers('group-1', { values: ['Heredia'] } as any);

      expect(mockService.addMembers).toHaveBeenCalledWith('group-1', ['Heredia']);
      expect(mockService.removeMembers).toHaveBeenCalledWith('group-1', ['Heredia']);
    });

    it('merge passes the dto and the current user id', async () => {
      mockService.merge.mockResolvedValue({});
      const dto = {
        level: 'locality',
        countryCode: 'US',
        values: ['Conroe', 'Shenandoah'],
        canonicalName: 'The Woodlands',
      } as any;

      await controller.merge(dto, 'user-1');

      expect(mockService.merge).toHaveBeenCalledWith(dto, 'user-1');
    });

    it('merge tolerates a missing user id (passes null, never undefined)', async () => {
      mockService.merge.mockResolvedValue({});
      await controller.merge({} as any, undefined as unknown as string);
      expect(mockService.merge).toHaveBeenCalledWith({}, null);
    });

    it('the admin rebuild forwards circleId and groupIds', async () => {
      mockService.triggerRebuild.mockResolvedValue({ data: {} });

      await adminController.rebuild({ circleId: 'c1', groupIds: ['g1'] } as any);

      expect(mockService.triggerRebuild).toHaveBeenCalledWith({
        circleId: 'c1',
        groupIds: ['g1'],
      });
    });
  });

  // =========================================================================
  // RBAC — enforced through the real guards
  // =========================================================================

  describe('RBAC', () => {
    it.each(ALL_HANDLERS)('%s requires the ADMIN role', (_label, handler) => {
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, handler);
      expect(roles).toEqual([ROLES.ADMIN]);
    });

    it.each(READ_HANDLERS)('%s requires geo_settings:read', (_label, handler) => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, handler);
      expect(permissions).toEqual([PERMISSIONS.GEO_SETTINGS_READ]);
    });

    it.each(WRITE_HANDLERS)('%s requires geo_settings:write', (_label, handler) => {
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, handler);
      expect(permissions).toEqual([PERMISSIONS.GEO_SETTINGS_WRITE]);
    });

    it.each(ALL_HANDLERS)(
      '%s rejects a non-admin with 403 even when they hold both permissions',
      (_label, handler, cls) => {
        expect(() => authorize(handler, cls, CONTRIBUTOR)).toThrow(ForbiddenException);
      },
    );

    it.each(ALL_HANDLERS)('%s rejects an unauthenticated request', (_label, handler, cls) => {
      expect(() => authorize(handler, cls, null)).toThrow(ForbiddenException);
    });

    it.each(READ_HANDLERS)('%s allows an admin holding only geo_settings:read', (
      _label,
      handler,
      cls,
    ) => {
      expect(authorize(handler, cls, ADMIN_READER)).toBe(true);
    });

    it.each(WRITE_HANDLERS)(
      '%s rejects an admin holding only geo_settings:read (read cannot mutate)',
      (_label, handler, cls) => {
        expect(() => authorize(handler, cls, ADMIN_READER)).toThrow(ForbiddenException);
      },
    );

    it.each(WRITE_HANDLERS)('%s allows an admin holding geo_settings:write', (
      _label,
      handler,
      cls,
    ) => {
      expect(authorize(handler, cls, ADMIN_WRITER)).toBe(true);
    });

    it('introduces NO new permission — every route reuses the geo pair', () => {
      const used = new Set<string>();
      for (const [, handler] of ALL_HANDLERS) {
        for (const p of (Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? []) as string[]) {
          used.add(p);
        }
      }
      expect([...used].sort()).toEqual(
        [PERMISSIONS.GEO_SETTINGS_READ, PERMISSIONS.GEO_SETTINGS_WRITE].sort(),
      );
    });
  });
});

/**
 * Unit tests for LocationGroupsController / LocationGroupsAdminController
 * (issue #374).
 *
 * Two things are verified:
 *
 *  1. Handler delegation to LocationGroupsService.
 *  2. RBAC. Rather than only reading the `@MemoriahubAuth` metadata back, the REAL
 *     identity-backed guard is driven against each handler with a
 *     synthetic user, so "non-admin ⇒ 403" and "geo_settings:read can list but
 *     not mutate" are asserted as enforcement, not as decorator trivia.
 */
import 'reflect-metadata';

import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';

import {
  LOCATION_PERMISSIONS as PERMISSIONS,
  LOCATION_ROLES as ROLES,
  LocationGroupsAdminController,
  LocationGroupsController,
  type LocationGroupsService,
} from '../../src/location/index.js';
import {
  MEMORIAHUB_PERMISSIONS_KEY as PERMISSIONS_KEY,
  MEMORIAHUB_ROLES_KEY as ROLES_KEY,
  MemoriahubAuthGuard,
} from '../../src/core/index.js';
import type { MemoriahubPrincipal } from '../../src/ports/index.js';

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

const controller = new LocationGroupsController(mockService as unknown as LocationGroupsService);
const adminController = new LocationGroupsAdminController(
  mockService as unknown as LocationGroupsService,
);

/** The synthetic caller a case runs as: roles and permissions, or none (unauthenticated). */
type Caller = { roles: string[]; permissions: string[] } | null;

/** Builds an ExecutionContext the real guard accepts, pointing at one handler. */
function contextFor(handler: (...args: any[]) => unknown, cls: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls.constructor,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

/** Runs the REAL identity-backed guard (over a fake identity port); resolves true only when it allows. */
async function authorize(handler: (...args: any[]) => unknown, cls: object, user: Caller): Promise<boolean> {
  const principal: MemoriahubPrincipal | null = user
    ? ({
        userId: 'u1',
        roles: user.roles,
        permissions: new Set(user.permissions),
        orgId: null,
        credential: { kind: 'jwt' },
      } as unknown as MemoriahubPrincipal)
    : null;
  const guard = new MemoriahubAuthGuard(new Reflector(), { authenticate: async () => principal } as never);
  return guard.canActivate(contextFor(handler, cls));
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
  roles: ['contributor'],
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
      async (_label, handler, cls) => {
        await expect(authorize(handler, cls, CONTRIBUTOR)).rejects.toThrow(ForbiddenException);
      },
    );

    it.each(ALL_HANDLERS)('%s rejects an unauthenticated request', async (_label, handler, cls) => {
      await expect(authorize(handler, cls, null)).rejects.toThrow(UnauthorizedException);
    });

    it.each(READ_HANDLERS)('%s allows an admin holding only geo_settings:read', async (
      _label,
      handler,
      cls,
    ) => {
      await expect(authorize(handler, cls, ADMIN_READER)).resolves.toBe(true);
    });

    it.each(WRITE_HANDLERS)(
      '%s rejects an admin holding only geo_settings:read (read cannot mutate)',
      async (_label, handler, cls) => {
        await expect(authorize(handler, cls, ADMIN_READER)).rejects.toThrow(ForbiddenException);
      },
    );

    it.each(WRITE_HANDLERS)('%s allows an admin holding geo_settings:write', async (
      _label,
      handler,
      cls,
    ) => {
      await expect(authorize(handler, cls, ADMIN_WRITER)).resolves.toBe(true);
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

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(async () => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionsGuard,
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<PermissionsGuard>(PermissionsGuard);
  });

  function createMockContext(user: Partial<AuthenticatedUser> | null = null): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  function createUserWithPermissions(permissionNames: string[]): Partial<AuthenticatedUser> {
    return {
      id: 'user-id',
      email: 'test@example.com',
      isActive: true,
      userRoles: [
        {
          role: {
            id: 'role-id',
            name: 'test-role',
            description: 'Test role',
            rolePermissions: permissionNames.map((name) => ({
              permission: {
                id: `perm-${name}`,
                name,
                description: `${name} permission`,
              },
            })),
          },
        },
      ],
    } as Partial<AuthenticatedUser>;
  }

  function createUserWithMultipleRoles(
    roles: Array<{ roleName: string; permissions: string[] }>,
  ): Partial<AuthenticatedUser> {
    return {
      id: 'user-id',
      email: 'test@example.com',
      isActive: true,
      userRoles: roles.map((roleData, idx) => ({
        role: {
          id: `role-${idx}`,
          name: roleData.roleName,
          description: `${roleData.roleName} role`,
          rolePermissions: roleData.permissions.map((permName) => ({
            permission: {
              id: `perm-${permName}`,
              name: permName,
              description: `${permName} permission`,
            },
          })),
        },
      })),
    } as Partial<AuthenticatedUser>;
  }

  describe('canActivate', () => {
    it('should allow access when no permissions required', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext(createUserWithPermissions([]));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when permissions array is empty', () => {
      reflector.getAllAndOverride.mockReturnValue([]);
      const context = createMockContext(createUserWithPermissions([]));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has required permission', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read']);
      const context = createMockContext(createUserWithPermissions(['users:read', 'users:write']));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has all required permissions', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read', 'users:write']);
      const context = createMockContext(
        createUserWithPermissions(['users:read', 'users:write', 'rbac:manage']),
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access when user lacks required permission', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:write']);
      const context = createMockContext(createUserWithPermissions(['users:read']));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('Missing permissions: users:write');
    });

    it('should deny access when user lacks one of multiple required permissions', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read', 'users:write']);
      const context = createMockContext(createUserWithPermissions(['users:read']));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('Missing permissions: users:write');
    });

    it('should deny access when user has no permissions', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read']);
      const context = createMockContext(createUserWithPermissions([]));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny access when no user in request', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read']);
      const context = createMockContext(null);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('No user in request');
    });

    it('should aggregate permissions from multiple roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read', 'system_settings:read']);
      const context = createMockContext(
        createUserWithMultipleRoles([
          { roleName: 'role1', permissions: ['users:read'] },
          { roleName: 'role2', permissions: ['system_settings:read'] },
        ]),
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny when permissions aggregated from multiple roles are insufficient', () => {
      reflector.getAllAndOverride.mockReturnValue([
        'users:read',
        'users:write',
        'system_settings:read',
      ]);
      const context = createMockContext(
        createUserWithMultipleRoles([
          { roleName: 'role1', permissions: ['users:read'] },
          { roleName: 'role2', permissions: ['system_settings:read'] },
        ]),
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('Missing permissions: users:write');
    });

    it('should handle duplicate permissions across roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read']);
      const context = createMockContext(
        createUserWithMultipleRoles([
          { roleName: 'role1', permissions: ['users:read'] },
          { roleName: 'role2', permissions: ['users:read'] },
        ]),
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should list all missing permissions in error message', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read', 'users:write', 'rbac:manage']);
      const context = createMockContext(createUserWithPermissions(['users:read']));

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('users:write');
      expect(() => guard.canActivate(context)).toThrow('rbac:manage');
    });

    it('should attach requestUser to request on successful authorization', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read']);
      const user = createUserWithPermissions(['users:read', 'users:write']);
      const request = { user };
      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
      } as any;

      guard.canActivate(context);

      expect(request).toHaveProperty('requestUser');
      expect((request as any).requestUser).toHaveProperty('id');
      expect((request as any).requestUser).toHaveProperty('permissions');
      expect((request as any).requestUser.permissions).toContain('users:read');
      expect((request as any).requestUser.permissions).toContain('users:write');
    });

    // Regression test for issue #406: a bare @Auth() route (no permissions
    // required — PermissionsGuard short-circuits with `return true`) must
    // still populate request.requestUser with the user's real, correctly
    // computed permissions array. Before this fix, request.requestUser was
    // left unset on this path, so @CurrentUser() fell back to the raw
    // AuthenticatedUser (no `.permissions` field at all), and any downstream
    // code reading `user.permissions.includes(...)` (e.g.
    // CircleMembershipService.assertCircleAccess) threw a TypeError
    // ("Cannot read properties of undefined (reading 'includes')") instead
    // of performing a real permission check.
    it('should populate request.requestUser with real permissions even when none are required', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const user = createUserWithPermissions(['circles:read', 'circles:write']);
      const request = { user };
      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
      } as any;

      expect(guard.canActivate(context)).toBe(true);

      expect(request).toHaveProperty('requestUser');
      const requestUser = (request as any).requestUser;
      expect(requestUser.id).toBe('user-id');
      expect(Array.isArray(requestUser.permissions)).toBe(true);
      expect(requestUser.permissions).toEqual(
        expect.arrayContaining(['circles:read', 'circles:write']),
      );
    });

    it('should populate request.requestUser even when the permissions array is empty', () => {
      reflector.getAllAndOverride.mockReturnValue([]);
      const user = createUserWithPermissions(['users:read']);
      const request = { user };
      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
      } as any;

      expect(guard.canActivate(context)).toBe(true);
      expect((request as any).requestUser).toBeDefined();
      expect((request as any).requestUser.permissions).toContain('users:read');
    });

    it('should still throw when no user is present, even if no permissions are required', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext(null);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('No user in request');
    });
  });
});

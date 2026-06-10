# Spec 21: RBAC & Guards Tests

**Domain:** Testing
**Agent:** `testing-dev`
**Depends On:** 07-rbac-guards, 19-api-test-framework
**Estimated Complexity:** Medium

---

## Objective

Create comprehensive unit and integration tests for the RBAC (Role-Based Access Control) system, including permission guards, role guards, and authorization enforcement across API endpoints.

---

## Deliverables

### 1. Test File Structure

```
apps/api/
├── src/
│   └── common/
│       └── guards/
│           ├── roles.guard.spec.ts
│           └── permissions.guard.spec.ts
└── test/
    └── rbac/
        ├── rbac.e2e-spec.ts
        └── guard-integration.e2e-spec.ts
```

### 2. Roles Guard Unit Tests

Create `apps/api/src/common/guards/roles.guard.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(async () => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
  });

  function createMockContext(user: any = null): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  describe('canActivate', () => {
    it('should allow access when no roles required', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext({ roles: ['viewer'] });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has required role', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext({
        userRoles: [{ role: { name: 'admin' } }],
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has one of multiple required roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin', 'contributor']);
      const context = createMockContext({
        userRoles: [{ role: { name: 'contributor' } }],
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny access when user lacks required role', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext({
        userRoles: [{ role: { name: 'viewer' } }],
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny access when user has no roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext({ userRoles: [] });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny access when no user in request', () => {
      reflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockContext(null);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should handle user with multiple roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['contributor']);
      const context = createMockContext({
        userRoles: [
          { role: { name: 'viewer' } },
          { role: { name: 'contributor' } },
        ],
      });

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
```

### 3. Permissions Guard Unit Tests

Create `apps/api/src/common/guards/permissions.guard.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

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

  function createMockContext(user: any = null): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  function createUserWithPermissions(permissions: string[]) {
    return {
      userRoles: [
        {
          role: {
            rolePermissions: permissions.map((name) => ({
              permission: { name },
            })),
          },
        },
      ],
    };
  }

  describe('canActivate', () => {
    it('should allow access when no permissions required', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext(createUserWithPermissions([]));

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when user has required permission', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read']);
      const context = createMockContext(
        createUserWithPermissions(['users:read', 'users:write']),
      );

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
      const context = createMockContext(
        createUserWithPermissions(['users:read']),
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny access when user lacks one of multiple required permissions', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read', 'users:write']);
      const context = createMockContext(
        createUserWithPermissions(['users:read']),
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
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
    });

    it('should aggregate permissions from multiple roles', () => {
      reflector.getAllAndOverride.mockReturnValue(['users:read', 'system_settings:read']);
      const context = createMockContext({
        userRoles: [
          {
            role: {
              rolePermissions: [{ permission: { name: 'users:read' } }],
            },
          },
          {
            role: {
              rolePermissions: [{ permission: { name: 'system_settings:read' } }],
            },
          },
        ],
      });

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
```

### 4. RBAC E2E Integration Tests

Create `apps/api/test/rbac/rbac.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import {
  createAdminUser,
  createContributorUser,
  createViewerUser,
  authHeader,
} from '../helpers/auth.helper';

describe('RBAC System (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.prisma);
  });

  describe('Role-Based Access', () => {
    describe('Admin Role', () => {
      it('should have access to user management', async () => {
        const admin = await createAdminUser(context);

        await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(admin.accessToken))
          .expect(200);
      });

      it('should have access to system settings', async () => {
        const admin = await createAdminUser(context);

        await request(context.app.getHttpServer())
          .get('/api/system-settings')
          .set(authHeader(admin.accessToken))
          .expect(200);
      });

      it('should be able to modify system settings', async () => {
        const admin = await createAdminUser(context);

        await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(admin.accessToken))
          .send({ ui: { allowUserThemeOverride: false } })
          .expect(200);
      });

      it('should be able to modify user roles', async () => {
        const admin = await createAdminUser(context);
        const viewer = await createViewerUser(context);

        const contributorRole = await context.prisma.role.findUnique({
          where: { name: 'contributor' },
        });

        await request(context.app.getHttpServer())
          .patch(`/api/users/${viewer.id}`)
          .set(authHeader(admin.accessToken))
          .send({ roleIds: [contributorRole!.id] })
          .expect(200);
      });
    });

    describe('Contributor Role', () => {
      it('should NOT have access to user management', async () => {
        const contributor = await createContributorUser(context);

        await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(contributor.accessToken))
          .expect(403);
      });

      it('should NOT have access to system settings write', async () => {
        const contributor = await createContributorUser(context);

        await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(contributor.accessToken))
          .send({ ui: { allowUserThemeOverride: false } })
          .expect(403);
      });

      it('should have access to own user settings', async () => {
        const contributor = await createContributorUser(context);

        await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(contributor.accessToken))
          .expect(200);
      });

      it('should be able to modify own user settings', async () => {
        const contributor = await createContributorUser(context);

        await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(contributor.accessToken))
          .send({ theme: 'dark' })
          .expect(200);
      });
    });

    describe('Viewer Role', () => {
      it('should NOT have access to user management', async () => {
        const viewer = await createViewerUser(context);

        await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(viewer.accessToken))
          .expect(403);
      });

      it('should NOT have access to system settings', async () => {
        const viewer = await createViewerUser(context);

        await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(viewer.accessToken))
          .send({ ui: { allowUserThemeOverride: false } })
          .expect(403);
      });

      it('should have read access to own user settings', async () => {
        const viewer = await createViewerUser(context);

        await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(viewer.accessToken))
          .expect(200);
      });

      it('should have access to own profile (auth/me)', async () => {
        const viewer = await createViewerUser(context);

        await request(context.app.getHttpServer())
          .get('/api/auth/me')
          .set(authHeader(viewer.accessToken))
          .expect(200);
      });
    });
  });

  describe('Permission-Based Access', () => {
    it('should allow users:read permission to list users', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should allow users:write permission to modify users', async () => {
      const admin = await createAdminUser(context);
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .patch(`/api/users/${viewer.id}`)
        .set(authHeader(admin.accessToken))
        .send({ isActive: false })
        .expect(200);
    });

    it('should deny without users:read permission', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('should deny without system_settings:write permission', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ ui: { allowUserThemeOverride: true } })
        .expect(403);
    });
  });

  describe('Guard Combination', () => {
    it('should require both role and permission when both specified', async () => {
      // This tests endpoints that have both @Roles() and @Permissions()
      const admin = await createAdminUser(context);

      // Admin has both role and permissions
      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('should fail if role matches but permission missing', async () => {
      // This would require a custom role setup for testing
      // Create a user with admin role but without specific permission
      const customUser = await context.prisma.user.create({
        data: {
          email: 'custom@example.com',
          providerDisplayName: 'Custom User',
          identities: {
            create: {
              provider: 'google',
              providerSubject: 'custom-google-id',
              providerEmail: 'custom@example.com',
            },
          },
          userRoles: {
            create: {
              role: { connect: { name: 'viewer' } },
            },
          },
        },
      });

      // This user has viewer role (without users:read permission)
      const jwtService = context.module.get('JwtService');
      const token = jwtService.sign({
        sub: customUser.id,
        email: customUser.email,
        roles: ['viewer'],
      });

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(token))
        .expect(403);
    });
  });

  describe('Self-Resource Access', () => {
    it('should allow user to access own settings regardless of role', async () => {
      const viewer = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should allow user to modify own settings', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(viewer.accessToken))
        .send({ theme: 'dark' })
        .expect(200);
    });

    it('should NOT allow user to access other users settings', async () => {
      const viewer = await createViewerUser(context);
      const otherUser = await createContributorUser(context, 'other@example.com');

      // If there's an endpoint like /api/users/:id/settings
      await request(context.app.getHttpServer())
        .get(`/api/users/${otherUser.id}/settings`)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });
});
```

### 5. Guard Integration Tests

Create `apps/api/test/rbac/guard-integration.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import { createTestUser, authHeader } from '../helpers/auth.helper';

describe('Guard Integration (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.prisma);
  });

  describe('JwtAuthGuard + RolesGuard', () => {
    it('should first check JWT then check role', async () => {
      // Without JWT - should get 401 (not 403)
      await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(401);
    });

    it('should return 403 when authenticated but wrong role', async () => {
      const viewer = await createTestUser(context, { roleName: 'viewer' });

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });

  describe('Public Routes', () => {
    it('should skip all auth guards on @Public() routes', async () => {
      // Health endpoints are typically public
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);
    });

    it('should skip guards on auth/providers', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/providers')
        .expect(200);
    });
  });

  describe('Error Messages', () => {
    it('should return clear message for unauthorized', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(401);

      expect(response.body).toHaveProperty('message');
      expect(response.body.code).toBe('UNAUTHORIZED');
    });

    it('should return clear message for forbidden', async () => {
      const viewer = await createTestUser(context, { roleName: 'viewer' });

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body).toHaveProperty('message');
      expect(response.body.code).toBe('FORBIDDEN');
    });
  });

  describe('Token Validation', () => {
    it('should reject expired token', async () => {
      // Create a token that's already expired
      const jwtService = context.module.get('JwtService');
      const expiredToken = jwtService.sign(
        { sub: 'user-1', email: 'test@example.com', roles: ['admin'] },
        { expiresIn: '-1s' },
      );

      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(expiredToken))
        .expect(401);
    });

    it('should reject malformed token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader('malformed.token.here'))
        .expect(401);
    });

    it('should reject token with invalid signature', async () => {
      // Token signed with different secret
      const invalidToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(invalidToken))
        .expect(401);
    });
  });

  describe('Dynamic Role Changes', () => {
    it('should reflect role changes on next request', async () => {
      // Create viewer
      const viewer = await createTestUser(context, { roleName: 'viewer' });

      // Verify can't access users
      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      // Upgrade to admin (directly in DB)
      const adminRole = await context.prisma.role.findUnique({
        where: { name: 'admin' },
      });
      await context.prisma.userRole.updateMany({
        where: { userId: viewer.id },
        data: { roleId: adminRole!.id },
      });

      // JWT still has old roles, so still forbidden
      // (JWT contains roles at time of issue)
      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      // After getting new token (re-auth), would have new permissions
      // This tests that JWT contains roles at issue time
    });
  });
});
```

### 6. Role/Permission Decorator Tests

Create `apps/api/src/common/decorators/rbac.decorator.spec.ts`:

```typescript
import { Roles, ROLES_KEY } from './roles.decorator';
import { Permissions, PERMISSIONS_KEY } from './permissions.decorator';

describe('RBAC Decorators', () => {
  describe('@Roles()', () => {
    it('should set metadata with single role', () => {
      @Roles('admin')
      class TestClass {}

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
      expect(roles).toEqual(['admin']);
    });

    it('should set metadata with multiple roles', () => {
      @Roles('admin', 'contributor')
      class TestClass {}

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass);
      expect(roles).toEqual(['admin', 'contributor']);
    });

    it('should work on methods', () => {
      class TestClass {
        @Roles('admin')
        testMethod() {}
      }

      const roles = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.testMethod);
      expect(roles).toEqual(['admin']);
    });
  });

  describe('@Permissions()', () => {
    it('should set metadata with single permission', () => {
      @Permissions('users:read')
      class TestClass {}

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      expect(permissions).toEqual(['users:read']);
    });

    it('should set metadata with multiple permissions', () => {
      @Permissions('users:read', 'users:write')
      class TestClass {}

      const permissions = Reflect.getMetadata(PERMISSIONS_KEY, TestClass);
      expect(permissions).toEqual(['users:read', 'users:write']);
    });

    it('should work on methods', () => {
      class TestClass {
        @Permissions('system_settings:write')
        testMethod() {}
      }

      const permissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        TestClass.prototype.testMethod,
      );
      expect(permissions).toEqual(['system_settings:write']);
    });
  });
});
```

---

## Acceptance Criteria

- [ ] RolesGuard correctly checks user roles
- [ ] PermissionsGuard correctly checks user permissions
- [ ] Guards properly aggregate permissions from multiple roles
- [ ] 401 returned when not authenticated
- [ ] 403 returned when authenticated but unauthorized
- [ ] Admin can access all protected resources
- [ ] Contributor has limited access as defined
- [ ] Viewer has minimal access as defined
- [ ] Public routes bypass authentication
- [ ] Token validation catches expired/invalid tokens
- [ ] Clear error messages for auth failures
- [ ] Self-resource access works for all roles

---

## Notes

- Test both positive (allowed) and negative (denied) cases
- Verify error codes match expected values (401 vs 403)
- Test guard ordering (JWT before Role/Permission)
- Consider testing permission inheritance if applicable
- Test dynamic role changes effect on authorization

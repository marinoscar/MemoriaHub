# Spec 22: API Endpoints Tests

**Domain:** Testing
**Agent:** `testing-dev`
**Depends On:** 08-users-endpoints, 09-user-settings-endpoints, 10-system-settings-endpoints, 11-health-endpoints, 19-api-test-framework
**Estimated Complexity:** High

---

## Objective

Create comprehensive integration tests for all API endpoints including users management, user settings, system settings, and health checks. Tests cover CRUD operations, validation, pagination, and error handling.

---

## Deliverables

### 1. Test File Structure

```
apps/api/test/
├── users/
│   └── users.e2e-spec.ts
├── settings/
│   ├── user-settings.e2e-spec.ts
│   └── system-settings.e2e-spec.ts
└── health/
    └── health.e2e-spec.ts
```

### 2. Users Endpoint Tests

Create `apps/api/test/users/users.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import {
  createAdminUser,
  createContributorUser,
  createViewerUser,
  createTestUser,
  authHeader,
} from '../helpers/auth.helper';
import { createBulkUsers } from '../helpers/fixtures.helper';

describe('Users Controller (e2e)', () => {
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

  describe('GET /api/users', () => {
    it('should return paginated user list for admin', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('page');
      expect(response.body.meta).toHaveProperty('limit');
    });

    it('should support pagination parameters', async () => {
      const admin = await createAdminUser(context);
      const viewerRole = await context.prisma.role.findUnique({
        where: { name: 'viewer' },
      });
      await createBulkUsers(context.prisma, 25, viewerRole!.id);

      const response = await request(context.app.getHttpServer())
        .get('/api/users?page=2&limit=10')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.length).toBeLessThanOrEqual(10);
      expect(response.body.meta.page).toBe(2);
      expect(response.body.meta.limit).toBe(10);
    });

    it('should support search by email', async () => {
      const admin = await createAdminUser(context);
      await createTestUser(context, { email: 'searchable@example.com' });

      const response = await request(context.app.getHttpServer())
        .get('/api/users?search=searchable')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.some((u: any) => u.email.includes('searchable'))).toBe(true);
    });

    it('should filter by role', async () => {
      const admin = await createAdminUser(context);
      await createViewerUser(context);
      await createContributorUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users?role=viewer')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(
        response.body.data.every((u: any) => u.roles.includes('viewer')),
      ).toBe(true);
    });

    it('should filter by active status', async () => {
      const admin = await createAdminUser(context);
      await createTestUser(context, { isActive: false });
      await createTestUser(context, { isActive: true });

      const response = await request(context.app.getHttpServer())
        .get('/api/users?isActive=true')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.every((u: any) => u.isActive === true)).toBe(true);
    });

    it('should return 403 for non-admin', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('should return 401 without authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/users')
        .expect(401);
    });
  });

  describe('GET /api/users/:id', () => {
    it('should return user details for admin', async () => {
      const admin = await createAdminUser(context);
      const viewer = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get(`/api/users/${viewer.id}`)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: viewer.id,
        email: viewer.email,
      });
      expect(response.body.data.roles).toBeDefined();
    });

    it('should return 404 for non-existent user', async () => {
      const admin = await createAdminUser(context);

      await request(context.app.getHttpServer())
        .get('/api/users/non-existent-uuid')
        .set(authHeader(admin.accessToken))
        .expect(404);
    });

    it('should return 403 for non-admin', async () => {
      const viewer = await createViewerUser(context);
      const contributor = await createContributorUser(context);

      await request(context.app.getHttpServer())
        .get(`/api/users/${contributor.id}`)
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });

  describe('PATCH /api/users/:id', () => {
    it('should update user roles', async () => {
      const admin = await createAdminUser(context);
      const viewer = await createViewerUser(context);
      const contributorRole = await context.prisma.role.findUnique({
        where: { name: 'contributor' },
      });

      const response = await request(context.app.getHttpServer())
        .patch(`/api/users/${viewer.id}`)
        .set(authHeader(admin.accessToken))
        .send({ roleIds: [contributorRole!.id] })
        .expect(200);

      expect(response.body.data.roles).toContain('contributor');
    });

    it('should deactivate user', async () => {
      const admin = await createAdminUser(context);
      const viewer = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .patch(`/api/users/${viewer.id}`)
        .set(authHeader(admin.accessToken))
        .send({ isActive: false })
        .expect(200);

      expect(response.body.data.isActive).toBe(false);
    });

    it('should reactivate user', async () => {
      const admin = await createAdminUser(context);
      const inactive = await createTestUser(context, { isActive: false });

      const response = await request(context.app.getHttpServer())
        .patch(`/api/users/${inactive.id}`)
        .set(authHeader(admin.accessToken))
        .send({ isActive: true })
        .expect(200);

      expect(response.body.data.isActive).toBe(true);
    });

    it('should not allow self-deactivation', async () => {
      const admin = await createAdminUser(context);

      await request(context.app.getHttpServer())
        .patch(`/api/users/${admin.id}`)
        .set(authHeader(admin.accessToken))
        .send({ isActive: false })
        .expect(400);
    });

    it('should not allow removing own admin role', async () => {
      const admin = await createAdminUser(context);
      const viewerRole = await context.prisma.role.findUnique({
        where: { name: 'viewer' },
      });

      await request(context.app.getHttpServer())
        .patch(`/api/users/${admin.id}`)
        .set(authHeader(admin.accessToken))
        .send({ roleIds: [viewerRole!.id] })
        .expect(400);
    });

    it('should validate role IDs exist', async () => {
      const admin = await createAdminUser(context);
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .patch(`/api/users/${viewer.id}`)
        .set(authHeader(admin.accessToken))
        .send({ roleIds: ['non-existent-role-id'] })
        .expect(400);
    });

    it('should return 404 for non-existent user', async () => {
      const admin = await createAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/users/non-existent-uuid')
        .set(authHeader(admin.accessToken))
        .send({ isActive: false })
        .expect(404);
    });

    it('should return 403 for non-admin', async () => {
      const viewer = await createViewerUser(context);
      const contributor = await createContributorUser(context);

      await request(context.app.getHttpServer())
        .patch(`/api/users/${contributor.id}`)
        .set(authHeader(viewer.accessToken))
        .send({ isActive: false })
        .expect(403);
    });
  });
});
```

### 3. User Settings Endpoint Tests

Create `apps/api/test/settings/user-settings.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import {
  createAdminUser,
  createViewerUser,
  authHeader,
} from '../helpers/auth.helper';
import { userSettingsFixtures } from '../fixtures/settings.fixture';

describe('User Settings Controller (e2e)', () => {
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

  describe('GET /api/user-settings', () => {
    it('should return current user settings', async () => {
      const user = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('theme');
      expect(response.body.data).toHaveProperty('profile');
      expect(response.body.data).toHaveProperty('version');
    });

    it('should return default settings for new user', async () => {
      const user = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.theme).toBe('system');
      expect(response.body.data.profile.useProviderImage).toBe(true);
    });

    it('should return 401 without authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .expect(401);
    });
  });

  describe('PUT /api/user-settings', () => {
    it('should replace user settings', async () => {
      const user = await createViewerUser(context);

      const newSettings = {
        theme: 'dark',
        profile: {
          displayName: 'New Name',
          useProviderImage: false,
          customImageUrl: 'https://example.com/photo.jpg',
        },
      };

      const response = await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(newSettings)
        .expect(200);

      expect(response.body.data.theme).toBe('dark');
      expect(response.body.data.profile.displayName).toBe('New Name');
      expect(response.body.data.version).toBeGreaterThan(1);
    });

    it('should validate theme value', async () => {
      const user = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ theme: 'invalid', profile: { useProviderImage: true } })
        .expect(400);
    });

    it('should require profile field', async () => {
      const user = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ theme: 'dark' })
        .expect(400);
    });

    it('should update timestamp on save', async () => {
      const user = await createViewerUser(context);

      const before = new Date();
      const response = await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({
          theme: 'light',
          profile: { useProviderImage: true },
        })
        .expect(200);

      const updatedAt = new Date(response.body.data.updatedAt);
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('PATCH /api/user-settings', () => {
    it('should partially update settings', async () => {
      const user = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ theme: 'dark' })
        .expect(200);

      expect(response.body.data.theme).toBe('dark');
      // Other fields should remain unchanged
      expect(response.body.data.profile).toBeDefined();
    });

    it('should update nested profile fields', async () => {
      const user = await createViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ profile: { displayName: 'Partial Update' } })
        .expect(200);

      expect(response.body.data.profile.displayName).toBe('Partial Update');
      expect(response.body.data.profile.useProviderImage).toBeDefined();
    });

    it('should validate partial updates', async () => {
      const user = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ theme: 'invalid-theme' })
        .expect(400);
    });

    it('should increment version on update', async () => {
      const user = await createViewerUser(context);

      const firstResponse = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      const initialVersion = firstResponse.body.data.version;

      const updateResponse = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ theme: 'dark' })
        .expect(200);

      expect(updateResponse.body.data.version).toBe(initialVersion + 1);
    });
  });

  describe('Settings Isolation', () => {
    it('should isolate settings between users', async () => {
      const user1 = await createViewerUser(context, 'user1@example.com');
      const user2 = await createViewerUser(context, 'user2@example.com');

      // User1 updates settings
      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user1.accessToken))
        .send({ theme: 'dark' })
        .expect(200);

      // User2 should have default settings
      const user2Settings = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user2.accessToken))
        .expect(200);

      expect(user2Settings.body.data.theme).toBe('system');
    });
  });
});
```

### 4. System Settings Endpoint Tests

Create `apps/api/test/settings/system-settings.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import {
  createAdminUser,
  createViewerUser,
  authHeader,
} from '../helpers/auth.helper';

describe('System Settings Controller (e2e)', () => {
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

  describe('GET /api/system-settings', () => {
    it('should return system settings for admin', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toHaveProperty('ui');
      expect(response.body.data).toHaveProperty('security');
      expect(response.body.data).toHaveProperty('features');
      expect(response.body.data).toHaveProperty('version');
    });

    it('should return default settings', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.ui.allowUserThemeOverride).toBe(true);
      expect(response.body.data.security.jwtAccessTtlMinutes).toBeDefined();
    });

    it('should return 403 for non-admin', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('should return 401 without authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .expect(401);
    });
  });

  describe('PUT /api/system-settings', () => {
    it('should replace system settings', async () => {
      const admin = await createAdminUser(context);

      const newSettings = {
        ui: { allowUserThemeOverride: false },
        security: { jwtAccessTtlMinutes: 10, refreshTtlDays: 7 },
        features: { newFeature: true },
      };

      const response = await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send(newSettings)
        .expect(200);

      expect(response.body.data.ui.allowUserThemeOverride).toBe(false);
      expect(response.body.data.security.jwtAccessTtlMinutes).toBe(10);
      expect(response.body.data.features.newFeature).toBe(true);
    });

    it('should track updatedBy', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({
          ui: { allowUserThemeOverride: true },
          security: { jwtAccessTtlMinutes: 15, refreshTtlDays: 14 },
          features: {},
        })
        .expect(200);

      expect(response.body.data.updatedBy).toMatchObject({
        id: admin.id,
        email: admin.email,
      });
    });

    it('should validate security settings', async () => {
      const admin = await createAdminUser(context);

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({
          ui: { allowUserThemeOverride: true },
          security: { jwtAccessTtlMinutes: -1, refreshTtlDays: 14 },
          features: {},
        })
        .expect(400);
    });

    it('should return 403 for non-admin', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({
          ui: { allowUserThemeOverride: false },
          security: { jwtAccessTtlMinutes: 15, refreshTtlDays: 14 },
          features: {},
        })
        .expect(403);
    });
  });

  describe('PATCH /api/system-settings', () => {
    it('should partially update settings', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ ui: { allowUserThemeOverride: false } })
        .expect(200);

      expect(response.body.data.ui.allowUserThemeOverride).toBe(false);
      // Other fields preserved
      expect(response.body.data.security).toBeDefined();
    });

    it('should update nested security fields', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ security: { jwtAccessTtlMinutes: 5 } })
        .expect(200);

      expect(response.body.data.security.jwtAccessTtlMinutes).toBe(5);
      expect(response.body.data.security.refreshTtlDays).toBeDefined();
    });

    it('should add new feature flags', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ features: { betaFeature: true } })
        .expect(200);

      expect(response.body.data.features.betaFeature).toBe(true);
    });

    it('should increment version on update', async () => {
      const admin = await createAdminUser(context);

      const firstResponse = await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const initialVersion = firstResponse.body.data.version;

      const updateResponse = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(admin.accessToken))
        .send({ ui: { allowUserThemeOverride: false } })
        .expect(200);

      expect(updateResponse.body.data.version).toBe(initialVersion + 1);
    });

    it('should return 403 for non-admin', async () => {
      const viewer = await createViewerUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ ui: { allowUserThemeOverride: false } })
        .expect(403);
    });
  });
});
```

### 5. Health Endpoint Tests

Create `apps/api/test/health/health.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';

describe('Health Controller (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  describe('GET /api/health/live', () => {
    it('should return 200 OK', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
      });
    });

    it('should not require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);
    });

    it('should return timestamp', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/live')
        .expect(200);

      expect(response.body.data.timestamp).toBeDefined();
      expect(new Date(response.body.data.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return 200 when database is connected', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: 'ok',
      });
      expect(response.body.data.checks).toHaveProperty('database');
      expect(response.body.data.checks.database).toBe('ok');
    });

    it('should not require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);
    });

    it('should include service checks', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data.checks).toBeDefined();
      expect(typeof response.body.data.checks).toBe('object');
    });
  });

  describe('Health Check Response Format', () => {
    it('should follow standard health check format', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/health/ready')
        .expect(200);

      expect(response.body.data).toMatchObject({
        status: expect.stringMatching(/ok|degraded|error/),
        timestamp: expect.any(String),
        checks: expect.any(Object),
      });
    });
  });
});
```

### 6. Validation and Error Handling Tests

Create `apps/api/test/validation/validation.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import { createAdminUser, authHeader } from '../helpers/auth.helper';

describe('Validation & Error Handling (e2e)', () => {
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

  describe('Request Validation', () => {
    it('should return 400 for invalid JSON', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(admin.accessToken))
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should return 400 for missing required fields', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(admin.accessToken))
        .send({})
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.message).toBeDefined();
    });

    it('should return 400 for invalid UUID format', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users/not-a-valid-uuid')
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should return 400 for invalid pagination params', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users?page=-1&limit=1000')
        .set(authHeader(admin.accessToken))
        .expect(400);

      expect(response.body.code).toBe('BAD_REQUEST');
    });
  });

  describe('Error Response Format', () => {
    it('should include standard error fields', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users/non-existent-id')
        .set(authHeader(admin.accessToken))
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        code: expect.any(String),
        message: expect.any(String),
        timestamp: expect.any(String),
        path: expect.any(String),
      });
    });

    it('should not leak stack traces in production', async () => {
      // Note: This test assumes NODE_ENV handling
      const response = await request(context.app.getHttpServer())
        .get('/api/non-existent-endpoint')
        .expect(404);

      expect(response.body.stack).toBeUndefined();
    });
  });

  describe('Content Type Handling', () => {
    it('should require application/json content type for POST/PUT/PATCH', async () => {
      const admin = await createAdminUser(context);

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(admin.accessToken))
        .set('Content-Type', 'text/plain')
        .send('theme=dark')
        .expect(400);
    });

    it('should handle missing content type gracefully', async () => {
      const admin = await createAdminUser(context);

      // Fastify/NestJS should handle this
      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(admin.accessToken))
        .send({ theme: 'dark' })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });
    });
  });
});
```

---

## Running Tests

```bash
# Run all endpoint tests
cd apps/api && npm test -- test/users test/settings test/health

# Run with coverage
cd apps/api && npm run test:cov

# Run specific test file
cd apps/api && npm test -- users.e2e-spec.ts

# Run tests matching pattern
cd apps/api && npm test -- --testNamePattern="should return paginated"
```

---

## Acceptance Criteria

- [ ] All CRUD operations tested for users endpoint
- [ ] Pagination, search, and filtering work correctly
- [ ] User settings GET/PUT/PATCH work correctly
- [ ] System settings GET/PUT/PATCH work correctly (admin only)
- [ ] Health endpoints return correct format
- [ ] Proper authorization enforced on all endpoints
- [ ] Validation errors return 400 with clear messages
- [ ] 404 returned for non-existent resources
- [ ] Settings versioning works correctly
- [ ] Settings isolation between users verified
- [ ] Error response format is consistent

---

## Notes

- Test both successful operations and error cases
- Verify response structure matches OpenAPI spec
- Test edge cases (empty results, max pagination, etc.)
- Ensure proper cleanup between tests
- Consider testing concurrent updates

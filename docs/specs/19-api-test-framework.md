# Spec 19: API Test Framework Setup

**Domain:** Testing
**Agent:** `testing-dev`
**Depends On:** 04-api-core-setup
**Estimated Complexity:** Medium

---

## Objective

Set up a comprehensive testing framework for the NestJS API including Jest configuration, Supertest integration, test database management, OAuth mocking utilities, and reusable test helpers.

---

## Deliverables

### 1. Test Directory Structure

```
apps/api/
├── test/
│   ├── jest.config.js
│   ├── setup.ts
│   ├── teardown.ts
│   ├── helpers/
│   │   ├── test-app.helper.ts
│   │   ├── auth.helper.ts
│   │   ├── database.helper.ts
│   │   └── fixtures.helper.ts
│   ├── mocks/
│   │   ├── google-oauth.mock.ts
│   │   └── prisma.mock.ts
│   └── fixtures/
│       ├── users.fixture.ts
│       ├── roles.fixture.ts
│       └── settings.fixture.ts
├── src/
│   └── **/*.spec.ts (unit tests co-located)
└── package.json (test scripts)
```

### 2. Jest Configuration

Create `apps/api/test/jest.config.js`:

```javascript
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
```

### 3. Test Setup

Create `apps/api/test/setup.ts`:

```typescript
import { config } from 'dotenv';
import { resolve } from 'path';

// Load test environment variables
config({ path: resolve(__dirname, '../.env.test') });

// Set test environment
process.env.NODE_ENV = 'test';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Global test utilities
beforeAll(async () => {
  // Any global setup
});

afterAll(async () => {
  // Any global cleanup
});
```

Create `apps/api/test/teardown.ts`:

```typescript
export default async function teardown() {
  // Global teardown after all tests complete
  console.log('\nTest suite completed. Cleaning up...');
}
```

### 4. Test App Helper

Create `apps/api/test/helpers/test-app.helper.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ValidationPipe } from '@nestjs/common';

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  module: TestingModule;
}

/**
 * Creates a fully configured test application
 */
export async function createTestApp(): Promise<TestContext> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const prisma = moduleFixture.get<PrismaService>(PrismaService);

  return { app, prisma, module: moduleFixture };
}

/**
 * Creates a minimal test module for unit testing
 */
export async function createTestModule(
  imports: any[] = [],
  providers: any[] = [],
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports,
    providers,
  }).compile();
}

/**
 * Closes the test application and cleans up
 */
export async function closeTestApp(context: TestContext): Promise<void> {
  await context.prisma.$disconnect();
  await context.app.close();
}
```

### 5. Database Helper

Create `apps/api/test/helpers/database.helper.ts`:

```typescript
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Cleans all data from test database
 * Preserves table structure, only truncates data
 */
export async function cleanDatabase(prisma: PrismaService): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('cleanDatabase can only be called in test environment');
  }

  // Delete in order respecting foreign key constraints
  await prisma.$transaction([
    prisma.auditEvent.deleteMany(),
    prisma.userSettings.deleteMany(),
    prisma.systemSettings.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.userIdentity.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
  ]);
}

/**
 * Seeds the database with base data (roles, permissions)
 */
export async function seedBaseData(prisma: PrismaService): Promise<void> {
  // Create permissions
  const permissions = [
    { name: 'system_settings:read', description: 'Read system settings' },
    { name: 'system_settings:write', description: 'Modify system settings' },
    { name: 'user_settings:read', description: 'Read user settings' },
    { name: 'user_settings:write', description: 'Modify user settings' },
    { name: 'users:read', description: 'Read user data' },
    { name: 'users:write', description: 'Modify user data' },
    { name: 'rbac:manage', description: 'Manage roles and permissions' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
  }

  // Create roles
  const roles = [
    { name: 'admin', description: 'Full system access' },
    { name: 'contributor', description: 'Standard user capabilities' },
    { name: 'viewer', description: 'Read-only access' },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });
  }

  // Assign permissions to roles
  const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });
  const contributorRole = await prisma.role.findUnique({ where: { name: 'contributor' } });
  const viewerRole = await prisma.role.findUnique({ where: { name: 'viewer' } });

  const allPermissions = await prisma.permission.findMany();

  // Admin gets all permissions
  for (const perm of allPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: adminRole!.id, permissionId: perm.id },
      },
      update: {},
      create: { roleId: adminRole!.id, permissionId: perm.id },
    });
  }

  // Contributor permissions
  const contributorPerms = ['user_settings:read', 'user_settings:write'];
  for (const permName of contributorPerms) {
    const perm = allPermissions.find((p) => p.name === permName);
    if (perm) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: contributorRole!.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: contributorRole!.id, permissionId: perm.id },
      });
    }
  }

  // Viewer permissions
  const viewerPerms = ['user_settings:read'];
  for (const permName of viewerPerms) {
    const perm = allPermissions.find((p) => p.name === permName);
    if (perm) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: viewerRole!.id, permissionId: perm.id },
        },
        update: {},
        create: { roleId: viewerRole!.id, permissionId: perm.id },
      });
    }
  }

  // Create default system settings
  await prisma.systemSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      value: {
        ui: { allowUserThemeOverride: true },
        security: { jwtAccessTtlMinutes: 15, refreshTtlDays: 14 },
        features: {},
        updatedAt: new Date().toISOString(),
        updatedBy: null,
        version: 1,
      },
    },
  });
}

/**
 * Resets database to clean state with base data
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await cleanDatabase(prisma);
  await seedBaseData(prisma);
}
```

### 6. Auth Helper

Create `apps/api/test/helpers/auth.helper.ts`:

```typescript
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TestContext } from './test-app.helper';

export interface TestUser {
  id: string;
  email: string;
  roles: string[];
  accessToken: string;
}

/**
 * Creates a test user with specified role and returns auth token
 */
export async function createTestUser(
  context: TestContext,
  options: {
    email?: string;
    roleName?: string;
    isActive?: boolean;
  } = {},
): Promise<TestUser> {
  const {
    email = `test-${Date.now()}@example.com`,
    roleName = 'viewer',
    isActive = true,
  } = options;

  const { prisma, module } = context;
  const jwtService = module.get<JwtService>(JwtService);

  // Get role
  const role = await prisma.role.findUnique({
    where: { name: roleName },
  });

  if (!role) {
    throw new Error(`Role ${roleName} not found. Did you seed the database?`);
  }

  // Create user
  const user = await prisma.user.create({
    data: {
      email,
      providerDisplayName: 'Test User',
      isActive,
      identities: {
        create: {
          provider: 'google',
          providerSubject: `google-${Date.now()}`,
          providerEmail: email,
        },
      },
      userRoles: {
        create: {
          roleId: role.id,
        },
      },
      userSettings: {
        create: {
          value: {
            theme: 'system',
            profile: { useProviderImage: true },
            updatedAt: new Date().toISOString(),
            version: 1,
          },
        },
      },
    },
    include: {
      userRoles: {
        include: { role: true },
      },
    },
  });

  // Generate JWT
  const roles = user.userRoles.map((ur) => ur.role.name);
  const accessToken = jwtService.sign({
    sub: user.id,
    email: user.email,
    roles,
  });

  return {
    id: user.id,
    email: user.email,
    roles,
    accessToken,
  };
}

/**
 * Creates an admin test user
 */
export async function createAdminUser(
  context: TestContext,
  email?: string,
): Promise<TestUser> {
  return createTestUser(context, { email, roleName: 'admin' });
}

/**
 * Creates a contributor test user
 */
export async function createContributorUser(
  context: TestContext,
  email?: string,
): Promise<TestUser> {
  return createTestUser(context, { email, roleName: 'contributor' });
}

/**
 * Creates a viewer test user
 */
export async function createViewerUser(
  context: TestContext,
  email?: string,
): Promise<TestUser> {
  return createTestUser(context, { email, roleName: 'viewer' });
}

/**
 * Creates an inactive test user
 */
export async function createInactiveUser(
  context: TestContext,
  email?: string,
): Promise<TestUser> {
  return createTestUser(context, { email, isActive: false });
}

/**
 * Helper to set Authorization header
 */
export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
```

### 7. Fixtures Helper

Create `apps/api/test/helpers/fixtures.helper.ts`:

```typescript
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Creates multiple test users for batch testing
 */
export async function createBulkUsers(
  prisma: PrismaService,
  count: number,
  roleId: string,
): Promise<string[]> {
  const userIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const user = await prisma.user.create({
      data: {
        email: `bulk-user-${i}-${Date.now()}@example.com`,
        providerDisplayName: `Bulk User ${i}`,
        identities: {
          create: {
            provider: 'google',
            providerSubject: `bulk-google-${i}-${Date.now()}`,
            providerEmail: `bulk-user-${i}-${Date.now()}@example.com`,
          },
        },
        userRoles: {
          create: { roleId },
        },
      },
    });
    userIds.push(user.id);
  }

  return userIds;
}

/**
 * Creates a user with custom settings
 */
export async function createUserWithSettings(
  prisma: PrismaService,
  roleId: string,
  settings: Record<string, unknown>,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `settings-user-${Date.now()}@example.com`,
      providerDisplayName: 'Settings Test User',
      identities: {
        create: {
          provider: 'google',
          providerSubject: `settings-google-${Date.now()}`,
          providerEmail: `settings-user-${Date.now()}@example.com`,
        },
      },
      userRoles: {
        create: { roleId },
      },
      userSettings: {
        create: {
          value: settings,
        },
      },
    },
  });

  return user.id;
}
```

### 8. Google OAuth Mock

Create `apps/api/test/mocks/google-oauth.mock.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';

export interface MockGoogleProfile {
  id: string;
  email: string;
  displayName: string;
  picture?: string;
}

/**
 * Mock Google OAuth strategy for testing
 * Bypasses actual Google OAuth and returns mock profile
 */
@Injectable()
export class MockGoogleStrategy extends PassportStrategy(Strategy, 'google') {
  static mockProfile: MockGoogleProfile = {
    id: 'google-123456',
    email: 'test@example.com',
    displayName: 'Test User',
    picture: 'https://example.com/photo.jpg',
  };

  constructor() {
    super((req: any, done: any) => {
      done(null, MockGoogleStrategy.mockProfile);
    });
  }

  /**
   * Set the mock profile for the next authentication
   */
  static setMockProfile(profile: Partial<MockGoogleProfile>): void {
    MockGoogleStrategy.mockProfile = {
      ...MockGoogleStrategy.mockProfile,
      ...profile,
    };
  }

  /**
   * Reset mock profile to defaults
   */
  static resetMockProfile(): void {
    MockGoogleStrategy.mockProfile = {
      id: 'google-123456',
      email: 'test@example.com',
      displayName: 'Test User',
      picture: 'https://example.com/photo.jpg',
    };
  }
}

/**
 * Creates a mock profile for testing
 */
export function createMockGoogleProfile(
  overrides: Partial<MockGoogleProfile> = {},
): MockGoogleProfile {
  return {
    id: `google-${Date.now()}`,
    email: `user-${Date.now()}@example.com`,
    displayName: 'Mock User',
    picture: 'https://example.com/photo.jpg',
    ...overrides,
  };
}
```

### 9. Prisma Mock

Create `apps/api/test/mocks/prisma.mock.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';

export type MockPrismaService = DeepMockProxy<PrismaClient>;

export const mockPrisma = mockDeep<PrismaClient>();

export function resetPrismaMock(): void {
  mockReset(mockPrisma);
}

/**
 * Creates a mock PrismaService for unit tests
 */
export function createMockPrismaService(): MockPrismaService {
  return mockDeep<PrismaClient>();
}
```

### 10. User Fixtures

Create `apps/api/test/fixtures/users.fixture.ts`:

```typescript
export const userFixtures = {
  validUser: {
    email: 'valid@example.com',
    providerDisplayName: 'Valid User',
    providerProfileImageUrl: 'https://example.com/photo.jpg',
    isActive: true,
  },

  inactiveUser: {
    email: 'inactive@example.com',
    providerDisplayName: 'Inactive User',
    isActive: false,
  },

  adminUser: {
    email: 'admin@example.com',
    providerDisplayName: 'Admin User',
    isActive: true,
  },

  googleIdentity: {
    provider: 'google',
    providerSubject: 'google-test-123',
    providerEmail: 'test@example.com',
  },
};

export const googleProfileFixtures = {
  newUser: {
    id: 'google-new-user',
    email: 'newuser@example.com',
    displayName: 'New User',
    picture: 'https://example.com/new.jpg',
  },

  existingUser: {
    id: 'google-existing',
    email: 'existing@example.com',
    displayName: 'Existing User',
    picture: 'https://example.com/existing.jpg',
  },

  adminBootstrap: {
    id: 'google-admin',
    email: process.env.INITIAL_ADMIN_EMAIL || 'admin@example.com',
    displayName: 'Admin Bootstrap User',
    picture: 'https://example.com/admin.jpg',
  },
};
```

### 11. Settings Fixtures

Create `apps/api/test/fixtures/settings.fixture.ts`:

```typescript
export const userSettingsFixtures = {
  default: {
    theme: 'system',
    profile: {
      useProviderImage: true,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },

  darkTheme: {
    theme: 'dark',
    profile: {
      useProviderImage: true,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },

  customProfile: {
    theme: 'light',
    profile: {
      displayName: 'Custom Name',
      useProviderImage: false,
      customImageUrl: 'https://example.com/custom.jpg',
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },
};

export const systemSettingsFixtures = {
  default: {
    ui: {
      allowUserThemeOverride: true,
    },
    security: {
      jwtAccessTtlMinutes: 15,
      refreshTtlDays: 14,
    },
    features: {},
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    version: 1,
  },

  restrictive: {
    ui: {
      allowUserThemeOverride: false,
    },
    security: {
      jwtAccessTtlMinutes: 5,
      refreshTtlDays: 7,
    },
    features: {
      newFeature: false,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    version: 1,
  },
};
```

### 12. Roles Fixtures

Create `apps/api/test/fixtures/roles.fixture.ts`:

```typescript
export const roleFixtures = {
  admin: {
    name: 'admin',
    description: 'Full system access',
  },
  contributor: {
    name: 'contributor',
    description: 'Standard user capabilities',
  },
  viewer: {
    name: 'viewer',
    description: 'Read-only access',
  },
};

export const permissionFixtures = {
  systemSettingsRead: {
    name: 'system_settings:read',
    description: 'Read system settings',
  },
  systemSettingsWrite: {
    name: 'system_settings:write',
    description: 'Modify system settings',
  },
  userSettingsRead: {
    name: 'user_settings:read',
    description: 'Read user settings',
  },
  userSettingsWrite: {
    name: 'user_settings:write',
    description: 'Modify user settings',
  },
  usersRead: {
    name: 'users:read',
    description: 'Read user data',
  },
  usersWrite: {
    name: 'users:write',
    description: 'Modify user data',
  },
  rbacManage: {
    name: 'rbac:manage',
    description: 'Manage roles and permissions',
  },
};
```

### 13. Test Environment File

Create `apps/api/.env.test`:

```bash
# Test Environment Configuration
NODE_ENV=test

# Test Database (use separate test database!)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/enterprise_app_test

# JWT Configuration
JWT_SECRET=test-secret-key-minimum-32-characters-long
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=14

# Google OAuth (mocked in tests)
GOOGLE_CLIENT_ID=test-client-id
GOOGLE_CLIENT_SECRET=test-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback

# Admin Bootstrap
INITIAL_ADMIN_EMAIL=admin@example.com

# App URL
APP_URL=http://localhost:3000

# Disable telemetry in tests
OTEL_ENABLED=false
```

### 14. Package.json Test Scripts

Update `apps/api/package.json` scripts section:

```json
{
  "scripts": {
    "test": "jest --config ./test/jest.config.js",
    "test:watch": "jest --config ./test/jest.config.js --watch",
    "test:cov": "jest --config ./test/jest.config.js --coverage",
    "test:debug": "node --inspect-brk -r tsconfig-paths/register -r ts-node/register node_modules/.bin/jest --runInBand --config ./test/jest.config.js",
    "test:e2e": "jest --config ./test/jest.config.js --testRegex '.e2e-spec.ts$'",
    "test:unit": "jest --config ./test/jest.config.js --testPathIgnorePatterns='e2e'",
    "test:ci": "jest --config ./test/jest.config.js --coverage --ci --reporters=default --reporters=jest-junit"
  }
}
```

### 15. Additional Dev Dependencies

Add to `apps/api/package.json` devDependencies:

```json
{
  "devDependencies": {
    "@nestjs/testing": "^10.x",
    "@types/jest": "^29.x",
    "@types/supertest": "^6.x",
    "jest": "^29.x",
    "jest-junit": "^16.x",
    "jest-mock-extended": "^3.x",
    "supertest": "^6.x",
    "ts-jest": "^29.x",
    "passport-custom": "^1.x"
  }
}
```

---

## Test Database Setup

### Docker Compose Test Database

Add to `infra/compose/test.compose.yml`:

```yaml
version: '3.8'

services:
  db-test:
    image: postgres:16-alpine
    container_name: enterprise-app-db-test
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: enterprise_app_test
    ports:
      - "5433:5432"
    volumes:
      - test-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  test-db-data:
```

---

## Usage Examples

### Running Tests

```bash
# Run all tests
cd apps/api && npm test

# Run with coverage
cd apps/api && npm run test:cov

# Run in watch mode
cd apps/api && npm run test:watch

# Run specific test file
cd apps/api && npm test -- auth.service.spec.ts

# Run tests matching pattern
cd apps/api && npm test -- --testNamePattern="should create user"
```

### Writing an Integration Test

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import { createAdminUser, authHeader } from '../helpers/auth.helper';

describe('UsersController (e2e)', () => {
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

  it('GET /api/users - should return users for admin', async () => {
    const admin = await createAdminUser(context);

    const response = await request(context.app.getHttpServer())
      .get('/api/users')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(response.body.data).toBeDefined();
    expect(Array.isArray(response.body.data)).toBe(true);
  });
});
```

### Writing a Unit Test

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

describe('AuthService', () => {
  let service: AuthService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'mock-token') } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

---

## Acceptance Criteria

- [ ] Jest configured with TypeScript support
- [ ] Test database can be created and torn down
- [ ] Database helper can clean and seed data
- [ ] Auth helper can create test users with tokens
- [ ] Google OAuth mock strategy works in tests
- [ ] Prisma mock available for unit tests
- [ ] All fixture files created with realistic data
- [ ] `npm test` runs all tests successfully
- [ ] `npm run test:cov` generates coverage report
- [ ] Test environment variables isolated from development

---

## Notes

- Always use a separate test database to avoid data corruption
- Reset database state between tests for isolation
- Use mock strategies for OAuth to avoid external dependencies
- Co-locate unit tests with source files (*.spec.ts)
- Place integration/e2e tests in the test/ directory
- Keep test helpers generic and reusable

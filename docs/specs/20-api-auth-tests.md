# Spec 20: Auth Module Tests

**Domain:** Testing
**Agent:** `testing-dev`
**Depends On:** 05-auth-google-oauth, 06-auth-jwt-refresh, 19-api-test-framework
**Estimated Complexity:** High

---

## Objective

Create comprehensive unit and integration tests for the authentication module, covering Google OAuth flow, JWT token generation/validation, user provisioning, identity linking, and refresh token management.

---

## Deliverables

### 1. Test File Structure

```
apps/api/
├── src/auth/
│   ├── auth.service.spec.ts
│   ├── auth.controller.spec.ts
│   └── strategies/
│       ├── jwt.strategy.spec.ts
│       └── google.strategy.spec.ts
└── test/
    └── auth/
        ├── auth.e2e-spec.ts
        └── oauth-flow.e2e-spec.ts
```

### 2. AuthService Unit Tests

Create `apps/api/src/auth/auth.service.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService, GoogleProfile } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminBootstrapService } from '../common/services/admin-bootstrap.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('AuthService', () => {
  let service: AuthService;
  let mockPrisma: MockPrismaService;
  let mockJwtService: jest.Mocked<JwtService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockAdminBootstrap: jest.Mocked<AdminBootstrapService>;

  const mockGoogleProfile: GoogleProfile = {
    id: 'google-123',
    email: 'test@example.com',
    displayName: 'Test User',
    picture: 'https://example.com/photo.jpg',
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
      verify: jest.fn(),
    } as any;
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          'jwt.accessTtlMinutes': 15,
          'jwt.secret': 'test-secret',
          'google.clientId': 'test-client-id',
        };
        return config[key];
      }),
    } as any;
    mockAdminBootstrap = {
      shouldGrantAdminRole: jest.fn().mockResolvedValue(false),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AdminBootstrapService, useValue: mockAdminBootstrap },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleGoogleLogin', () => {
    it('should create new user when no identity exists', async () => {
      const mockRole = { id: 'role-1', name: 'viewer' };
      const mockUser = {
        id: 'user-1',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: mockRole }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(mockRole);
      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma);
      });
      mockPrisma.user.create.mockResolvedValue(mockUser as any);

      const result = await service.handleGoogleLogin(mockGoogleProfile);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('expiresIn');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          email: mockGoogleProfile.email,
          roles: ['viewer'],
        }),
      );
    });

    it('should link identity when user exists by email', async () => {
      const existingUser = {
        id: 'existing-user',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: { name: 'contributor' } }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(existingUser as any) // Find by email
        .mockResolvedValueOnce(existingUser as any); // Fresh fetch after update
      mockPrisma.userIdentity.create.mockResolvedValue({} as any);
      mockPrisma.user.update.mockResolvedValue(existingUser as any);

      const result = await service.handleGoogleLogin(mockGoogleProfile);

      expect(mockPrisma.userIdentity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'existing-user',
          provider: 'google',
          providerSubject: mockGoogleProfile.id,
        }),
      });
      expect(result.accessToken).toBeDefined();
    });

    it('should return existing user when identity exists', async () => {
      const existingIdentity = {
        user: {
          id: 'existing-user',
          email: mockGoogleProfile.email,
          isActive: true,
          userRoles: [{ role: { name: 'admin' } }],
        },
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(existingIdentity as any);
      mockPrisma.user.update.mockResolvedValue(existingIdentity.user as any);
      mockPrisma.user.findUnique.mockResolvedValue(existingIdentity.user as any);

      const result = await service.handleGoogleLogin(mockGoogleProfile);

      expect(result.accessToken).toBeDefined();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for deactivated user', async () => {
      const deactivatedUser = {
        id: 'deactivated-user',
        email: mockGoogleProfile.email,
        isActive: false,
        userRoles: [{ role: { name: 'viewer' } }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue({
        user: deactivatedUser,
      } as any);

      await expect(service.handleGoogleLogin(mockGoogleProfile)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should grant admin role when shouldGrantAdminRole returns true', async () => {
      const mockAdminRole = { id: 'admin-role', name: 'admin' };
      const mockUser = {
        id: 'new-admin',
        email: 'admin@example.com',
        isActive: true,
        userRoles: [{ role: mockAdminRole }],
      };

      mockAdminBootstrap.shouldGrantAdminRole.mockResolvedValue(true);
      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique
        .mockResolvedValueOnce({ id: 'viewer-role', name: 'viewer' } as any)
        .mockResolvedValueOnce(mockAdminRole as any);
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue(mockUser as any);

      const adminProfile = { ...mockGoogleProfile, email: 'admin@example.com' };
      const result = await service.handleGoogleLogin(adminProfile);

      expect(mockAdminBootstrap.shouldGrantAdminRole).toHaveBeenCalledWith('admin@example.com');
      expect(result.accessToken).toBeDefined();
    });
  });

  describe('validateJwtPayload', () => {
    it('should return user with roles and permissions', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        isActive: true,
        userRoles: [
          {
            role: {
              name: 'admin',
              rolePermissions: [
                { permission: { name: 'users:read' } },
                { permission: { name: 'users:write' } },
              ],
            },
          },
        ],
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any);

      const result = await service.validateJwtPayload({
        sub: 'user-1',
        email: 'test@example.com',
        roles: ['admin'],
      });

      expect(result).toEqual(mockUser);
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.validateJwtPayload({
          sub: 'non-existent',
          email: 'test@example.com',
          roles: [],
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for inactive user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        isActive: false,
      } as any);

      await expect(
        service.validateJwtPayload({
          sub: 'user-1',
          email: 'test@example.com',
          roles: [],
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('getEnabledProviders', () => {
    it('should return google provider when configured', () => {
      mockConfigService.get.mockReturnValue('test-client-id');

      const providers = service.getEnabledProviders();

      expect(providers).toContainEqual({
        name: 'google',
        authUrl: '/api/auth/google',
      });
    });

    it('should return empty array when no providers configured', () => {
      mockConfigService.get.mockReturnValue(undefined);

      const providers = service.getEnabledProviders();

      expect(providers).toEqual([]);
    });
  });

  describe('getCurrentUser', () => {
    it('should return user details with computed display name', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: null,
        providerDisplayName: 'Provider Name',
        profileImageUrl: null,
        providerProfileImageUrl: 'https://example.com/photo.jpg',
        isActive: true,
        createdAt: new Date(),
        userRoles: [
          {
            role: {
              name: 'viewer',
              rolePermissions: [{ permission: { name: 'user_settings:read' } }],
            },
          },
        ],
        userSettings: {
          value: { profile: { useProviderImage: true } },
        },
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any);

      const result = await service.getCurrentUser('user-1');

      expect(result.displayName).toBe('Provider Name');
      expect(result.profileImageUrl).toBe('https://example.com/photo.jpg');
      expect(result.roles).toContain('viewer');
      expect(result.permissions).toContain('user_settings:read');
    });

    it('should prefer user display name over provider', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Custom Name',
        providerDisplayName: 'Provider Name',
        profileImageUrl: 'https://custom.com/photo.jpg',
        providerProfileImageUrl: 'https://provider.com/photo.jpg',
        isActive: true,
        createdAt: new Date(),
        userRoles: [{ role: { name: 'viewer', rolePermissions: [] } }],
        userSettings: {
          value: { profile: { useProviderImage: false } },
        },
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any);

      const result = await service.getCurrentUser('user-1');

      expect(result.displayName).toBe('Custom Name');
      expect(result.profileImageUrl).toBe('https://custom.com/photo.jpg');
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getCurrentUser('non-existent')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
```

### 3. JWT Strategy Unit Tests

Create `apps/api/src/auth/strategies/jwt.strategy.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let mockAuthService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    mockAuthService = {
      validateJwtPayload: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: AuthService, useValue: mockAuthService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-jwt-secret-min-32-chars'),
          },
        },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  describe('validate', () => {
    it('should return user from auth service', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com' };
      mockAuthService.validateJwtPayload.mockResolvedValue(mockUser as any);

      const payload = { sub: 'user-1', email: 'test@example.com', roles: ['viewer'] };
      const result = await strategy.validate(payload);

      expect(result).toEqual(mockUser);
      expect(mockAuthService.validateJwtPayload).toHaveBeenCalledWith(payload);
    });

    it('should throw when auth service throws', async () => {
      mockAuthService.validateJwtPayload.mockRejectedValue(
        new UnauthorizedException('Invalid user'),
      );

      const payload = { sub: 'invalid', email: 'test@example.com', roles: [] };

      await expect(strategy.validate(payload)).rejects.toThrow(UnauthorizedException);
    });
  });
});
```

### 4. Auth Controller Unit Tests

Create `apps/api/src/auth/auth.controller.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let mockAuthService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    mockAuthService = {
      getEnabledProviders: jest.fn(),
      handleGoogleLogin: jest.fn(),
      getCurrentUser: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  describe('getProviders', () => {
    it('should return enabled providers', () => {
      const providers = [{ name: 'google', authUrl: '/api/auth/google' }];
      mockAuthService.getEnabledProviders.mockReturnValue(providers);

      const result = controller.getProviders();

      expect(result).toEqual(providers);
    });
  });

  describe('getMe', () => {
    it('should return current user details', async () => {
      const userDetails = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Test User',
        roles: ['viewer'],
        permissions: ['user_settings:read'],
      };
      mockAuthService.getCurrentUser.mockResolvedValue(userDetails as any);

      const result = await controller.getMe('user-1');

      expect(result).toEqual(userDetails);
      expect(mockAuthService.getCurrentUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('logout', () => {
    it('should return void (stateless logout)', async () => {
      const result = await controller.logout('user-1');

      expect(result).toBeUndefined();
    });
  });
});
```

### 5. Auth E2E Integration Tests

Create `apps/api/test/auth/auth.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import {
  createTestUser,
  createAdminUser,
  createInactiveUser,
  authHeader,
} from '../helpers/auth.helper';

describe('Auth Controller (e2e)', () => {
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

  describe('GET /api/auth/providers', () => {
    it('should return list of enabled providers', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/providers')
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should not require authentication', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/providers')
        .expect(200);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return current user for authenticated request', async () => {
      const user = await createTestUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: user.id,
        email: user.email,
        roles: expect.arrayContaining(user.roles),
      });
    });

    it('should return 401 without token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .expect(401);
    });

    it('should return 401 with invalid token', async () => {
      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader('invalid-token'))
        .expect(401);
    });

    it('should return 401 for inactive user', async () => {
      const inactiveUser = await createInactiveUser(context);

      await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(inactiveUser.accessToken))
        .expect(401);
    });

    it('should include permissions in response', async () => {
      const admin = await createAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.permissions).toBeDefined();
      expect(Array.isArray(response.body.data.permissions)).toBe(true);
      expect(response.body.data.permissions.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return 204 for authenticated user', async () => {
      const user = await createTestUser(context);

      await request(context.app.getHttpServer())
        .post('/api/auth/logout')
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('should return 401 without token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/logout')
        .expect(401);
    });
  });

  describe('GET /api/auth/google', () => {
    it('should redirect to Google OAuth', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/google')
        .expect(302);

      expect(response.headers.location).toContain('accounts.google.com');
    });
  });
});
```

### 6. OAuth Flow E2E Tests

Create `apps/api/test/auth/oauth-flow.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { GoogleStrategy } from '../../src/auth/strategies/google.strategy';
import { MockGoogleStrategy, createMockGoogleProfile } from '../mocks/google-oauth.mock';
import { resetDatabase } from '../helpers/database.helper';

describe('OAuth Flow (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleStrategy)
      .useClass(MockGoogleStrategy)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    MockGoogleStrategy.resetMockProfile();
  });

  describe('New User OAuth Flow', () => {
    it('should create new user on first login', async () => {
      const mockProfile = createMockGoogleProfile({
        email: 'newuser@example.com',
        displayName: 'New User',
      });
      MockGoogleStrategy.setMockProfile(mockProfile);

      // Simulate OAuth callback
      const response = await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      // Should redirect with token
      expect(response.headers.location).toContain('token=');

      // Verify user was created
      const user = await prisma.user.findUnique({
        where: { email: mockProfile.email },
        include: { userRoles: { include: { role: true } } },
      });

      expect(user).toBeDefined();
      expect(user!.providerDisplayName).toBe(mockProfile.displayName);
      expect(user!.userRoles[0].role.name).toBe('viewer'); // Default role
    });

    it('should create user settings for new user', async () => {
      const mockProfile = createMockGoogleProfile();
      MockGoogleStrategy.setMockProfile(mockProfile);

      await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      const user = await prisma.user.findUnique({
        where: { email: mockProfile.email },
        include: { userSettings: true },
      });

      expect(user!.userSettings).toBeDefined();
      expect(user!.userSettings!.value).toHaveProperty('theme');
    });

    it('should create identity for new user', async () => {
      const mockProfile = createMockGoogleProfile();
      MockGoogleStrategy.setMockProfile(mockProfile);

      await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      const identity = await prisma.userIdentity.findFirst({
        where: {
          provider: 'google',
          providerSubject: mockProfile.id,
        },
      });

      expect(identity).toBeDefined();
      expect(identity!.providerEmail).toBe(mockProfile.email);
    });
  });

  describe('Existing User OAuth Flow', () => {
    it('should link identity to existing user by email', async () => {
      // Create existing user without Google identity
      const existingUser = await prisma.user.create({
        data: {
          email: 'existing@example.com',
          providerDisplayName: 'Existing User',
          userRoles: {
            create: {
              role: {
                connect: { name: 'contributor' },
              },
            },
          },
        },
      });

      const mockProfile = createMockGoogleProfile({
        email: existingUser.email,
        displayName: 'Google Name',
      });
      MockGoogleStrategy.setMockProfile(mockProfile);

      await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      // Verify identity was linked
      const identity = await prisma.userIdentity.findFirst({
        where: {
          userId: existingUser.id,
          provider: 'google',
        },
      });

      expect(identity).toBeDefined();

      // Verify user still has original role
      const user = await prisma.user.findUnique({
        where: { id: existingUser.id },
        include: { userRoles: { include: { role: true } } },
      });
      expect(user!.userRoles[0].role.name).toBe('contributor');
    });

    it('should update provider fields on existing user login', async () => {
      // Create user with Google identity
      const user = await prisma.user.create({
        data: {
          email: 'returning@example.com',
          providerDisplayName: 'Old Name',
          providerProfileImageUrl: 'https://old-image.com/photo.jpg',
          identities: {
            create: {
              provider: 'google',
              providerSubject: 'google-returning',
              providerEmail: 'returning@example.com',
            },
          },
          userRoles: {
            create: {
              role: { connect: { name: 'viewer' } },
            },
          },
        },
      });

      const mockProfile = createMockGoogleProfile({
        id: 'google-returning',
        email: user.email,
        displayName: 'New Name',
        picture: 'https://new-image.com/photo.jpg',
      });
      MockGoogleStrategy.setMockProfile(mockProfile);

      await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id },
      });

      expect(updatedUser!.providerDisplayName).toBe('New Name');
      expect(updatedUser!.providerProfileImageUrl).toBe('https://new-image.com/photo.jpg');
    });

    it('should not overwrite user custom display name', async () => {
      const user = await prisma.user.create({
        data: {
          email: 'custom@example.com',
          displayName: 'My Custom Name', // User override
          providerDisplayName: 'Provider Name',
          identities: {
            create: {
              provider: 'google',
              providerSubject: 'google-custom',
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

      const mockProfile = createMockGoogleProfile({
        id: 'google-custom',
        email: user.email,
        displayName: 'New Provider Name',
      });
      MockGoogleStrategy.setMockProfile(mockProfile);

      await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      const updatedUser = await prisma.user.findUnique({
        where: { id: user.id },
      });

      expect(updatedUser!.displayName).toBe('My Custom Name'); // Unchanged
      expect(updatedUser!.providerDisplayName).toBe('New Provider Name'); // Updated
    });
  });

  describe('Admin Bootstrap', () => {
    it('should grant admin role to INITIAL_ADMIN_EMAIL', async () => {
      const adminEmail = process.env.INITIAL_ADMIN_EMAIL || 'admin@example.com';
      const mockProfile = createMockGoogleProfile({
        email: adminEmail,
        displayName: 'Admin User',
      });
      MockGoogleStrategy.setMockProfile(mockProfile);

      await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(302);

      const user = await prisma.user.findUnique({
        where: { email: adminEmail },
        include: { userRoles: { include: { role: true } } },
      });

      expect(user!.userRoles.some((ur) => ur.role.name === 'admin')).toBe(true);
    });
  });

  describe('Deactivated User', () => {
    it('should reject login for deactivated user', async () => {
      await prisma.user.create({
        data: {
          email: 'deactivated@example.com',
          isActive: false,
          providerDisplayName: 'Deactivated User',
          identities: {
            create: {
              provider: 'google',
              providerSubject: 'google-deactivated',
              providerEmail: 'deactivated@example.com',
            },
          },
          userRoles: {
            create: {
              role: { connect: { name: 'viewer' } },
            },
          },
        },
      });

      const mockProfile = createMockGoogleProfile({
        id: 'google-deactivated',
        email: 'deactivated@example.com',
      });
      MockGoogleStrategy.setMockProfile(mockProfile);

      const response = await request(app.getHttpServer())
        .get('/api/auth/google/callback')
        .expect(401);

      expect(response.body.message).toContain('deactivated');
    });
  });
});
```

### 7. Refresh Token Tests (if spec 06 implemented)

Create `apps/api/test/auth/refresh-token.e2e-spec.ts`:

```typescript
import * as request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetDatabase } from '../helpers/database.helper';
import { createTestUser } from '../helpers/auth.helper';

describe('Refresh Token (e2e)', () => {
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

  describe('POST /api/auth/refresh', () => {
    it('should return new access token with valid refresh token', async () => {
      const user = await createTestUser(context);

      // First, simulate getting a refresh token via OAuth callback
      // This test assumes refresh tokens are stored in httpOnly cookies

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=valid-refresh-token`])
        .expect(200);

      expect(response.body.data).toHaveProperty('accessToken');
      expect(response.body.data).toHaveProperty('expiresIn');
    });

    it('should return 401 without refresh token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .expect(401);
    });

    it('should return 401 with expired refresh token', async () => {
      await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=expired-token`])
        .expect(401);
    });

    it('should return 401 with revoked refresh token', async () => {
      // Revoke the token first (e.g., via logout)
      await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=revoked-token`])
        .expect(401);
    });

    it('should rotate refresh token on use', async () => {
      const response = await request(context.app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=valid-refresh-token`])
        .expect(200);

      // Should set new refresh token cookie
      expect(response.headers['set-cookie']).toBeDefined();
      expect(response.headers['set-cookie'][0]).toContain('refreshToken=');
    });
  });
});
```

---

## Acceptance Criteria

- [ ] AuthService unit tests pass with >80% coverage
- [ ] JWT strategy validates payload correctly
- [ ] New user creation flow works end-to-end
- [ ] Identity linking to existing user works
- [ ] Admin bootstrap grants admin role correctly
- [ ] Deactivated users are rejected
- [ ] Provider fields are updated but user overrides preserved
- [ ] GET /api/auth/me returns complete user data
- [ ] OAuth redirect includes valid JWT token
- [ ] Refresh token rotation works (if implemented)
- [ ] All tests isolated with database reset between runs

---

## Notes

- Use MockGoogleStrategy in e2e tests to avoid real OAuth calls
- Test both happy paths and error conditions
- Ensure proper cleanup between test runs
- Test token expiry scenarios where applicable
- Consider testing concurrent login scenarios

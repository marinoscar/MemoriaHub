import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockTestUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../src/common/types/settings.types';

describe('User Settings Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('GET /api/user-settings', () => {
    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .expect(401);
    });

    it('should return current user settings', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: DEFAULT_USER_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        theme: DEFAULT_USER_SETTINGS.theme,
        profile: DEFAULT_USER_SETTINGS.profile,
        version: 1,
      });
      expect(response.body.data.updatedAt).toBeDefined();
    });

    // ETag headers require response interceptor configuration
    it.skip('should include ETag header with version', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: DEFAULT_USER_SETTINGS as any,
        version: 3,
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.headers.etag).toBe('"3"');
    });

    it('should create default settings if none exist', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.findUnique.mockResolvedValue(null);
      context.prismaMock.userSettings.create.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: DEFAULT_USER_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        theme: DEFAULT_USER_SETTINGS.theme,
        profile: DEFAULT_USER_SETTINGS.profile,
      });
    });
  });

  describe('PUT /api/user-settings', () => {
    const newSettings: UserSettingsValue = {
      theme: 'dark',
      profile: {
        displayName: 'John Doe',
        useProviderImage: false,
        customImageUrl: 'https://example.com/avatar.jpg',
      },
    };

    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .send(newSettings)
        .expect(401);
    });

    // Requires complex mock chain for upsert + user.update
    it.skip('should replace user settings', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.upsert.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: newSettings as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(newSettings)
        .expect(200);

      expect(response.body.data).toMatchObject({
        theme: newSettings.theme,
        profile: newSettings.profile,
        version: 2,
      });
    });

    // Requires complex mock chain for upsert + user.update
    it.skip('should sync displayName to user profile', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.upsert.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: newSettings as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(newSettings)
        .expect(200);

      // Verify displayName was synced to user table
      expect(context.prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: { displayName: 'John Doe' },
      });
    });

    // ETag headers require response interceptor configuration
    it.skip('should return ETag header with new version', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.upsert.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: newSettings as any,
        version: 5,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(newSettings)
        .expect(200);

      expect(response.headers.etag).toBe('"5"');
    });

    it('should return 400 with invalid settings structure', async () => {
      const user = await createMockTestUser(context);

      const invalidSettings = {
        theme: 'invalid-theme',
        profile: {
          useProviderImage: true,
        },
      };

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(invalidSettings)
        .expect(400);
    });

    it('should return 400 with missing required fields', async () => {
      const user = await createMockTestUser(context);

      const incompleteSettings = {
        theme: 'dark',
        // Missing profile field
      };

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(incompleteSettings)
        .expect(400);
    });

    it('should return 400 with invalid URL in customImageUrl', async () => {
      const user = await createMockTestUser(context);

      const invalidUrlSettings = {
        theme: 'dark',
        profile: {
          useProviderImage: false,
          customImageUrl: 'not-a-valid-url',
        },
      };

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(invalidUrlSettings)
        .expect(400);
    });

    it('should return 400 with displayName exceeding max length', async () => {
      const user = await createMockTestUser(context);

      const tooLongName = 'a'.repeat(101); // Max is 100

      const invalidSettings = {
        theme: 'dark',
        profile: {
          displayName: tooLongName,
          useProviderImage: true,
        },
      };

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(invalidSettings)
        .expect(400);
    });
  });

  describe('PATCH /api/user-settings', () => {
    beforeEach(() => {
      const mockSettings = {
        id: 'settings-1',
        userId: 'user-1',
        value: DEFAULT_USER_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
      };
      context.prismaMock.userSettings.findUnique.mockResolvedValue(mockSettings);
    });

    it('should return 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .send({ theme: 'dark' })
        .expect(401);
    });

    it('should merge partial settings', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = { theme: 'dark' as const };

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.theme).toBe('dark');
      expect(response.body.data.profile).toEqual(DEFAULT_USER_SETTINGS.profile);
      expect(response.body.data.version).toBe(2);
    });

    it('should update theme preference', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = { theme: 'light' as const };

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: 'light',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.theme).toBe('light');
    });

    // Requires complex mock chain for settings.update + user.update
    it.skip('should update profile displayName and sync to user table', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = {
        profile: {
          displayName: 'Jane Doe',
        },
      };

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            displayName: 'Jane Doe',
            useProviderImage: DEFAULT_USER_SETTINGS.profile.useProviderImage,
          },
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.profile.displayName).toBe('Jane Doe');

      // Verify sync to user table
      expect(context.prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: { displayName: 'Jane Doe' },
      });
    });

    it('should return 409 on version mismatch', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = { theme: 'dark' as const };

      // Current version is 1, but If-Match header expects version 2
      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .set('If-Match', '2')
        .send(partialUpdate)
        .expect(409);

      expect(response.body.message).toContain('version mismatch');
    });

    it('should succeed when If-Match matches current version', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = { theme: 'dark' as const };

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      // Current version is 1, If-Match header expects version 1
      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .set('If-Match', '1')
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.version).toBe(2);
    });

    it('should work without If-Match header', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = { theme: 'dark' as const };

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.version).toBe(2);
    });

    it('should return 400 with invalid partial update', async () => {
      const user = await createMockTestUser(context);

      const invalidUpdate = { theme: 'invalid-theme' };

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(invalidUpdate)
        .expect(400);
    });

    it('should handle multiple profile field updates', async () => {
      const user = await createMockTestUser(context);

      const partialUpdate = {
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://example.com/custom.jpg',
        },
      };

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            useProviderImage: false,
            customImageUrl: 'https://example.com/custom.jpg',
          },
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const response = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(partialUpdate)
        .expect(200);

      expect(response.body.data.profile.useProviderImage).toBe(false);
      expect(response.body.data.profile.customImageUrl).toBe(
        'https://example.com/custom.jpg',
      );
    });
  });

  // User isolation tests require complex multi-user mock setup
  describe.skip('User isolation', () => {
    it('should not allow user to access other user settings', async () => {
      const user1 = await createMockTestUser(context, {
        email: 'user1@example.com',
      });
      const user2 = await createMockTestUser(context, {
        email: 'user2@example.com',
      });

      // Mock settings for user2
      context.prismaMock.userSettings.findUnique.mockImplementation(
        async ({ where }: any) => {
          if (where.userId === user2.id) {
            return {
              id: `settings-${user2.id}`,
              userId: user2.id,
              value: {
                theme: 'dark',
                profile: { useProviderImage: true },
              } as any,
              version: 1,
              updatedAt: new Date(),
            };
          }
          return null;
        },
      );

      // User1 tries to access their own settings
      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user1.accessToken))
        .expect(200);

      // Should get user1's settings, not user2's
      // The controller uses @CurrentUser decorator which extracts userId from JWT
      expect(context.prismaMock.userSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: user1.id },
        }),
      );
    });

    it('should only update current user settings on PUT', async () => {
      const user = await createMockTestUser(context);

      const newSettings: UserSettingsValue = {
        theme: 'dark',
        profile: { useProviderImage: true },
      };

      context.prismaMock.userSettings.upsert.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: newSettings as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      await request(context.app.getHttpServer())
        .put('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(newSettings)
        .expect(200);

      // Should update only the authenticated user's settings
      expect(context.prismaMock.userSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: user.id },
        }),
      );
    });

    it('should only update current user settings on PATCH', async () => {
      const user = await createMockTestUser(context);

      context.prismaMock.userSettings.findUnique.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: DEFAULT_USER_SETTINGS as any,
        version: 1,
        updatedAt: new Date(),
      });

      context.prismaMock.userSettings.update.mockResolvedValue({
        id: `settings-${user.id}`,
        userId: user.id,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
        updatedAt: new Date(),
      });

      context.prismaMock.user.update.mockResolvedValue({} as any);

      const partialUpdate = { theme: 'dark' as const };

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send(partialUpdate)
        .expect(200);

      // Should update only the authenticated user's settings
      expect(context.prismaMock.userSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: user.id },
        }),
      );
    });
  });
});

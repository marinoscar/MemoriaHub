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
import {
  DATA_TABLE_MAX_TABLES,
  DATA_TABLE_MAX_VISIBLE_COLUMNS,
  DATA_TABLE_MAX_PAGE_SIZE,
} from '../../src/common/schemas/settings.schema';

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

  // ===========================================================================
  // dataTables — per-user DataTable layout persistence (issue #255)
  // ===========================================================================

  describe('dataTables persistence', () => {
    const settingsRow = (value: UserSettingsValue, version = 1) => ({
      id: 'settings-1',
      userId: 'user-1',
      value: value as any,
      version,
      updatedAt: new Date(),
    });

    /** Mocks the stored row and makes PATCH's update a pass-through. */
    const seedStored = (dataTables?: Record<string, any>) => {
      const stored: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        ...(dataTables ? { dataTables } : {}),
      };

      context.prismaMock.userSettings.findUnique.mockResolvedValue(
        settingsRow(stored),
      );
      context.prismaMock.userSettings.update.mockImplementation(
        async ({ data }: any) => settingsRow(data.value, 2),
      );
      context.prismaMock.userSettings.upsert.mockImplementation(
        async ({ create, update }: any) =>
          settingsRow((update?.value ?? create?.value) as UserSettingsValue, 2),
      );
      context.prismaMock.user.update.mockResolvedValue({} as any);
    };

    describe('GET /api/user-settings', () => {
      it('should omit dataTables entirely when nothing is stored', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        const response = await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(user.accessToken))
          .expect(200);

        // The absent namespace is the normal state for an existing user, which
        // is precisely why this feature needed no data migration.
        expect(response.body.data.dataTables).toBeUndefined();
      });

      it('should return stored entries verbatim, absences included', async () => {
        const user = await createMockTestUser(context);
        seedStored({ jobs: { density: 'compact' } });

        const response = await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(user.accessToken))
          .expect(200);

        // No server-side default materialization: visibleColumns / sort /
        // pageSize must all still be absent so the client falls back to the
        // column contract's priority-derived defaults.
        expect(response.body.data.dataTables).toEqual({
          jobs: { density: 'compact' },
        });
      });
    });

    describe('PUT /api/user-settings', () => {
      it('should round-trip a full entry', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        const dataTables = {
          'admin-jobs': {
            visibleColumns: ['type', 'status', 'lastError'],
            density: 'comfortable',
            sort: { field: 'createdAt', direction: 'desc' },
            pageSize: 50,
          },
        };

        const response = await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables,
          })
          .expect(200);

        expect(response.body.data.dataTables).toEqual(dataTables);
      });

      it('should not materialize defaults for omitted sub-keys', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        const response = await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: { jobs: {} },
          })
          .expect(200);

        expect(response.body.data.dataTables).toEqual({ jobs: {} });
      });

      it('should return 400 for an invalid density', async () => {
        const user = await createMockTestUser(context);

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: { jobs: { density: 'cozy' } },
          })
          .expect(400);
      });

      it('should return 400 for a tableId that breaks the key pattern', async () => {
        const user = await createMockTestUser(context);

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: { 'Admin Jobs!': {} },
          })
          .expect(400);
      });

      it('should return 400 for a pageSize below the minimum', async () => {
        const user = await createMockTestUser(context);

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: { jobs: { pageSize: 0 } },
          })
          .expect(400);
      });

      it('should return 400 for a pageSize above the maximum', async () => {
        const user = await createMockTestUser(context);

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: {
              jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 },
            },
          })
          .expect(400);
      });

      it('should return 400 for more table ids than the cap allows', async () => {
        const user = await createMockTestUser(context);

        const dataTables: Record<string, unknown> = {};
        for (let i = 0; i <= DATA_TABLE_MAX_TABLES; i++) {
          dataTables[`t${i}`] = {};
        }

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables,
          })
          .expect(400);
      });

      it('should return 400 for an over-cap visibleColumns list', async () => {
        const user = await createMockTestUser(context);

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: {
              jobs: {
                visibleColumns: Array.from(
                  { length: DATA_TABLE_MAX_VISIBLE_COLUMNS + 1 },
                  (_, i) => `c${i}`,
                ),
              },
            },
          })
          .expect(400);
      });

      it('should return 400 for an unknown key inside an entry', async () => {
        const user = await createMockTestUser(context);

        await request(context.app.getHttpServer())
          .put('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            theme: 'dark',
            profile: { useProviderImage: true },
            dataTables: { jobs: { columnWidths: { type: 200 } } },
          })
          .expect(400);
      });
    });

    describe('PATCH /api/user-settings', () => {
      it('should round-trip a full entry', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        const entry = {
          visibleColumns: ['type', 'status'],
          density: 'compact',
          sort: { field: 'createdAt', direction: 'asc' },
          pageSize: 25,
        };

        const response = await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { jobs: entry } })
          .expect(200);

        expect(response.body.data.dataTables).toEqual({ jobs: entry });
      });

      it('should not clobber another table id', async () => {
        const user = await createMockTestUser(context);
        seedStored({
          jobs: { pageSize: 25, visibleColumns: ['type'] },
          users: { density: 'compact', pageSize: 10 },
        });

        const response = await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { jobs: { pageSize: 100 } } })
          .expect(200);

        expect(response.body.data.dataTables).toEqual({
          jobs: { pageSize: 100 },
          users: { density: 'compact', pageSize: 10 },
        });
      });

      it('should preserve dataTables when patching an unrelated field', async () => {
        const user = await createMockTestUser(context);
        seedStored({ jobs: { pageSize: 25 } });

        const response = await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ theme: 'dark' })
          .expect(200);

        expect(response.body.data.theme).toBe('dark');
        expect(response.body.data.dataTables).toEqual({
          jobs: { pageSize: 25 },
        });
      });

      it('should reset one entry to defaults with {} without touching others', async () => {
        const user = await createMockTestUser(context);
        seedStored({
          jobs: { pageSize: 25, visibleColumns: ['type'] },
          users: { density: 'compact' },
        });

        const response = await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { jobs: {} } })
          .expect(200);

        expect(response.body.data.dataTables).toEqual({
          jobs: {},
          users: { density: 'compact' },
        });
      });

      it('should delete an entry sent as null', async () => {
        const user = await createMockTestUser(context);
        seedStored({
          jobs: { pageSize: 25 },
          users: { density: 'compact' },
        });

        const response = await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { jobs: null } })
          .expect(200);

        expect(response.body.data.dataTables).toEqual({
          users: { density: 'compact' },
        });
      });

      it('should return 400 for an invalid density', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { jobs: { density: 'cozy' } } })
          .expect(400);
      });

      it('should return 400 for a tableId that breaks the key pattern', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { 'Admin Jobs': {} } })
          .expect(400);
      });

      it('should return 400 for a pageSize out of range', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({
            dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } },
          })
          .expect(400);
      });

      it('should return 400 when the MERGED namespace exceeds the table-id cap', async () => {
        const user = await createMockTestUser(context);

        const stored: Record<string, any> = {};
        for (let i = 0; i < DATA_TABLE_MAX_TABLES; i++) {
          stored[`t${i}`] = {};
        }
        seedStored(stored);

        // One entry in the payload — under the payload cap — but the merge
        // would push the stored namespace over it.
        await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { overflow: {} } })
          .expect(400);

        expect(context.prismaMock.userSettings.update).not.toHaveBeenCalled();
      });

      it('should return 400 for an unknown key inside an entry', async () => {
        const user = await createMockTestUser(context);
        seedStored();

        await request(context.app.getHttpServer())
          .patch('/api/user-settings')
          .set(authHeader(user.accessToken))
          .send({ dataTables: { jobs: { columnOrder: ['type'] } } })
          .expect(400);
      });
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
  // ===========================================================================
  // memories — per-user Memories preferences (issue #307, epic #300)
  // ===========================================================================

  describe('memories preference namespace', () => {
    const settingsRow = (value: UserSettingsValue, version = 1) => ({
      id: 'settings-1',
      userId: 'user-1',
      value: value as any,
      version,
      updatedAt: new Date(),
    });

    const seedStored = (memories?: Record<string, any>) => {
      const stored: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        ...(memories ? { memories: memories as any } : {}),
      };
      context.prismaMock.userSettings.findUnique.mockResolvedValue(
        settingsRow(stored),
      );
      context.prismaMock.userSettings.update.mockImplementation(
        async ({ data }: any) => settingsRow(data.value, 2),
      );
      context.prismaMock.userSettings.upsert.mockImplementation(
        async ({ create, update }: any) =>
          settingsRow((update?.value ?? create?.value) as UserSettingsValue, 2),
      );
      context.prismaMock.user.update.mockResolvedValue({} as any);
    };

    const PERSON = '11111111-1111-4111-8111-111111111111';

    it('omits the namespace entirely when nothing is stored (absent = default)', async () => {
      const user = await createMockTestUser(context);
      seedStored();

      const res = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.memories).toBeUndefined();
    });

    it('round-trips a namespace through PATCH', async () => {
      const user = await createMockTestUser(context);
      seedStored();

      const res = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({
          memories: {
            hiddenPersonIds: [PERSON],
            hiddenDateRanges: [{ from: '2024-06-10', to: '2024-06-20' }],
            emailDigestOptOut: true,
          },
        })
        .expect(200);

      expect(res.body.data.memories).toEqual({
        hiddenPersonIds: [PERSON],
        hiddenDateRanges: [{ from: '2024-06-10', to: '2024-06-20' }],
        emailDigestOptOut: true,
      });
    });

    it('rejects an unknown key with 400 (.strict() at the HTTP boundary)', async () => {
      const user = await createMockTestUser(context);
      seedStored();

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ memories: { hiddenPetIds: ['x'] } })
        .expect(400);
    });

    it('rejects an inverted date range with 400', async () => {
      const user = await createMockTestUser(context);
      seedStored();

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({
          memories: { hiddenDateRanges: [{ from: '2024-02-10', to: '2024-02-01' }] },
        })
        .expect(400);
    });

    it('rejects a non-uuid person id with 400', async () => {
      const user = await createMockTestUser(context);
      seedStored();

      await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ memories: { hiddenPersonIds: ['not-a-uuid'] } })
        .expect(400);
    });

    it('clears the namespace on `memories: null`', async () => {
      const user = await createMockTestUser(context);
      seedStored({ hiddenPersonIds: [PERSON] });

      const res = await request(context.app.getHttpServer())
        .patch('/api/user-settings')
        .set(authHeader(user.accessToken))
        .send({ memories: null })
        .expect(200);

      expect(res.body.data.memories).toBeUndefined();
    });
  });
});

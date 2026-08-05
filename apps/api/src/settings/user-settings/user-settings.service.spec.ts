import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DATA_TABLE_MAX_TABLES } from '../../common/schemas/settings.schema';
import { UserSettingsService } from './user-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';

describe('UserSettingsService', () => {
  let service: UserSettingsService;
  let mockPrisma: MockPrismaService;

  const mockUserId = 'user-123';

  const mockUserSettings = {
    id: 'settings-1',
    userId: mockUserId,
    value: DEFAULT_USER_SETTINGS as any,
    version: 1,
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UserSettingsService>(UserSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return settings for current user', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );

      const result = await service.getSettings(mockUserId);

      expect(result).toMatchObject({
        theme: DEFAULT_USER_SETTINGS.theme,
        profile: DEFAULT_USER_SETTINGS.profile,
        version: 1,
      });
      expect(result.updatedAt).toBeDefined();
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledWith({
        where: { userId: mockUserId },
      });
    });

    it('should create and return default settings if none exist', async () => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(null);
      mockPrisma.userSettings.create.mockResolvedValue(mockUserSettings as any);

      const result = await service.getSettings(mockUserId);

      expect(result).toMatchObject({
        theme: DEFAULT_USER_SETTINGS.theme,
        profile: DEFAULT_USER_SETTINGS.profile,
        version: 1,
      });
      expect(mockPrisma.userSettings.create).toHaveBeenCalledWith({
        data: {
          userId: mockUserId,
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
    });
  });

  describe('replaceSettings (PUT)', () => {
    it('should replace user settings', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'dark',
        profile: {
          displayName: 'John Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/avatar.jpg',
        },
      };

      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: newSettings as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, newSettings);

      expect(result).toMatchObject({
        theme: newSettings.theme,
        profile: newSettings.profile,
        version: 2,
      });
      expect(mockPrisma.userSettings.upsert).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        update: {
          value: newSettings as any,
          version: { increment: 1 },
        },
        create: {
          userId: mockUserId,
          value: newSettings as any,
        },
      });
    });

    it('should increment version on update', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      };

      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: newSettings as any,
        version: 5,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, newSettings);

      expect(result.version).toBe(5);
      expect(mockPrisma.userSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should sync displayName to user table when changed', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'system',
        profile: {
          displayName: 'Jane Smith',
          useProviderImage: true,
        },
      };

      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: newSettings as any,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.replaceSettings(mockUserId, newSettings);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { displayName: 'Jane Smith' },
      });
    });

    it('should handle displayName set to empty string', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'system',
        profile: {
          displayName: '', // Empty string
          useProviderImage: true,
        },
      };

      // The validated result contains displayName as empty string
      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'system',
          profile: {
            displayName: '',
            useProviderImage: true,
          },
        } as any,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.replaceSettings(mockUserId, newSettings);

      // Empty string is converted to null via displayName || null logic
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { displayName: null },
      });
    });

    it('should not sync displayName when not provided in settings', async () => {
      const newSettings: UserSettingsValue = {
        theme: 'dark',
        profile: {
          useProviderImage: false,
        },
      };

      // When displayName is not provided, Zod schema validation won't include it
      mockPrisma.userSettings.upsert.mockResolvedValue({
        ...mockUserSettings,
        value: {
          ...newSettings,
          profile: {
            ...newSettings.profile,
            // displayName is not present in the validated result
          },
        } as any,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.replaceSettings(mockUserId, newSettings);

      // displayName is not in the validated result (not undefined, just missing),
      // so it should not be synced
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('patchSettings (PATCH) — search.visibleFields', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
    });

    it('should persist search.visibleFields when patched', async () => {
      const partialUpdate = {
        search: { visibleFields: ['type', 'favorite'] },
      };

      const expectedValue: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        search: { visibleFields: ['type', 'favorite'] },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: expectedValue as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.search).toEqual({ visibleFields: ['type', 'favorite'] });
      expect(mockPrisma.userSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            value: expect.objectContaining({
              search: { visibleFields: ['type', 'favorite'] },
            }),
          }),
        }),
      );
    });

    it('should preserve search.visibleFields when patching an unrelated field', async () => {
      const settingsWithSearch: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        search: { visibleFields: ['date', 'location'] },
      };

      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: settingsWithSearch as any,
      } as any);

      // Patch only theme — search.visibleFields must survive
      const partialUpdate = { theme: 'dark' as const };

      const expectedValue: UserSettingsValue = {
        ...settingsWithSearch,
        theme: 'dark',
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: expectedValue as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.theme).toBe('dark');
      expect(result.search).toEqual({ visibleFields: ['date', 'location'] });
    });

    it('should replace visibleFields wholesale (not merge arrays)', async () => {
      const settingsWithSearch: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        search: { visibleFields: ['type', 'favorite'] },
      };

      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: settingsWithSearch as any,
      } as any);

      const partialUpdate = {
        search: { visibleFields: ['date'] },
      };

      const expectedValue: UserSettingsValue = {
        ...settingsWithSearch,
        search: { visibleFields: ['date'] },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: expectedValue as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      // Must be the new array only, not merged with old
      expect(result.search).toEqual({ visibleFields: ['date'] });
    });

    it('should accept empty visibleFields array (show all fields)', async () => {
      const partialUpdate = {
        search: { visibleFields: [] },
      };

      const expectedValue: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        search: { visibleFields: [] },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: expectedValue as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.search).toEqual({ visibleFields: [] });
    });
  });

  describe('patchSettings (PATCH)', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
    });

    it('should merge partial settings with existing settings', async () => {
      const partialUpdate = {
        theme: 'dark' as const,
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.theme).toBe('dark');
      expect(result.profile).toEqual(DEFAULT_USER_SETTINGS.profile);
      expect(result.version).toBe(2);
    });

    it('should handle nested profile updates', async () => {
      const partialUpdate = {
        profile: {
          displayName: 'Updated Name',
        },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            displayName: 'Updated Name',
            useProviderImage: DEFAULT_USER_SETTINGS.profile.useProviderImage,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.profile.displayName).toBe('Updated Name');
      expect(result.profile.useProviderImage).toBe(
        DEFAULT_USER_SETTINGS.profile.useProviderImage,
      );
    });

    it('should sync displayName when updated via patch', async () => {
      const partialUpdate = {
        profile: {
          displayName: 'Patched Name',
        },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            displayName: 'Patched Name',
            useProviderImage: DEFAULT_USER_SETTINGS.profile.useProviderImage,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      await service.patchSettings(mockUserId, partialUpdate);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockUserId },
        data: { displayName: 'Patched Name' },
      });
    });

    it('should throw ConflictException on version mismatch', async () => {
      const partialUpdate = {
        theme: 'dark' as const,
      };

      // Current version is 1, but expected version is 2
      await expect(
        service.patchSettings(mockUserId, partialUpdate, 2),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.patchSettings(mockUserId, partialUpdate, 2),
      ).rejects.toThrow('Settings version mismatch. Expected 2, found 1');

      // Should not call update when version mismatch
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('should succeed when expected version matches', async () => {
      const partialUpdate = {
        theme: 'dark' as const,
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: 'dark',
          profile: DEFAULT_USER_SETTINGS.profile,
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      // Current version is 1, expected version is 1
      const result = await service.patchSettings(
        mockUserId,
        partialUpdate,
        1,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(2);
      expect(mockPrisma.userSettings.update).toHaveBeenCalled();
    });

    it('should handle multiple profile field updates', async () => {
      const partialUpdate = {
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://example.com/custom.jpg',
        },
      };

      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          theme: DEFAULT_USER_SETTINGS.theme,
          profile: {
            useProviderImage: false,
            customImageUrl: 'https://example.com/custom.jpg',
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.patchSettings(mockUserId, partialUpdate);

      expect(result.profile.useProviderImage).toBe(false);
      expect(result.profile.customImageUrl).toBe(
        'https://example.com/custom.jpg',
      );
    });
  });

  describe('updateProfileImage', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        version: 2,
      } as any);
      mockPrisma.user.update.mockResolvedValue({} as any);
    });

    it('should update profile image preference', async () => {
      await service.updateProfileImage(
        mockUserId,
        false,
        'https://example.com/custom.jpg',
      );

      expect(mockPrisma.userSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: mockUserId },
          data: expect.objectContaining({
            value: expect.objectContaining({
              profile: expect.objectContaining({
                useProviderImage: false,
                customImageUrl: 'https://example.com/custom.jpg',
              }),
            }),
          }),
        }),
      );
    });
  });

  describe('updateTheme', () => {
    beforeEach(() => {
      mockPrisma.userSettings.findUnique.mockResolvedValue(
        mockUserSettings as any,
      );
      mockPrisma.userSettings.update.mockResolvedValue({
        ...mockUserSettings,
        value: {
          ...DEFAULT_USER_SETTINGS,
          theme: 'dark',
        } as any,
        version: 2,
      } as any);
      mockPrisma.user.update.mockResolvedValue({} as any);
    });

    it('should update theme preference', async () => {
      const result = await service.updateTheme(mockUserId, 'dark');

      expect(result.theme).toBe('dark');
      expect(mockPrisma.userSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: mockUserId },
          data: expect.objectContaining({
            value: expect.objectContaining({
              theme: 'dark',
            }),
          }),
        }),
      );
    });
  });

  // ===========================================================================
  // dataTables merge semantics (issue #255)
  // ===========================================================================

  describe('patchSettings (PATCH) — dataTables', () => {
    /** The value handed to prisma.userSettings.update, i.e. the merge result. */
    const persistedValue = (): UserSettingsValue =>
      (mockPrisma.userSettings.update.mock.calls[0][0] as any).data
        .value as UserSettingsValue;

    /** Seeds stored settings and a pass-through update mock. */
    const seed = (dataTables?: Record<string, any>) => {
      const stored: UserSettingsValue = {
        ...DEFAULT_USER_SETTINGS,
        ...(dataTables ? { dataTables } : {}),
      };

      mockPrisma.userSettings.findUnique.mockResolvedValue({
        ...mockUserSettings,
        value: stored as any,
      } as any);

      mockPrisma.userSettings.update.mockImplementation((async (args: any) => ({
        ...mockUserSettings,
        value: args.data.value,
        version: 2,
      })) as any);

      mockPrisma.user.update.mockResolvedValue({} as any);
    };

    it('should leave dataTables absent when it was absent and is not patched', async () => {
      seed();

      const result = await service.patchSettings(mockUserId, { theme: 'dark' });

      expect(result.dataTables).toBeUndefined();
      expect(persistedValue().dataTables).toBeUndefined();
    });

    it('should persist a new entry into an absent namespace', async () => {
      seed();

      const result = await service.patchSettings(mockUserId, {
        dataTables: { jobs: { pageSize: 50, density: 'compact' } },
      });

      expect(result.dataTables).toEqual({
        jobs: { pageSize: 50, density: 'compact' },
      });
    });

    it('should NOT clobber another table id when patching one', async () => {
      seed({
        jobs: { pageSize: 25, visibleColumns: ['type', 'status'] },
        users: { density: 'compact' },
      });

      const result = await service.patchSettings(mockUserId, {
        dataTables: { jobs: { pageSize: 100 } },
      });

      // The patched entry is replaced wholesale...
      expect(result.dataTables!.jobs).toEqual({ pageSize: 100 });
      // ...and the untouched entry survives byte-for-byte.
      expect(result.dataTables!.users).toEqual({ density: 'compact' });
      expect(persistedValue().dataTables!.users).toEqual({
        density: 'compact',
      });
    });

    it('should preserve dataTables when patching an unrelated field', async () => {
      seed({ jobs: { pageSize: 25 } });

      const result = await service.patchSettings(mockUserId, {
        theme: 'light',
      });

      expect(result.theme).toBe('light');
      expect(result.dataTables).toEqual({ jobs: { pageSize: 25 } });
    });

    it('should replace a patched entry wholesale rather than deep-merging it', async () => {
      seed({ jobs: { pageSize: 25, density: 'compact' } });

      const result = await service.patchSettings(mockUserId, {
        dataTables: { jobs: { density: 'comfortable' } },
      });

      // pageSize is GONE, not retained — entry-level replace is what makes
      // "reset this table to defaults" expressible.
      expect(result.dataTables!.jobs).toEqual({ density: 'comfortable' });
      expect(result.dataTables!.jobs.pageSize).toBeUndefined();
    });

    it('should reset an entry to defaults when patched with {}', async () => {
      seed({ jobs: { pageSize: 25, visibleColumns: ['type'] } });

      const result = await service.patchSettings(mockUserId, {
        dataTables: { jobs: {} },
      });

      expect(result.dataTables).toEqual({ jobs: {} });
      expect(result.dataTables!.jobs.visibleColumns).toBeUndefined();
    });

    it('should delete an entry patched with null and keep the rest', async () => {
      seed({ jobs: { pageSize: 25 }, users: { density: 'compact' } });

      const result = await service.patchSettings(mockUserId, {
        dataTables: { jobs: null },
      });

      expect(result.dataTables).toEqual({ users: { density: 'compact' } });
    });

    it('should collapse the namespace back to absent when the last entry is deleted', async () => {
      seed({ jobs: { pageSize: 25 } });

      const result = await service.patchSettings(mockUserId, {
        dataTables: { jobs: null },
      });

      expect(result.dataTables).toBeUndefined();
      expect(persistedValue().dataTables).toBeUndefined();
    });

    it('should apply several table ids in one patch', async () => {
      seed({ jobs: { pageSize: 25 }, users: {} });

      const result = await service.patchSettings(mockUserId, {
        dataTables: {
          jobs: { pageSize: 10 },
          shares: { density: 'standard' },
          users: null,
        },
      });

      expect(result.dataTables).toEqual({
        jobs: { pageSize: 10 },
        shares: { density: 'standard' },
      });
    });

    it('should reject a patch whose MERGED result exceeds the table-id cap', async () => {
      const stored: Record<string, any> = {};
      for (let i = 0; i < DATA_TABLE_MAX_TABLES; i++) {
        stored[`t${i}`] = {};
      }
      seed(stored);

      // The patch payload alone is one entry — under the cap — but merging it
      // onto a full namespace is not.
      await expect(
        service.patchSettings(mockUserId, {
          dataTables: { overflow: {} },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
    });

    it('should allow replacing an existing entry when the namespace is at the cap', async () => {
      const stored: Record<string, any> = {};
      for (let i = 0; i < DATA_TABLE_MAX_TABLES; i++) {
        stored[`t${i}`] = {};
      }
      seed(stored);

      const result = await service.patchSettings(mockUserId, {
        dataTables: { t0: { pageSize: 10 } },
      });

      expect(Object.keys(result.dataTables!)).toHaveLength(
        DATA_TABLE_MAX_TABLES,
      );
      expect(result.dataTables!.t0).toEqual({ pageSize: 10 });
    });
  });

  describe('replaceSettings (PUT) — dataTables', () => {
    it('should round-trip a full entry', async () => {
      const dataTables = {
        'admin-jobs': {
          visibleColumns: ['type', 'status'],
          density: 'comfortable' as const,
          sort: { field: 'createdAt', direction: 'desc' as const },
          pageSize: 50,
        },
      };

      mockPrisma.userSettings.upsert.mockImplementation((async (args: any) => ({
        ...mockUserSettings,
        value: args.update?.value ?? args.create?.value,
        version: 2,
      })) as any);
      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, {
        theme: 'system',
        profile: { useProviderImage: true },
        dataTables,
      } as any);

      expect(result.dataTables).toEqual(dataTables);
    });

    it('should store the namespace as absent when omitted', async () => {
      mockPrisma.userSettings.upsert.mockImplementation((async (args: any) => ({
        ...mockUserSettings,
        value: args.update?.value ?? args.create?.value,
        version: 2,
      })) as any);
      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, {
        theme: 'system',
        profile: { useProviderImage: true },
      } as any);

      expect(result.dataTables).toBeUndefined();
    });

    it('should drop the namespace when PUT omits it, even if one was stored', async () => {
      // PUT is a full replacement: omitting dataTables clears it.
      mockPrisma.userSettings.upsert.mockImplementation((async (args: any) => ({
        ...mockUserSettings,
        value: args.update.value,
        version: 3,
      })) as any);
      mockPrisma.user.update.mockResolvedValue({} as any);

      const result = await service.replaceSettings(mockUserId, {
        theme: 'dark',
        profile: { useProviderImage: true },
      } as any);

      expect(result.dataTables).toBeUndefined();
    });
  });
});

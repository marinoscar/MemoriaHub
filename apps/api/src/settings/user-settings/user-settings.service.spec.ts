import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
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
});

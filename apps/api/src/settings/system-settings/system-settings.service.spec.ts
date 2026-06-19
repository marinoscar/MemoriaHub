import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../common/types/settings.types';

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let mockPrisma: MockPrismaService;

  const mockUserId = 'user-123';
  const mockUser = {
    id: mockUserId,
    email: 'admin@example.com',
  };

  const mockSystemSettings = {
    id: 'settings-1',
    key: 'global',
    value: DEFAULT_SYSTEM_SETTINGS as any,
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: mockUserId,
    updatedByUser: mockUser,
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<SystemSettingsService>(SystemSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return current system settings with version', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      const result = await service.getSettings();

      expect(result).toMatchObject({
        ui: DEFAULT_SYSTEM_SETTINGS.ui,
        features: DEFAULT_SYSTEM_SETTINGS.features,
        version: 1,
      });
      expect(result.updatedAt).toBeDefined();
      expect(result.updatedBy).toEqual(mockUser);
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
        where: { key: 'global' },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should create and return default settings when none exist', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockResolvedValue({
        ...mockSystemSettings,
        updatedByUserId: null,
        updatedByUser: null,
      } as any);

      const result = await service.getSettings();

      expect(result).toMatchObject({
        ui: DEFAULT_SYSTEM_SETTINGS.ui,
        features: DEFAULT_SYSTEM_SETTINGS.features,
        version: 1,
      });
      expect(mockPrisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          key: 'global',
          value: DEFAULT_SYSTEM_SETTINGS as any,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });
  });

  describe('replaceSettings (PUT)', () => {
    it('should replace entire settings', async () => {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: false },
        features: { newFeature: true },
        ai: {
          features: {
            search: { provider: null, model: null },
            tagging: { provider: null, model: null },
          },
          conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
        },
      };

      // systemSettingsSchema.parse adds face with defaults when omitted
      const expectedParsed = {
        ...newSettings,
        face: { features: { detection: { provider: null, model: null } } },
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: expectedParsed as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result).toMatchObject({
        ui: newSettings.ui,
        features: newSettings.features,
        version: 2,
      });
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'global' },
        update: {
          value: expectedParsed as any,
          updatedByUserId: mockUserId,
          version: { increment: 1 },
        },
        create: {
          key: 'global',
          value: expectedParsed as any,
          updatedByUserId: mockUserId,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should increment version on update', async () => {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: true },
        features: {},
        ai: {
          features: {
            search: { provider: null, model: null },
            tagging: { provider: null, model: null },
          },
          conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
        },
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 5,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result.version).toBe(5);
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on replace', async () => {
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: false },
        features: {},
        ai: {
          features: {
            search: { provider: null, model: null },
            tagging: { provider: null, model: null },
          },
          conversations: { archiveAfterDays: 30, deleteAfterArchiveDays: 30 },
        },
      };

      // systemSettingsSchema.parse adds face with defaults — the validated
      // object (not the original DTO) is stored in the audit event.
      const expectedValidated = {
        ...newSettings,
        face: { features: { detection: { provider: null, model: null } } },
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: expectedValidated as any,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.replaceSettings(newSettings, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:replace',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: {
            newValue: expectedValidated,
          } as any,
        },
      });
    });
  });

  describe('patchSettings (PATCH)', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
    });

    it('should merge partial settings with existing settings', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.ui.allowUserThemeOverride).toBe(false);
      expect(result.features).toEqual(DEFAULT_SYSTEM_SETTINGS.features);
    });

    it('should handle features object merge', async () => {
      const existingWithFeatures = {
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          features: { existingFeature: true },
        } as any,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        existingWithFeatures as any,
      );

      const partialUpdate = {
        features: { newFeature: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: DEFAULT_SYSTEM_SETTINGS.ui,
          features: { existingFeature: true, newFeature: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.features).toEqual({
        existingFeature: true,
        newFeature: true,
      });
    });

    it('should throw ConflictException when If-Match version mismatch', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      // Current version is 1, but expected version is 2
      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(
        'Settings version mismatch. Expected 2, found 1',
      );

      // Should not call update when version mismatch
      expect(mockPrisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('should succeed when If-Match version matches', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      // Current version is 1, expected version is 1
      const result = await service.patchSettings(
        partialUpdate,
        mockUserId,
        1,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalled();
    });

    it('should increment version on patch', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on patch', async () => {
      const partialUpdate = {
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ui: { allowUserThemeOverride: false },
          features: DEFAULT_SYSTEM_SETTINGS.features,
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(partialUpdate, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:patch',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: expect.objectContaining({
            changes: partialUpdate,
            resultingValue: expect.any(Object),
          }) as any,
        },
      });
    });

    it('should persist face detection provider and model (round-trip)', async () => {
      const detectionPatch = {
        face: {
          features: {
            detection: {
              provider: 'compreface',
              model: 'compreface-arcface-mobilefacenet-128',
            },
          },
        },
      };

      const savedValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        face: {
          features: {
            detection: {
              provider: 'compreface',
              model: 'compreface-arcface-mobilefacenet-128',
            },
          },
        },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: savedValue as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(detectionPatch as any, mockUserId);

      // Verify the merged object passed to Prisma contains face
      const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
      expect(updateCall.data.value).toMatchObject({
        face: {
          features: {
            detection: {
              provider: 'compreface',
              model: 'compreface-arcface-mobilefacenet-128',
            },
          },
        },
      });

      // Verify face is present in the returned value (not silently dropped)
      expect((result as any).face).toBeDefined();
      expect((result as any).face.features.detection.provider).toBe('compreface');
      expect((result as any).face.features.detection.model).toBe('compreface-arcface-mobilefacenet-128');
    });

    it('should preserve existing face detection settings when patching unrelated fields', async () => {
      // Existing settings have face configured
      const existingWithFace = {
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          face: {
            features: {
              detection: { provider: 'compreface', model: 'compreface-arcface-mobilefacenet-128' },
            },
          },
        } as any,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingWithFace as any);

      const savedValue = {
        ...existingWithFace.value,
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: savedValue as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      // Patch only ui — face should be preserved in the merged object
      await service.patchSettings({ ui: { allowUserThemeOverride: false } }, mockUserId);

      const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
      expect(updateCall.data.value).toMatchObject({
        face: {
          features: {
            detection: {
              provider: 'compreface',
              model: 'compreface-arcface-mobilefacenet-128',
            },
          },
        },
      });
    });

    it('should carry face null values when no face settings exist yet', async () => {
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          face: { features: { detection: { provider: null, model: null } } },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings({ ui: { allowUserThemeOverride: true } }, mockUserId);

      const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
      expect(updateCall.data.value).toMatchObject({
        face: {
          features: {
            detection: { provider: null, model: null },
          },
        },
      });
    });

    it('should persist ai.features.tagging provider and model (round-trip)', async () => {
      const taggingPatch = {
        ai: {
          features: {
            tagging: {
              provider: 'openai',
              model: 'gpt-4o',
            },
          },
        },
      };

      const savedValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        ai: {
          ...DEFAULT_SYSTEM_SETTINGS.ai,
          features: {
            ...DEFAULT_SYSTEM_SETTINGS.ai.features,
            tagging: { provider: 'openai', model: 'gpt-4o' },
          },
        },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: savedValue as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(taggingPatch as any, mockUserId);

      // Verify the merged value passed to Prisma contains the tagging config
      const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
      expect(updateCall.data.value).toMatchObject({
        ai: {
          features: {
            tagging: { provider: 'openai', model: 'gpt-4o' },
          },
        },
      });

      // Verify the returned value reflects the tagging config (not silently dropped)
      expect((result as any).ai.features.tagging.provider).toBe('openai');
      expect((result as any).ai.features.tagging.model).toBe('gpt-4o');
    });

    it('should preserve existing ai.features.tagging when patching unrelated fields', async () => {
      // Existing settings have tagging configured
      const existingWithTagging = {
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          ai: {
            ...DEFAULT_SYSTEM_SETTINGS.ai,
            features: {
              ...DEFAULT_SYSTEM_SETTINGS.ai.features,
              tagging: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
            },
          },
        } as any,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(existingWithTagging as any);

      const savedValue = {
        ...existingWithTagging.value,
        ui: { allowUserThemeOverride: false },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: savedValue as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      // Patch only ui — tagging should be preserved in the merged object
      await service.patchSettings({ ui: { allowUserThemeOverride: false } }, mockUserId);

      const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
      expect(updateCall.data.value).toMatchObject({
        ai: {
          features: {
            tagging: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
          },
        },
      });
    });
  });

  describe('getSettingValue', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
    });

    it('should get nested setting value by path', async () => {
      const value = await service.getSettingValue<boolean>(
        'ui.allowUserThemeOverride',
      );

      expect(value).toBe(DEFAULT_SYSTEM_SETTINGS.ui.allowUserThemeOverride);
    });

    it('should return undefined for non-existent path', async () => {
      const value = await service.getSettingValue<any>('ui.nonExistent');

      expect(value).toBeUndefined();
    });
  });

  describe('isFeatureEnabled', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          features: { featureA: true, featureB: false },
        } as any,
      } as any);
    });

    it('should return true for enabled feature', async () => {
      const result = await service.isFeatureEnabled('featureA');

      expect(result).toBe(true);
    });

    it('should return false for disabled feature', async () => {
      const result = await service.isFeatureEnabled('featureB');

      expect(result).toBe(false);
    });

    it('should return false for non-existent feature', async () => {
      const result = await service.isFeatureEnabled('featureC');

      expect(result).toBe(false);
    });
  });
});

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
            embedding: { provider: null, model: null },
          },
        },
      };

      // systemSettingsSchema.parse fills in every optional top-level branch
      // with its default when omitted from the DTO — not just `face`. This
      // fixture must mirror ALL of those defaults (face, storage, burst,
      // dedup, geo, jobs) or the toHaveBeenCalledWith assertion below drifts
      // out of sync every time a new default branch is added to the schema.
      const expectedParsed = {
        ...newSettings,
        face: DEFAULT_SYSTEM_SETTINGS.face,
        storage: DEFAULT_SYSTEM_SETTINGS.storage,
        burst: DEFAULT_SYSTEM_SETTINGS.burst,
        dedup: DEFAULT_SYSTEM_SETTINGS.dedup,
        locationInference: DEFAULT_SYSTEM_SETTINGS.locationInference,
        socialMedia: DEFAULT_SYSTEM_SETTINGS.socialMedia,
        geo: DEFAULT_SYSTEM_SETTINGS.geo,
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        email: DEFAULT_SYSTEM_SETTINGS.email,
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
            embedding: { provider: null, model: null },
          },
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
            embedding: { provider: null, model: null },
          },
        },
      };

      // systemSettingsSchema.parse fills in every optional top-level branch
      // with its default when omitted — the validated object (not the
      // original DTO) is stored in the audit event.
      const expectedValidated = {
        ...newSettings,
        face: DEFAULT_SYSTEM_SETTINGS.face,
        storage: DEFAULT_SYSTEM_SETTINGS.storage,
        burst: DEFAULT_SYSTEM_SETTINGS.burst,
        dedup: DEFAULT_SYSTEM_SETTINGS.dedup,
        locationInference: DEFAULT_SYSTEM_SETTINGS.locationInference,
        socialMedia: DEFAULT_SYSTEM_SETTINGS.socialMedia,
        geo: DEFAULT_SYSTEM_SETTINGS.geo,
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        email: DEFAULT_SYSTEM_SETTINGS.email,
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

    // -------------------------------------------------------------------------
    // Fix #1 regression tests: jobs and face.video preservation
    // -------------------------------------------------------------------------
    describe('jobs and face.video preservation (Fix #1)', () => {
      it('preserves non-default jobs and face.video values when patching an unrelated field', async () => {
        // Arrange: existing settings have non-default jobs.history and face.video values
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { history: { retentionDays: 90, purgeEnabled: false } },
          face: {
            features: DEFAULT_SYSTEM_SETTINGS.face!.features,
            video: { enabled: true, sampleIntervalSeconds: 20, maxFramesPerVideo: 30 },
          },
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        const savedValue = {
          ...existingValue,
          geo: {
            ...(DEFAULT_SYSTEM_SETTINGS.geo as any),
            forwardSearchEnabled: true,
          },
        };
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: savedValue as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        // Act: patch only geo.forwardSearchEnabled — jobs and face.video must NOT reset
        const result = await service.patchSettings(
          { geo: { forwardSearchEnabled: true } } as any,
          mockUserId,
        );

        // Assert: the value written to DB preserves the non-default jobs and face.video
        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          jobs: { history: { retentionDays: 90, purgeEnabled: false } },
          face: expect.objectContaining({
            video: expect.objectContaining({ sampleIntervalSeconds: 20 }),
          }),
        });

        // Assert: the returned value includes the jobs branch with the preserved values
        expect((result as any).jobs).toBeDefined();
        expect((result as any).jobs.history.retentionDays).toBe(90);
        expect((result as any).jobs.history.purgeEnabled).toBe(false);
      });

      it('updates jobs.history.retentionDays when explicitly included in the PATCH dto', async () => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { history: { retentionDays: 60, purgeEnabled: false } },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { jobs: { history: { retentionDays: 60, purgeEnabled: false } } } as any,
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          jobs: { history: { retentionDays: 60, purgeEnabled: false } },
        });
      });

      it('updates face.video settings when explicitly included in the PATCH dto', async () => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            face: {
              features: DEFAULT_SYSTEM_SETTINGS.face!.features,
              video: { enabled: false, sampleIntervalSeconds: 10, maxFramesPerVideo: 90 },
            },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { face: { video: { enabled: false, sampleIntervalSeconds: 10, maxFramesPerVideo: 90 } } } as any,
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          face: expect.objectContaining({
            video: { enabled: false, sampleIntervalSeconds: 10, maxFramesPerVideo: 90 },
          }),
        });
      });

      it('includes the jobs branch in the returned value after any patch', async () => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { history: { retentionDays: 30, purgeEnabled: true } },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: false } },
          mockUserId,
        );

        expect((result as any).jobs).toBeDefined();
        expect((result as any).jobs.history).toMatchObject({
          retentionDays: 30,
          purgeEnabled: true,
        });
      });
    });

    // -------------------------------------------------------------------------
    // jobs.stuckThresholdMinutes handling — mirrors the jobs.history
    // preservation/default/explicit-update coverage above.
    // -------------------------------------------------------------------------
    describe('jobs.stuckThresholdMinutes handling', () => {
      // Save/restore ENRICHMENT_STUCK_MINUTES so the "applies the default (3)"
      // assertion below is deterministic regardless of the ambient test env.
      const SAVED_STUCK_MINUTES_ENV = process.env['ENRICHMENT_STUCK_MINUTES'];

      beforeEach(() => {
        delete process.env['ENRICHMENT_STUCK_MINUTES'];
      });

      afterEach(() => {
        if (SAVED_STUCK_MINUTES_ENV === undefined) {
          delete process.env['ENRICHMENT_STUCK_MINUTES'];
        } else {
          process.env['ENRICHMENT_STUCK_MINUTES'] = SAVED_STUCK_MINUTES_ENV;
        }
      });

      it('preserves a non-default stuckThresholdMinutes value when patching an unrelated field', async () => {
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: {
            history: DEFAULT_SYSTEM_SETTINGS.jobs!.history,
            stuckThresholdMinutes: 45,
          },
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        const savedValue = {
          ...existingValue,
          ui: { allowUserThemeOverride: false },
        };
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: savedValue as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: false } },
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          jobs: expect.objectContaining({ stuckThresholdMinutes: 45 }),
        });
        expect((result as any).jobs.stuckThresholdMinutes).toBe(45);
      });

      it('applies the default (3) when stuckThresholdMinutes has never been set', async () => {
        // Existing settings predate the stuckThresholdMinutes field entirely.
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { history: DEFAULT_SYSTEM_SETTINGS.jobs!.history } as any,
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...existingValue,
            jobs: { ...existingValue.jobs, stuckThresholdMinutes: 3 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: true } },
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect((updateCall.data.value as any).jobs.stuckThresholdMinutes).toBe(3);
        expect((result as any).jobs.stuckThresholdMinutes).toBe(3);
      });

      it('updates stuckThresholdMinutes when explicitly included in the PATCH dto', async () => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { history: DEFAULT_SYSTEM_SETTINGS.jobs!.history, stuckThresholdMinutes: 60 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { jobs: { stuckThresholdMinutes: 60 } } as any,
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          jobs: expect.objectContaining({ stuckThresholdMinutes: 60 }),
        });
      });

      it('rejects an out-of-range stuckThresholdMinutes via schema validation on the merged result', async () => {
        // patchSettings re-validates the merged object with systemSettingsSchema;
        // an invalid explicit PATCH value must throw rather than silently clamp.
        await expect(
          service.patchSettings(
            { jobs: { stuckThresholdMinutes: 0 } } as any,
            mockUserId,
          ),
        ).rejects.toThrow();

        await expect(
          service.patchSettings(
            { jobs: { stuckThresholdMinutes: 121 } } as any,
            mockUserId,
          ),
        ).rejects.toThrow();
      });

      it('does not reset stuckThresholdMinutes when only jobs.history is patched', async () => {
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { history: { retentionDays: 30, purgeEnabled: true }, stuckThresholdMinutes: 90 },
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...existingValue,
            jobs: { history: { retentionDays: 7, purgeEnabled: true }, stuckThresholdMinutes: 90 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { jobs: { history: { retentionDays: 7 } } } as any,
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect((updateCall.data.value as any).jobs).toMatchObject({
          history: expect.objectContaining({ retentionDays: 7 }),
          stuckThresholdMinutes: 90,
        });
      });
    });

    describe('burst.autoResolveThreshold and dedup.autoResolveThreshold handling', () => {
      it('defaults burst.autoResolveThreshold to 60 when it has never been set', async () => {
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 } as any,
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...existingValue,
            burst: { ...existingValue.burst, autoResolveThreshold: 60 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: true } },
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect((updateCall.data.value as any).burst.autoResolveThreshold).toBe(60);
        expect((result as any).burst.autoResolveThreshold).toBe(60);
      });

      it('defaults dedup.autoResolveThreshold to 60 when it has never been set', async () => {
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          dedup: { similarityThreshold: 0.96, hashMaxDistance: 6, knnCandidates: 20 } as any,
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...existingValue,
            dedup: { ...existingValue.dedup, autoResolveThreshold: 60 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: true } },
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect((updateCall.data.value as any).dedup.autoResolveThreshold).toBe(60);
        expect((result as any).dedup.autoResolveThreshold).toBe(60);
      });

      it('preserves a non-default burst.autoResolveThreshold value when patching an unrelated field', async () => {
        const existingValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3, autoResolveThreshold: 85 },
        };
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: existingValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...existingValue,
            ui: { allowUserThemeOverride: false },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { ui: { allowUserThemeOverride: false } },
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect((updateCall.data.value as any).burst).toMatchObject({ autoResolveThreshold: 85 });
        expect((result as any).burst.autoResolveThreshold).toBe(85);
      });

      it('updates burst.autoResolveThreshold when explicitly included in the PATCH dto', async () => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            burst: { ...DEFAULT_SYSTEM_SETTINGS.burst, autoResolveThreshold: 90 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { burst: { autoResolveThreshold: 90 } } as any,
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          burst: expect.objectContaining({ autoResolveThreshold: 90 }),
        });
      });

      it('updates dedup.autoResolveThreshold when explicitly included in the PATCH dto', async () => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            dedup: { ...DEFAULT_SYSTEM_SETTINGS.dedup, autoResolveThreshold: 40 },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { dedup: { autoResolveThreshold: 40 } } as any,
          mockUserId,
        );

        const updateCall = mockPrisma.systemSettings.update.mock.calls[0][0];
        expect(updateCall.data.value).toMatchObject({
          dedup: expect.objectContaining({ autoResolveThreshold: 40 }),
        });
      });

      it('rejects an out-of-range burst.autoResolveThreshold via schema validation on the merged result', async () => {
        await expect(
          service.patchSettings(
            { burst: { autoResolveThreshold: 101 } } as any,
            mockUserId,
          ),
        ).rejects.toThrow();

        await expect(
          service.patchSettings(
            { burst: { autoResolveThreshold: -1 } } as any,
            mockUserId,
          ),
        ).rejects.toThrow();
      });

      it('rejects an out-of-range dedup.autoResolveThreshold via schema validation on the merged result', async () => {
        await expect(
          service.patchSettings(
            { dedup: { autoResolveThreshold: 101 } } as any,
            mockUserId,
          ),
        ).rejects.toThrow();

        await expect(
          service.patchSettings(
            { dedup: { autoResolveThreshold: -1 } } as any,
            mockUserId,
          ),
        ).rejects.toThrow();
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

  // ---------------------------------------------------------------------------
  // In-memory settings cache
  // ---------------------------------------------------------------------------
  describe('settings cache', () => {
    it('serves the second getSettings() call from cache without a second DB read', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      await service.getSettings();
      await service.getSettings();

      // DB should only have been hit once despite two calls
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);
    });

    it('serves isFeatureEnabled from cache on consecutive calls within the TTL', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          features: { autoTagging: true },
        } as any,
      } as any);

      const first = await service.isFeatureEnabled('autoTagging');
      const second = await service.isFeatureEnabled('autoTagging');

      expect(first).toBe(true);
      expect(second).toBe(true);
      // getSettings() is called by each isFeatureEnabled, but cache is warm after the 1st
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);
    });

    it('invalidates the cache after replaceSettings so the next getSettings re-reads the DB', async () => {
      // Populate the cache
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      await service.getSettings();
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);

      // replaceSettings writes via upsert and must invalidate the cache
      const newSettings: SystemSettingsValue = {
        ui: { allowUserThemeOverride: true },
        features: {},
        ai: {
          features: {
            search: { provider: null, model: null },
            tagging: { provider: null, model: null },
            embedding: { provider: null, model: null },
          },
        },
      };
      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.replaceSettings(newSettings, mockUserId);

      // upsert does not trigger findUnique — still 1 call so far
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);

      // The next getSettings() must go to DB because the cache was invalidated
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);
      await service.getSettings();

      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('invalidates the cache after patchSettings so the next getSettings re-reads the DB', async () => {
      // patchSettings internally calls getSettings() — that is the 1st DB read
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { ui: { allowUserThemeOverride: true } },
        mockUserId,
      );

      // findUnique called once (inside patchSettings → getSettings())
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);

      // After patchSettings the cache must be invalidated; next getSettings re-reads DB
      await service.getSettings();

      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(2);
    });
  });
});

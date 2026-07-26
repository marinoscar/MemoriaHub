/**
 * Unit tests for FeaturesController (GET /api/features).
 *
 * This endpoint is the least-privilege carrier for client-visible feature
 * flags — readable by ANY authenticated user, unlike GET /api/system-settings
 * (Admin-only, `system_settings:read`). The controller is a thin delegate to
 * SystemSettingsService.getPublicFeatures(), so these tests assert:
 *   - the response shape matches the documented contract exactly
 *   - nothing outside {features, pictureEnhancement} leaks through, in
 *     particular nothing from the `email` settings namespace (which carries
 *     an encrypted SMTP password on the full settings object)
 *   - the `pictureEnhancement.enabled` flag reflects both the system-setting
 *     toggle AND the PICTURE_ENHANCEMENT_ENABLED env kill-switch
 *   - `model` mirrors the configured enhancement model, or null when unset
 */

import { FeaturesController } from './features.controller';
import { SystemSettingsService } from './system-settings/system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

/**
 * End-to-end (through the REAL SystemSettingsService, mocked Prisma only)
 * coverage of the env-kill-switch interaction. The mocked-getPublicFeatures
 * tests above assert the controller passes the resolved value through
 * untouched; these assert the actual `isPictureEnhancementEnabled()` toggle
 * x env-var resolution the controller ultimately depends on.
 */
function makeSettingsRow(overrides: {
  pictureEnhancementFeatureFlag: boolean;
  model?: string | null;
}) {
  return {
    key: 'global',
    value: {
      features: { pictureEnhancement: overrides.pictureEnhancementFeatureFlag },
      ai: {
        features: {
          enhance:
            overrides.model === undefined
              ? null
              : overrides.model === null
                ? null
                : { provider: 'openai', model: overrides.model },
        },
      },
      pictureEnhancement: { allowReplace: true, blockReplaceOnDownscale: false },
    },
    updatedAt: new Date(),
    updatedByUserId: null,
    updatedByUser: null,
    version: 1,
  };
}

describe('FeaturesController (real SystemSettingsService, env kill-switch)', () => {
  let controller: FeaturesController;
  let mockPrisma: MockPrismaService;
  let realService: SystemSettingsService;

  beforeEach(() => {
    mockPrisma = createMockPrismaService();
    realService = new SystemSettingsService(mockPrisma as unknown as PrismaService);
    controller = new FeaturesController(realService);
  });

  afterEach(() => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
  });

  it('toggled ON via system setting, env unset -> enabled true', async () => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
    mockPrisma.systemSettings.findUnique.mockResolvedValue(
      makeSettingsRow({ pictureEnhancementFeatureFlag: true, model: 'gpt-image-1' }) as any,
    );

    const result = await controller.getFeatures();

    expect(result.pictureEnhancement.enabled).toBe(true);
    expect(result.pictureEnhancement.model).toBe('gpt-image-1');
  });

  it('toggled OFF via system setting, env unset -> enabled false', async () => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
    mockPrisma.systemSettings.findUnique.mockResolvedValue(
      makeSettingsRow({ pictureEnhancementFeatureFlag: false }) as any,
    );

    const result = await controller.getFeatures();

    expect(result.pictureEnhancement.enabled).toBe(false);
  });

  it('toggled ON via system setting, but PICTURE_ENHANCEMENT_ENABLED=false env override -> enabled false', async () => {
    process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
    mockPrisma.systemSettings.findUnique.mockResolvedValue(
      makeSettingsRow({ pictureEnhancementFeatureFlag: true, model: 'gpt-image-1' }) as any,
    );

    const result = await controller.getFeatures();

    expect(result.pictureEnhancement.enabled).toBe(false);
  });

  it('toggled OFF via system setting AND env override present -> still false (both independently off)', async () => {
    process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
    mockPrisma.systemSettings.findUnique.mockResolvedValue(
      makeSettingsRow({ pictureEnhancementFeatureFlag: false }) as any,
    );

    const result = await controller.getFeatures();

    expect(result.pictureEnhancement.enabled).toBe(false);
  });

  it('model is null when ai.features.enhance is unset, even with the feature ON', async () => {
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
    mockPrisma.systemSettings.findUnique.mockResolvedValue(
      makeSettingsRow({ pictureEnhancementFeatureFlag: true, model: null }) as any,
    );

    const result = await controller.getFeatures();

    expect(result.pictureEnhancement.model).toBeNull();
  });
});

describe('FeaturesController', () => {
  let controller: FeaturesController;
  let mockSystemSettingsService: { getPublicFeatures: jest.Mock };

  beforeEach(() => {
    mockSystemSettingsService = { getPublicFeatures: jest.fn() };

    controller = new FeaturesController(
      mockSystemSettingsService as unknown as SystemSettingsService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
  });

  it('delegates to SystemSettingsService.getPublicFeatures and returns its result verbatim', async () => {
    const publicFeatures = {
      features: { pictureEnhancement: true, faceRecognition: false },
      pictureEnhancement: {
        enabled: true,
        allowReplace: true,
        blockReplaceOnDownscale: false,
        model: 'gpt-image-1',
      },
    };
    mockSystemSettingsService.getPublicFeatures.mockResolvedValue(publicFeatures);

    const result = await controller.getFeatures();

    expect(mockSystemSettingsService.getPublicFeatures).toHaveBeenCalledWith();
    expect(result).toEqual(publicFeatures);
  });

  it('returns ONLY features + pictureEnhancement — no other settings namespace leaks through', async () => {
    const publicFeatures = {
      features: { pictureEnhancement: true },
      pictureEnhancement: {
        enabled: true,
        allowReplace: true,
        blockReplaceOnDownscale: false,
        model: null,
      },
    };
    mockSystemSettingsService.getPublicFeatures.mockResolvedValue(publicFeatures);

    const result = await controller.getFeatures();

    expect(Object.keys(result).sort()).toEqual(['features', 'pictureEnhancement']);
    // In particular, no `email` namespace (which carries the encrypted SMTP
    // password on the full system-settings document) is ever present.
    expect(result).not.toHaveProperty('email');
    expect((result as unknown as Record<string, unknown>)['smtpPassword']).toBeUndefined();
  });

  describe('pictureEnhancement.enabled reflects the system-setting flag AND the env kill-switch', () => {
    it('is true when features.pictureEnhancement is ON and the env kill-switch is unset', async () => {
      delete process.env['PICTURE_ENHANCEMENT_ENABLED'];
      mockSystemSettingsService.getPublicFeatures.mockResolvedValue({
        features: { pictureEnhancement: true },
        pictureEnhancement: {
          enabled: true,
          allowReplace: true,
          blockReplaceOnDownscale: false,
          model: 'gpt-image-1',
        },
      });

      const result = await controller.getFeatures();

      expect(result.pictureEnhancement.enabled).toBe(true);
    });

    it('is false when features.pictureEnhancement is OFF, independent of the env kill-switch', async () => {
      mockSystemSettingsService.getPublicFeatures.mockResolvedValue({
        features: { pictureEnhancement: false },
        pictureEnhancement: {
          enabled: false,
          allowReplace: true,
          blockReplaceOnDownscale: false,
          model: null,
        },
      });

      const result = await controller.getFeatures();

      expect(result.pictureEnhancement.enabled).toBe(false);
    });

    it('is false when features.pictureEnhancement is ON but PICTURE_ENHANCEMENT_ENABLED=false overrides it', async () => {
      process.env['PICTURE_ENHANCEMENT_ENABLED'] = 'false';
      // The controller itself does not read the env var — it trusts whatever
      // getPublicFeatures (which owns the isPictureEnhancementEnabled() logic)
      // returns. This asserts the controller passes that resolved value
      // through untouched rather than re-deriving or overriding it.
      mockSystemSettingsService.getPublicFeatures.mockResolvedValue({
        features: { pictureEnhancement: true },
        pictureEnhancement: {
          enabled: false,
          allowReplace: true,
          blockReplaceOnDownscale: false,
          model: 'gpt-image-1',
        },
      });

      const result = await controller.getFeatures();

      expect(result.pictureEnhancement.enabled).toBe(false);
    });
  });

  describe('pictureEnhancement.model', () => {
    it('is the configured model name when ai.features.enhance is set', async () => {
      mockSystemSettingsService.getPublicFeatures.mockResolvedValue({
        features: { pictureEnhancement: true },
        pictureEnhancement: {
          enabled: true,
          allowReplace: true,
          blockReplaceOnDownscale: false,
          model: 'gpt-image-1',
        },
      });

      const result = await controller.getFeatures();

      expect(result.pictureEnhancement.model).toBe('gpt-image-1');
    });

    it('is null when ai.features.enhance is unset', async () => {
      mockSystemSettingsService.getPublicFeatures.mockResolvedValue({
        features: { pictureEnhancement: true },
        pictureEnhancement: {
          enabled: true,
          allowReplace: true,
          blockReplaceOnDownscale: false,
          model: null,
        },
      });

      const result = await controller.getFeatures();

      expect(result.pictureEnhancement.model).toBeNull();
    });
  });
});

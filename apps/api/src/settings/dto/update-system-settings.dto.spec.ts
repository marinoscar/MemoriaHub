import {
  updateSystemSettingsSchema,
  patchSystemSettingsSchema,
} from './update-system-settings.dto';

// Canonical valid ai block for PUT (full-replace) fixtures
const validAiBlock = {
  features: { search: { provider: null, model: null } },
};

describe('UpdateSystemSettingsDto (PUT)', () => {
  describe('ui field', () => {
    it('should accept valid ui settings object', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {},
        ai: validAiBlock,
      });

      expect(result.ui.allowUserThemeOverride).toBe(true);
    });

    it('should accept allowUserThemeOverride as false', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: false,
        },
        features: {},
        ai: validAiBlock,
      });

      expect(result.ui.allowUserThemeOverride).toBe(false);
    });

    it('should reject ui without allowUserThemeOverride', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {},
          features: {},
          ai: validAiBlock,
        }),
      ).toThrow();
    });

    it('should reject non-boolean allowUserThemeOverride', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {
            allowUserThemeOverride: 'true',
          },
          features: {},
          ai: validAiBlock,
        }),
      ).toThrow();
    });

    it('should require ui field', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          features: {},
          ai: validAiBlock,
        }),
      ).toThrow();
    });
  });

  describe('features field', () => {
    it('should accept empty features object', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {},
        ai: validAiBlock,
      });

      expect(result.features).toEqual({});
    });

    it('should accept features with boolean flags', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {
          enableNotifications: true,
          enableAnalytics: false,
        },
        ai: validAiBlock,
      });

      expect(result.features).toEqual({
        enableNotifications: true,
        enableAnalytics: false,
      });
    });

    it('should reject features with non-boolean values', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {
            allowUserThemeOverride: true,
          },
          features: {
            enableNotifications: 'true',
          },
          ai: validAiBlock,
        }),
      ).toThrow();
    });

    it('should require features field', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {
            allowUserThemeOverride: true,
          },
          ai: validAiBlock,
        }),
      ).toThrow();
    });
  });

  describe('ai field', () => {
    it('should require ai field', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: { allowUserThemeOverride: true },
          features: {},
        }),
      ).toThrow();
    });

    it('should accept a valid ai block with null provider and model', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: { allowUserThemeOverride: true },
        features: {},
        ai: {
          features: { search: { provider: null, model: null } },
        },
      });

      expect(result.ai.features.search.provider).toBeNull();
      expect(result.ai.features.search.model).toBeNull();
    });

    it('should accept a valid ai block with string provider and model', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: { allowUserThemeOverride: false },
        features: {},
        ai: {
          features: { search: { provider: 'openai', model: 'gpt-4o' } },
        },
      });

      expect(result.ai.features.search.provider).toBe('openai');
      expect(result.ai.features.search.model).toBe('gpt-4o');
    });
  });

  describe('complete settings object', () => {
    it('should accept valid complete settings', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {
          enableNotifications: true,
          enableAdvancedFeatures: false,
        },
        ai: {
          features: { search: { provider: null, model: null } },
        },
      });

      expect(result).toEqual({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {
          enableNotifications: true,
          enableAdvancedFeatures: false,
        },
        ai: {
          features: { search: { provider: null, model: null } },
        },
      });
    });
  });
});

describe('PatchSystemSettingsDto (PATCH)', () => {
  describe('ui field', () => {
    it('should make ui field optional', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.ui).toBeUndefined();
    });

    it('should accept ui with allowUserThemeOverride', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: false,
        },
      });

      expect(result.ui?.allowUserThemeOverride).toBe(false);
    });

    it('should make allowUserThemeOverride optional in ui', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {},
      });

      expect(result.ui).toEqual({});
    });
  });

  describe('features field', () => {
    it('should make features field optional', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.features).toBeUndefined();
    });

    it('should accept features with boolean flags', () => {
      const result = patchSystemSettingsSchema.parse({
        features: {
          newFeature: true,
        },
      });

      expect(result.features).toEqual({
        newFeature: true,
      });
    });

    it('should reject features with non-boolean values', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          features: {
            newFeature: 'yes',
          },
        }),
      ).toThrow();
    });
  });

  describe('partial updates', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result).toEqual({});
    });

    it('should accept update with only ui field', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
      });

      expect(result).toEqual({
        ui: {
          allowUserThemeOverride: true,
        },
      });
    });

    it('should accept update with only features field', () => {
      const result = patchSystemSettingsSchema.parse({
        features: {
          beta: true,
        },
      });

      expect(result).toEqual({
        features: {
          beta: true,
        },
      });
    });

    it('should accept combination of partial fields', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: false,
        },
        features: {
          experimental: true,
        },
      });

      expect(result).toEqual({
        ui: {
          allowUserThemeOverride: false,
        },
        features: {
          experimental: true,
        },
      });
    });

    it('should accept partial ai block', () => {
      const result = patchSystemSettingsSchema.parse({
        ai: {
          features: { search: { provider: 'openai', model: 'gpt-4o' } },
        },
      });

      expect(result.ai?.features?.search?.provider).toBe('openai');
      expect(result.ai?.features?.search?.model).toBe('gpt-4o');
    });

    it('should accept empty ai block (all sub-fields optional in patch)', () => {
      const result = patchSystemSettingsSchema.parse({
        ai: {},
      });

      expect(result.ai).toEqual({});
    });
  });
});

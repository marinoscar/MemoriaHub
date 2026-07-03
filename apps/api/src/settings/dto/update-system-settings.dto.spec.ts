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

  // Regression: geo / storage / burst were previously missing from
  // patchSystemSettingsSchema, causing Zod to silently strip them.
  describe('regression: geo, storage, and burst branches are not stripped', () => {
    describe('geo branch', () => {
      it('should preserve geo.forwardSearchEnabled when true', () => {
        const result = patchSystemSettingsSchema.parse({
          geo: { forwardSearchEnabled: true },
        });

        expect(result.geo?.forwardSearchEnabled).toBe(true);
      });

      it('should preserve geo.forwardSearchEnabled when false (disabling survives)', () => {
        const result = patchSystemSettingsSchema.parse({
          geo: { forwardSearchEnabled: false },
        });

        expect(result.geo?.forwardSearchEnabled).toBe(false);
      });

      it('should preserve geo.reverseProvider when set to google', () => {
        const result = patchSystemSettingsSchema.parse({
          geo: { reverseProvider: 'google' },
        });

        expect(result.geo?.reverseProvider).toBe('google');
      });

      it('should preserve geo.reverseProvider when set to offline', () => {
        const result = patchSystemSettingsSchema.parse({
          geo: { reverseProvider: 'offline' },
        });

        expect(result.geo?.reverseProvider).toBe('offline');
      });

      it('should preserve geo.reverseProvider when set to nominatim', () => {
        const result = patchSystemSettingsSchema.parse({
          geo: { reverseProvider: 'nominatim' },
        });

        expect(result.geo?.reverseProvider).toBe('nominatim');
      });

      it('should throw when geo.reverseProvider is an invalid enum value', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            geo: { reverseProvider: 'bogus' },
          }),
        ).toThrow();
      });

      it('should accept empty geo block (all sub-fields optional)', () => {
        const result = patchSystemSettingsSchema.parse({ geo: {} });

        expect(result.geo).toEqual({});
      });
    });

    describe('burst branch', () => {
      it('should preserve all burst fields when valid', () => {
        const result = patchSystemSettingsSchema.parse({
          burst: { timeGapSeconds: 20, hashDistance: 5, minGroupSize: 4 },
        });

        expect(result.burst?.timeGapSeconds).toBe(20);
        expect(result.burst?.hashDistance).toBe(5);
        expect(result.burst?.minGroupSize).toBe(4);
      });

      it('should preserve burst when only timeGapSeconds is supplied', () => {
        const result = patchSystemSettingsSchema.parse({
          burst: { timeGapSeconds: 30 },
        });

        expect(result.burst?.timeGapSeconds).toBe(30);
      });

      it('should throw when burst.hashDistance is above the max (32)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            burst: { hashDistance: 999 },
          }),
        ).toThrow();
      });

      it('should throw when burst.hashDistance is below the min (0)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            burst: { hashDistance: -1 },
          }),
        ).toThrow();
      });

      it('should throw when burst.timeGapSeconds is above the max (300)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            burst: { timeGapSeconds: 301 },
          }),
        ).toThrow();
      });

      it('should throw when burst.minGroupSize is below the min (2)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            burst: { minGroupSize: 1 },
          }),
        ).toThrow();
      });

      it('should throw when burst.minGroupSize is above the max (20)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            burst: { minGroupSize: 21 },
          }),
        ).toThrow();
      });

      it('should accept empty burst block (all sub-fields optional)', () => {
        const result = patchSystemSettingsSchema.parse({ burst: {} });

        expect(result.burst).toEqual({});
      });
    });

    describe('storage branch', () => {
      it('should preserve storage.trash.retentionDays', () => {
        const result = patchSystemSettingsSchema.parse({
          storage: { trash: { retentionDays: 15 } },
        });

        expect(result.storage?.trash?.retentionDays).toBe(15);
      });

      it('should preserve storage.insights.refreshIntervalHours', () => {
        const result = patchSystemSettingsSchema.parse({
          storage: { insights: { refreshIntervalHours: 8 } },
        });

        expect(result.storage?.insights?.refreshIntervalHours).toBe(8);
      });

      it('should preserve storage.activeProvider', () => {
        const result = patchSystemSettingsSchema.parse({
          storage: { activeProvider: 'r2' },
        });

        expect(result.storage?.activeProvider).toBe('r2');
      });

      it('should throw when storage.trash.retentionDays is above the max (365)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            storage: { trash: { retentionDays: 366 } },
          }),
        ).toThrow();
      });

      it('should throw when storage.trash.retentionDays is below the min (1)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            storage: { trash: { retentionDays: 0 } },
          }),
        ).toThrow();
      });

      it('should throw when storage.insights.refreshIntervalHours is above the max (168)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            storage: { insights: { refreshIntervalHours: 169 } },
          }),
        ).toThrow();
      });

      it('should accept empty storage block (all sub-fields optional)', () => {
        const result = patchSystemSettingsSchema.parse({ storage: {} });

        expect(result.storage).toEqual({});
      });
    });

    describe('dedup branch', () => {
      it('should preserve all dedup fields when valid', () => {
        const result = patchSystemSettingsSchema.parse({
          dedup: { similarityThreshold: 0.9, hashMaxDistance: 8, knnCandidates: 30 },
        });

        expect(result.dedup?.similarityThreshold).toBe(0.9);
        expect(result.dedup?.hashMaxDistance).toBe(8);
        expect(result.dedup?.knnCandidates).toBe(30);
      });

      it('should preserve dedup when only similarityThreshold is supplied', () => {
        const result = patchSystemSettingsSchema.parse({
          dedup: { similarityThreshold: 0.92 },
        });

        expect(result.dedup?.similarityThreshold).toBe(0.92);
      });

      it('should throw when dedup.similarityThreshold is above the max (0.995)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            dedup: { similarityThreshold: 0.999 },
          }),
        ).toThrow();
      });

      it('should throw when dedup.similarityThreshold is below the min (0.8)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            dedup: { similarityThreshold: 0.5 },
          }),
        ).toThrow();
      });

      it('should throw when dedup.hashMaxDistance is above the max (16)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            dedup: { hashMaxDistance: 17 },
          }),
        ).toThrow();
      });

      it('should throw when dedup.hashMaxDistance is below the min (0)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            dedup: { hashMaxDistance: -1 },
          }),
        ).toThrow();
      });

      it('should throw when dedup.knnCandidates is above the max (50)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            dedup: { knnCandidates: 51 },
          }),
        ).toThrow();
      });

      it('should throw when dedup.knnCandidates is below the min (5)', () => {
        expect(() =>
          patchSystemSettingsSchema.parse({
            dedup: { knnCandidates: 4 },
          }),
        ).toThrow();
      });

      it('should accept empty dedup block (all sub-fields optional)', () => {
        const result = patchSystemSettingsSchema.parse({ dedup: {} });

        expect(result.dedup).toEqual({});
      });
    });

    describe('features.duplicateDetection flag (via the generic features map)', () => {
      it('should preserve features.duplicateDetection when true', () => {
        const result = patchSystemSettingsSchema.parse({
          features: { duplicateDetection: true },
        });

        expect(result.features?.duplicateDetection).toBe(true);
      });

      it('should preserve features.duplicateDetection when false (disabling survives)', () => {
        const result = patchSystemSettingsSchema.parse({
          features: { duplicateDetection: false },
        });

        expect(result.features?.duplicateDetection).toBe(false);
      });
    });
  });
});

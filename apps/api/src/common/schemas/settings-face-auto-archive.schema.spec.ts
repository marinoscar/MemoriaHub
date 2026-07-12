/**
 * Unit tests for system settings Zod schema — face.autoArchive.matchThreshold
 * and the `faceAutoArchive` feature flag key.
 *
 * Validates:
 *   1. Default value: face.autoArchive = { matchThreshold: 0.45 }
 *   2. Valid complete values parse correctly (boundaries 0.30 / 0.90).
 *   3. Out-of-range matchThreshold (< 0.30 or > 0.90) -> rejected.
 *   4. Patch schema: partial face.autoArchive accepted.
 *   5. Patch schema rejects out-of-range values too.
 *   6. `faceAutoArchive` round-trips through the `features` record on both
 *      the full and patch schemas.
 */

import { systemSettingsSchema, systemSettingsPatchSchema } from './settings.schema';

// ---------------------------------------------------------------------------
// Minimal base for a valid system settings object
// ---------------------------------------------------------------------------

const validBase = {
  ui: { allowUserThemeOverride: true },
  features: { autoTagging: false, faceRecognition: false, burstDetection: false },
  ai: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
      embedding: { provider: null, model: null },
    },
  },
  face: {
    features: { detection: { provider: null, model: null } },
    video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 },
    autoArchive: { matchThreshold: 0.45 },
  },
  storage: {
    activeProvider: 's3',
    insights: { refreshIntervalHours: 4 },
    trash: { retentionDays: 30 },
  },
  burst: { timeGapSeconds: 10, hashDistance: 10, minGroupSize: 3 },
  geo: { reverseProvider: 'offline' as const, forwardSearchEnabled: false },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('systemSettingsSchema — face.autoArchive.matchThreshold', () => {
  // -------------------------------------------------------------------------
  // 1. Defaults
  // -------------------------------------------------------------------------
  describe('defaults', () => {
    it('applies default face.autoArchive = { matchThreshold: 0.45 } when face.autoArchive is omitted', () => {
      const { autoArchive: _autoArchive, ...faceWithoutAutoArchive } = validBase.face;
      const input = { ...validBase, face: faceWithoutAutoArchive };
      const parsed = systemSettingsSchema.parse(input);
      expect(parsed.face?.autoArchive).toEqual({ matchThreshold: 0.45 });
    });

    it('applies the default when the face key is omitted entirely', () => {
      const { face: _face, ...inputWithoutFace } = validBase;
      const parsed = systemSettingsSchema.parse(inputWithoutFace);
      expect(parsed.face?.autoArchive?.matchThreshold).toBe(0.45);
    });

    it('preserves an explicit matchThreshold value', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, autoArchive: { matchThreshold: 0.6 } },
      };
      const parsed = systemSettingsSchema.parse(input);
      expect(parsed.face?.autoArchive).toEqual({ matchThreshold: 0.6 });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Valid boundary values
  // -------------------------------------------------------------------------
  describe('valid values', () => {
    it('accepts the boundary minimum value 0.30', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, autoArchive: { matchThreshold: 0.3 } },
      };
      expect(() => systemSettingsSchema.parse(input)).not.toThrow();
    });

    it('accepts the boundary maximum value 0.90', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, autoArchive: { matchThreshold: 0.9 } },
      };
      expect(() => systemSettingsSchema.parse(input)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Out-of-range values
  // -------------------------------------------------------------------------
  describe('out of range', () => {
    it('rejects matchThreshold below 0.30', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, autoArchive: { matchThreshold: 0.29 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects matchThreshold above 0.90', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, autoArchive: { matchThreshold: 0.91 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects a negative matchThreshold', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, autoArchive: { matchThreshold: -0.1 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Patch schema tests
// ---------------------------------------------------------------------------

describe('systemSettingsPatchSchema — face.autoArchive.matchThreshold', () => {
  it('accepts a partial patch with only matchThreshold', () => {
    const patch = { face: { autoArchive: { matchThreshold: 0.5 } } };
    const parsed = systemSettingsPatchSchema.parse(patch);
    expect(parsed.face?.autoArchive?.matchThreshold).toBe(0.5);
  });

  it('rejects matchThreshold below 0.30 in patch', () => {
    const patch = { face: { autoArchive: { matchThreshold: 0.1 } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).toThrow();
  });

  it('rejects matchThreshold above 0.90 in patch', () => {
    const patch = { face: { autoArchive: { matchThreshold: 0.95 } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).toThrow();
  });

  it('accepts an empty patch object', () => {
    expect(() => systemSettingsPatchSchema.parse({})).not.toThrow();
  });

  it('accepts patch with face: {} (no sub-keys)', () => {
    expect(() => systemSettingsPatchSchema.parse({ face: {} })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// `faceAutoArchive` feature flag key round-trip
// ---------------------------------------------------------------------------

describe('features.faceAutoArchive', () => {
  it('round-trips true through the full systemSettingsSchema', () => {
    const input = { ...validBase, features: { ...validBase.features, faceAutoArchive: true } };
    const parsed = systemSettingsSchema.parse(input);
    expect(parsed.features.faceAutoArchive).toBe(true);
  });

  it('round-trips false through the full systemSettingsSchema', () => {
    const input = { ...validBase, features: { ...validBase.features, faceAutoArchive: false } };
    const parsed = systemSettingsSchema.parse(input);
    expect(parsed.features.faceAutoArchive).toBe(false);
  });

  it('round-trips through systemSettingsPatchSchema', () => {
    const patch = { features: { faceAutoArchive: true } };
    const parsed = systemSettingsPatchSchema.parse(patch);
    expect(parsed.features?.faceAutoArchive).toBe(true);
  });

  it('is omitted (undefined) when not present in features, rather than defaulting to a value', () => {
    // features is z.record(string, boolean) with no per-key default; a
    // consumer relies on FEATURE_KEYS defaults (settings.types.ts), not the
    // Zod schema, for the flag's off-by-default behavior.
    const parsed = systemSettingsSchema.parse(validBase);
    expect(parsed.features.faceAutoArchive).toBeUndefined();
  });
});

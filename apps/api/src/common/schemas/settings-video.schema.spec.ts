/**
 * Unit tests for system settings Zod schema — face.video sub-section.
 *
 * Validates:
 *   1. Default values: face.video = { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 }
 *   2. Valid complete values parse correctly.
 *   3. Out-of-range sampleIntervalSeconds (< 1 or > 60) → rejected.
 *   4. Out-of-range maxFramesPerVideo (< 1 or > 300) → rejected.
 *   5. Non-integer values → rejected.
 *   6. Patch schema: partial face.video (only `enabled` supplied) → accepted.
 *   7. Patch schema: partial face.video (only `sampleIntervalSeconds`) → accepted.
 *   8. Patch schema: partial face.video (only `maxFramesPerVideo`) → accepted.
 *   9. Patch schema rejects out-of-range values too.
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

describe('systemSettingsSchema — face.video', () => {

  // -------------------------------------------------------------------------
  // 1. Defaults
  // -------------------------------------------------------------------------
  describe('defaults', () => {
    it('applies default face.video = { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 } when face.video is omitted', () => {
      const input = { ...validBase, face: { features: { detection: { provider: null, model: null } } } };
      const parsed = systemSettingsSchema.parse(input);
      expect(parsed.face?.video).toEqual({
        enabled: true,
        sampleIntervalSeconds: 5,
        maxFramesPerVideo: 60,
      });
    });

    it('applies default face = { ... } when the face key is omitted entirely', () => {
      const { face: _face, ...inputWithoutFace } = validBase;
      const parsed = systemSettingsSchema.parse(inputWithoutFace);
      expect(parsed.face?.video?.enabled).toBe(true);
      expect(parsed.face?.video?.sampleIntervalSeconds).toBe(5);
      expect(parsed.face?.video?.maxFramesPerVideo).toBe(60);
    });

    it('preserves explicit values when face.video is fully specified', () => {
      const input = {
        ...validBase,
        face: {
          ...validBase.face,
          video: { enabled: false, sampleIntervalSeconds: 10, maxFramesPerVideo: 120 },
        },
      };
      const parsed = systemSettingsSchema.parse(input);
      expect(parsed.face?.video).toEqual({
        enabled: false,
        sampleIntervalSeconds: 10,
        maxFramesPerVideo: 120,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Valid values
  // -------------------------------------------------------------------------
  describe('valid values', () => {
    it('accepts the boundary minimum values (sampleIntervalSeconds=1, maxFramesPerVideo=1)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 1, maxFramesPerVideo: 1 } },
      };
      expect(() => systemSettingsSchema.parse(input)).not.toThrow();
    });

    it('accepts the boundary maximum values (sampleIntervalSeconds=60, maxFramesPerVideo=300)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 60, maxFramesPerVideo: 300 } },
      };
      expect(() => systemSettingsSchema.parse(input)).not.toThrow();
    });

    it('accepts enabled=false', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: false, sampleIntervalSeconds: 5, maxFramesPerVideo: 60 } },
      };
      const parsed = systemSettingsSchema.parse(input);
      expect(parsed.face?.video?.enabled).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. sampleIntervalSeconds out of range
  // -------------------------------------------------------------------------
  describe('sampleIntervalSeconds out of range', () => {
    it('rejects sampleIntervalSeconds = 0 (below min 1)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 0, maxFramesPerVideo: 60 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects sampleIntervalSeconds = 61 (above max 60)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 61, maxFramesPerVideo: 60 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects sampleIntervalSeconds = -1', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: -1, maxFramesPerVideo: 60 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 4. maxFramesPerVideo out of range
  // -------------------------------------------------------------------------
  describe('maxFramesPerVideo out of range', () => {
    it('rejects maxFramesPerVideo = 0 (below min 1)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 0 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects maxFramesPerVideo = 301 (above max 300)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 301 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects maxFramesPerVideo = -5', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: -5 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Non-integer values
  // -------------------------------------------------------------------------
  describe('non-integer values', () => {
    it('rejects sampleIntervalSeconds = 2.5 (not an integer)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 2.5, maxFramesPerVideo: 60 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });

    it('rejects maxFramesPerVideo = 30.7 (not an integer)', () => {
      const input = {
        ...validBase,
        face: { ...validBase.face, video: { enabled: true, sampleIntervalSeconds: 5, maxFramesPerVideo: 30.7 } },
      };
      expect(() => systemSettingsSchema.parse(input)).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Patch schema tests
// ---------------------------------------------------------------------------

describe('systemSettingsPatchSchema — face.video', () => {

  // -------------------------------------------------------------------------
  // 6. Only `enabled` supplied
  // -------------------------------------------------------------------------
  it('accepts patch with only enabled=false in face.video', () => {
    const patch = { face: { video: { enabled: false } } };
    const parsed = systemSettingsPatchSchema.parse(patch);
    expect(parsed.face?.video?.enabled).toBe(false);
  });

  it('accepts patch with only enabled=true in face.video', () => {
    const patch = { face: { video: { enabled: true } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 7. Only sampleIntervalSeconds supplied
  // -------------------------------------------------------------------------
  it('accepts patch with only sampleIntervalSeconds=10', () => {
    const patch = { face: { video: { sampleIntervalSeconds: 10 } } };
    const parsed = systemSettingsPatchSchema.parse(patch);
    expect(parsed.face?.video?.sampleIntervalSeconds).toBe(10);
    expect(parsed.face?.video?.enabled).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. Only maxFramesPerVideo supplied
  // -------------------------------------------------------------------------
  it('accepts patch with only maxFramesPerVideo=120', () => {
    const patch = { face: { video: { maxFramesPerVideo: 120 } } };
    const parsed = systemSettingsPatchSchema.parse(patch);
    expect(parsed.face?.video?.maxFramesPerVideo).toBe(120);
    expect(parsed.face?.video?.enabled).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Patch schema also rejects out-of-range values
  // -------------------------------------------------------------------------
  it('rejects sampleIntervalSeconds=0 in patch', () => {
    const patch = { face: { video: { sampleIntervalSeconds: 0 } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).toThrow();
  });

  it('rejects sampleIntervalSeconds=61 in patch', () => {
    const patch = { face: { video: { sampleIntervalSeconds: 61 } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).toThrow();
  });

  it('rejects maxFramesPerVideo=0 in patch', () => {
    const patch = { face: { video: { maxFramesPerVideo: 0 } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).toThrow();
  });

  it('rejects maxFramesPerVideo=301 in patch', () => {
    const patch = { face: { video: { maxFramesPerVideo: 301 } } };
    expect(() => systemSettingsPatchSchema.parse(patch)).toThrow();
  });

  // -------------------------------------------------------------------------
  // 10. Empty patch object is valid (nothing to update)
  // -------------------------------------------------------------------------
  it('accepts an empty patch object', () => {
    expect(() => systemSettingsPatchSchema.parse({})).not.toThrow();
  });

  it('accepts patch with face: {} (no sub-keys)', () => {
    expect(() => systemSettingsPatchSchema.parse({ face: {} })).not.toThrow();
  });
});

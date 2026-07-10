/**
 * Unit tests for jobs.stuckThresholdMinutes in the settings schema.
 *
 * Tests full (PUT) and partial (PATCH) schemas for the stuck-job threshold
 * setting. Mirrors the style of settings-trash.schema.spec.ts.
 */
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from './settings.schema';

// ---------------------------------------------------------------------------
// Minimal valid full settings for PUT tests
// ---------------------------------------------------------------------------

function makeFullSettings(jobsOverrides: Record<string, unknown> = {}) {
  return {
    ui: { allowUserThemeOverride: true },
    features: {},
    ai: {
      features: {
        search: { provider: null, model: null },
        tagging: { provider: null, model: null },
        embedding: { provider: null, model: null },
      },
    },
    jobs: {
      history: { retentionDays: 30, purgeEnabled: true },
      stuckThresholdMinutes: 3,
      ...jobsOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// systemSettingsSchema (PUT — full replace)
// ---------------------------------------------------------------------------

describe('systemSettingsSchema — jobs.stuckThresholdMinutes', () => {
  it('accepts the default value of 3', () => {
    const result = systemSettingsSchema.parse(makeFullSettings());
    expect(result.jobs?.stuckThresholdMinutes).toBe(3);
  });

  it('accepts the minimum valid value of 1', () => {
    const result = systemSettingsSchema.parse(
      makeFullSettings({ stuckThresholdMinutes: 1 }),
    );
    expect(result.jobs?.stuckThresholdMinutes).toBe(1);
  });

  it('accepts the maximum valid value of 120', () => {
    const result = systemSettingsSchema.parse(
      makeFullSettings({ stuckThresholdMinutes: 120 }),
    );
    expect(result.jobs?.stuckThresholdMinutes).toBe(120);
  });

  it('accepts an arbitrary valid value (45)', () => {
    const result = systemSettingsSchema.parse(
      makeFullSettings({ stuckThresholdMinutes: 45 }),
    );
    expect(result.jobs?.stuckThresholdMinutes).toBe(45);
  });

  it('rejects 0 (below minimum of 1)', () => {
    expect(() =>
      systemSettingsSchema.parse(makeFullSettings({ stuckThresholdMinutes: 0 })),
    ).toThrow();
  });

  it('rejects 121 (above maximum of 120)', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ stuckThresholdMinutes: 121 }),
      ),
    ).toThrow();
  });

  it('rejects negative values', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ stuckThresholdMinutes: -1 }),
      ),
    ).toThrow();
  });

  it('rejects non-integer values', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ stuckThresholdMinutes: 15.5 }),
      ),
    ).toThrow();
  });

  it('rejects string values', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ stuckThresholdMinutes: '15' }),
      ),
    ).toThrow();
  });

  it('applies the default (3) when jobs.stuckThresholdMinutes is omitted (jobs defaults kick in)', () => {
    // When jobs is entirely omitted, the schema should apply its default
    const result = systemSettingsSchema.parse({
      ui: { allowUserThemeOverride: true },
      features: {},
      ai: {
        features: {
          search: { provider: null, model: null },
          tagging: { provider: null, model: null },
          embedding: { provider: null, model: null },
        },
      },
    });
    // The jobs object is optional with a default
    expect(result.jobs?.stuckThresholdMinutes).toBe(3);
  });

  it('applies the default (3) when jobs is present but stuckThresholdMinutes is omitted', () => {
    const result = systemSettingsSchema.parse({
      ui: { allowUserThemeOverride: true },
      features: {},
      ai: {
        features: {
          search: { provider: null, model: null },
          tagging: { provider: null, model: null },
          embedding: { provider: null, model: null },
        },
      },
      jobs: { history: { retentionDays: 30, purgeEnabled: true } },
    });
    expect(result.jobs?.stuckThresholdMinutes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// systemSettingsPatchSchema (PATCH — partial update)
// ---------------------------------------------------------------------------

describe('systemSettingsPatchSchema — jobs.stuckThresholdMinutes', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = systemSettingsPatchSchema.parse({});
    expect(result.jobs).toBeUndefined();
  });

  it('accepts patch with only jobs.stuckThresholdMinutes', () => {
    const result = systemSettingsPatchSchema.parse({
      jobs: { stuckThresholdMinutes: 45 },
    });
    expect(result.jobs?.stuckThresholdMinutes).toBe(45);
  });

  it('accepts patch with stuckThresholdMinutes: 1', () => {
    const result = systemSettingsPatchSchema.parse({
      jobs: { stuckThresholdMinutes: 1 },
    });
    expect(result.jobs?.stuckThresholdMinutes).toBe(1);
  });

  it('accepts patch with stuckThresholdMinutes: 120', () => {
    const result = systemSettingsPatchSchema.parse({
      jobs: { stuckThresholdMinutes: 120 },
    });
    expect(result.jobs?.stuckThresholdMinutes).toBe(120);
  });

  it('rejects stuckThresholdMinutes: 0 in patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        jobs: { stuckThresholdMinutes: 0 },
      }),
    ).toThrow();
  });

  it('rejects stuckThresholdMinutes: 121 in patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        jobs: { stuckThresholdMinutes: 121 },
      }),
    ).toThrow();
  });

  it('allows stuckThresholdMinutes to be omitted (optional in patch)', () => {
    const result = systemSettingsPatchSchema.parse({
      jobs: {},
    });
    expect(result.jobs?.stuckThresholdMinutes).toBeUndefined();
  });

  it('allows patching only jobs.history without touching stuckThresholdMinutes', () => {
    const result = systemSettingsPatchSchema.parse({
      jobs: { history: { retentionDays: 7 } },
    });
    expect(result.jobs?.history?.retentionDays).toBe(7);
    expect(result.jobs?.stuckThresholdMinutes).toBeUndefined();
  });

  it('allows patching stuckThresholdMinutes and history together', () => {
    const result = systemSettingsPatchSchema.parse({
      jobs: {
        history: { retentionDays: 14, purgeEnabled: false },
        stuckThresholdMinutes: 10,
      },
    });
    expect(result.jobs?.history?.retentionDays).toBe(14);
    expect(result.jobs?.history?.purgeEnabled).toBe(false);
    expect(result.jobs?.stuckThresholdMinutes).toBe(10);
  });
});

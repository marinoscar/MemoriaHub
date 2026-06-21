/**
 * Unit tests for storage.trash.retentionDays in the settings schema.
 *
 * Tests full (PUT) and partial (PATCH) schemas for the new trash retention setting.
 * Mirrors the style of update-system-settings.dto.spec.ts.
 */
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from './settings.schema';

// ---------------------------------------------------------------------------
// Minimal valid full settings for PUT tests
// ---------------------------------------------------------------------------

function makeFullSettings(storageOverrides: Record<string, unknown> = {}) {
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
    storage: {
      insights: { refreshIntervalHours: 4 },
      trash: { retentionDays: 30 },
      ...storageOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// systemSettingsSchema (PUT — full replace)
// ---------------------------------------------------------------------------

describe('systemSettingsSchema — storage.trash.retentionDays', () => {
  it('accepts the default value of 30', () => {
    const result = systemSettingsSchema.parse(makeFullSettings());
    expect(result.storage?.trash?.retentionDays).toBe(30);
  });

  it('accepts the minimum valid value of 1', () => {
    const result = systemSettingsSchema.parse(
      makeFullSettings({ trash: { retentionDays: 1 } }),
    );
    expect(result.storage?.trash?.retentionDays).toBe(1);
  });

  it('accepts the maximum valid value of 365', () => {
    const result = systemSettingsSchema.parse(
      makeFullSettings({ trash: { retentionDays: 365 } }),
    );
    expect(result.storage?.trash?.retentionDays).toBe(365);
  });

  it('accepts an arbitrary valid value (30)', () => {
    const result = systemSettingsSchema.parse(
      makeFullSettings({ trash: { retentionDays: 30 } }),
    );
    expect(result.storage?.trash?.retentionDays).toBe(30);
  });

  it('rejects 0 (below minimum of 1)', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ trash: { retentionDays: 0 } }),
      ),
    ).toThrow();
  });

  it('rejects 366 (above maximum of 365)', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ trash: { retentionDays: 366 } }),
      ),
    ).toThrow();
  });

  it('rejects negative values', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ trash: { retentionDays: -1 } }),
      ),
    ).toThrow();
  });

  it('rejects non-integer values', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ trash: { retentionDays: 30.5 } }),
      ),
    ).toThrow();
  });

  it('rejects string values', () => {
    expect(() =>
      systemSettingsSchema.parse(
        makeFullSettings({ trash: { retentionDays: '30' } }),
      ),
    ).toThrow();
  });

  it('applies the default (30) when storage.trash is omitted (storage defaults kick in)', () => {
    // When storage is entirely omitted, the schema should apply its default
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
    // The storage object is optional with a default
    expect(result.storage?.trash?.retentionDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// systemSettingsPatchSchema (PATCH — partial update)
// ---------------------------------------------------------------------------

describe('systemSettingsPatchSchema — storage.trash.retentionDays', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = systemSettingsPatchSchema.parse({});
    expect(result.storage).toBeUndefined();
  });

  it('accepts patch with only storage.trash.retentionDays', () => {
    const result = systemSettingsPatchSchema.parse({
      storage: { trash: { retentionDays: 14 } },
    });
    expect(result.storage?.trash?.retentionDays).toBe(14);
  });

  it('accepts patch with retentionDays: 1', () => {
    const result = systemSettingsPatchSchema.parse({
      storage: { trash: { retentionDays: 1 } },
    });
    expect(result.storage?.trash?.retentionDays).toBe(1);
  });

  it('accepts patch with retentionDays: 365', () => {
    const result = systemSettingsPatchSchema.parse({
      storage: { trash: { retentionDays: 365 } },
    });
    expect(result.storage?.trash?.retentionDays).toBe(365);
  });

  it('rejects retentionDays: 0 in patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        storage: { trash: { retentionDays: 0 } },
      }),
    ).toThrow();
  });

  it('rejects retentionDays: 366 in patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        storage: { trash: { retentionDays: 366 } },
      }),
    ).toThrow();
  });

  it('allows retentionDays to be omitted (optional in patch)', () => {
    const result = systemSettingsPatchSchema.parse({
      storage: { trash: {} },
    });
    expect(result.storage?.trash?.retentionDays).toBeUndefined();
  });

  it('allows patching only insights without touching trash', () => {
    const result = systemSettingsPatchSchema.parse({
      storage: { insights: { refreshIntervalHours: 8 } },
    });
    expect(result.storage?.insights?.refreshIntervalHours).toBe(8);
    expect(result.storage?.trash).toBeUndefined();
  });
});

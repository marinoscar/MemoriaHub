/**
 * Unit tests for the `databaseBackup` namespace in the settings schema
 * (epic #339, issue #340).
 *
 * Tests full (PUT) and partial (PATCH) schemas. Mirrors the style of
 * settings-jobs-stuck-threshold.schema.spec.ts.
 */
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from './settings.schema';

// ---------------------------------------------------------------------------
// Minimal valid full settings for PUT tests
// ---------------------------------------------------------------------------

function makeFullSettings(databaseBackupOverrides: Record<string, unknown> = {}) {
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
    databaseBackup: {
      enabled: false,
      frequency: 'daily',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      timezone: 'UTC',
      retentionCount: 7,
      storageProvider: null,
      runStaleMinutes: 30,
      compressionLevel: 1,
      restoreRollbackMode: 'retain_database',
      oldDatabaseRetentionHours: 168,
      ...databaseBackupOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// systemSettingsSchema (PUT — full replace)
// ---------------------------------------------------------------------------

describe('systemSettingsSchema — databaseBackup', () => {
  it('accepts the default values', () => {
    const result = systemSettingsSchema.parse(makeFullSettings());
    expect(result.databaseBackup).toEqual({
      enabled: false,
      frequency: 'daily',
      dayOfWeek: 0,
      dayOfMonth: 1,
      timeOfDay: '02:00',
      timezone: 'UTC',
      retentionCount: 7,
      storageProvider: null,
      runStaleMinutes: 30,
      compressionLevel: 1,
      restoreRollbackMode: 'retain_database',
      oldDatabaseRetentionHours: 168,
    });
  });

  it('applies the full default namespace when databaseBackup is omitted', () => {
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
    expect(result.databaseBackup?.enabled).toBe(false);
    expect(result.databaseBackup?.frequency).toBe('daily');
    expect(result.databaseBackup?.retentionCount).toBe(7);
    expect(result.databaseBackup?.storageProvider).toBeNull();
  });

  it('accepts enabled: true', () => {
    const result = systemSettingsSchema.parse(makeFullSettings({ enabled: true }));
    expect(result.databaseBackup?.enabled).toBe(true);
  });

  describe('frequency', () => {
    it.each(['daily', 'weekly', 'monthly'])('accepts %s', (frequency) => {
      const result = systemSettingsSchema.parse(makeFullSettings({ frequency }));
      expect(result.databaseBackup?.frequency).toBe(frequency);
    });

    it('rejects an unknown frequency', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ frequency: 'hourly' })),
      ).toThrow();
    });
  });

  describe('dayOfWeek (0-6)', () => {
    it('accepts the minimum valid value of 0', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ dayOfWeek: 0 }));
      expect(result.databaseBackup?.dayOfWeek).toBe(0);
    });

    it('accepts the maximum valid value of 6', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ dayOfWeek: 6 }));
      expect(result.databaseBackup?.dayOfWeek).toBe(6);
    });

    it('rejects -1 (below minimum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ dayOfWeek: -1 })),
      ).toThrow();
    });

    it('rejects 7 (above maximum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ dayOfWeek: 7 })),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ dayOfWeek: 2.5 })),
      ).toThrow();
    });
  });

  describe('dayOfMonth (1-28)', () => {
    it('accepts the minimum valid value of 1', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ dayOfMonth: 1 }));
      expect(result.databaseBackup?.dayOfMonth).toBe(1);
    });

    it('accepts the maximum valid value of 28', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ dayOfMonth: 28 }));
      expect(result.databaseBackup?.dayOfMonth).toBe(28);
    });

    it('rejects 0 (below minimum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ dayOfMonth: 0 })),
      ).toThrow();
    });

    it('rejects 29 (above maximum — no month guarantees a 29th day)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ dayOfMonth: 29 })),
      ).toThrow();
    });
  });

  describe('timeOfDay ("HH:mm")', () => {
    it('accepts the default 02:00', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ timeOfDay: '02:00' }));
      expect(result.databaseBackup?.timeOfDay).toBe('02:00');
    });

    it('accepts 00:00 and 23:59 (boundary times)', () => {
      expect(
        systemSettingsSchema.parse(makeFullSettings({ timeOfDay: '00:00' })).databaseBackup
          ?.timeOfDay,
      ).toBe('00:00');
      expect(
        systemSettingsSchema.parse(makeFullSettings({ timeOfDay: '23:59' })).databaseBackup
          ?.timeOfDay,
      ).toBe('23:59');
    });

    it('rejects an out-of-range hour', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ timeOfDay: '24:00' })),
      ).toThrow();
    });

    it('rejects an out-of-range minute', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ timeOfDay: '10:60' })),
      ).toThrow();
    });

    it('rejects a malformed string', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ timeOfDay: '2am' })),
      ).toThrow();
    });
  });

  describe('timezone', () => {
    it('accepts an IANA timezone string', () => {
      const result = systemSettingsSchema.parse(
        makeFullSettings({ timezone: 'America/Costa_Rica' }),
      );
      expect(result.databaseBackup?.timezone).toBe('America/Costa_Rica');
    });

    it('rejects an empty string', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ timezone: '' })),
      ).toThrow();
    });
  });

  describe('retentionCount (1-100)', () => {
    it('accepts the minimum valid value of 1', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ retentionCount: 1 }));
      expect(result.databaseBackup?.retentionCount).toBe(1);
    });

    it('accepts the maximum valid value of 100', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ retentionCount: 100 }));
      expect(result.databaseBackup?.retentionCount).toBe(100);
    });

    it('rejects 0 (below minimum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ retentionCount: 0 })),
      ).toThrow();
    });

    it('rejects 101 (above maximum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ retentionCount: 101 })),
      ).toThrow();
    });
  });

  describe('storageProvider (nullable)', () => {
    it('accepts null (use the active storage provider)', () => {
      const result = systemSettingsSchema.parse(
        makeFullSettings({ storageProvider: null }),
      );
      expect(result.databaseBackup?.storageProvider).toBeNull();
    });

    it('accepts a provider key string', () => {
      const result = systemSettingsSchema.parse(
        makeFullSettings({ storageProvider: 's3' }),
      );
      expect(result.databaseBackup?.storageProvider).toBe('s3');
    });
  });

  describe('runStaleMinutes (5-240)', () => {
    it('accepts the minimum valid value of 5', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ runStaleMinutes: 5 }));
      expect(result.databaseBackup?.runStaleMinutes).toBe(5);
    });

    it('accepts the maximum valid value of 240', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ runStaleMinutes: 240 }));
      expect(result.databaseBackup?.runStaleMinutes).toBe(240);
    });

    it('rejects 4 (below minimum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ runStaleMinutes: 4 })),
      ).toThrow();
    });

    it('rejects 241 (above maximum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ runStaleMinutes: 241 })),
      ).toThrow();
    });
  });

  describe('compressionLevel (0-9)', () => {
    it('accepts the minimum valid value of 0', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ compressionLevel: 0 }));
      expect(result.databaseBackup?.compressionLevel).toBe(0);
    });

    it('accepts the maximum valid value of 9', () => {
      const result = systemSettingsSchema.parse(makeFullSettings({ compressionLevel: 9 }));
      expect(result.databaseBackup?.compressionLevel).toBe(9);
    });

    it('rejects -1 (below minimum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ compressionLevel: -1 })),
      ).toThrow();
    });

    it('rejects 10 (above maximum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ compressionLevel: 10 })),
      ).toThrow();
    });
  });

  describe('restoreRollbackMode', () => {
    it.each(['retain_database', 'pre_restore_dump'])('accepts %s', (mode) => {
      const result = systemSettingsSchema.parse(
        makeFullSettings({ restoreRollbackMode: mode }),
      );
      expect(result.databaseBackup?.restoreRollbackMode).toBe(mode);
    });

    it('rejects an unknown mode', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ restoreRollbackMode: 'discard' })),
      ).toThrow();
    });
  });

  describe('oldDatabaseRetentionHours (1-720)', () => {
    it('accepts the minimum valid value of 1', () => {
      const result = systemSettingsSchema.parse(
        makeFullSettings({ oldDatabaseRetentionHours: 1 }),
      );
      expect(result.databaseBackup?.oldDatabaseRetentionHours).toBe(1);
    });

    it('accepts the maximum valid value of 720', () => {
      const result = systemSettingsSchema.parse(
        makeFullSettings({ oldDatabaseRetentionHours: 720 }),
      );
      expect(result.databaseBackup?.oldDatabaseRetentionHours).toBe(720);
    });

    it('rejects 0 (below minimum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ oldDatabaseRetentionHours: 0 })),
      ).toThrow();
    });

    it('rejects 721 (above maximum)', () => {
      expect(() =>
        systemSettingsSchema.parse(makeFullSettings({ oldDatabaseRetentionHours: 721 })),
      ).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// systemSettingsPatchSchema (PATCH — partial update)
// ---------------------------------------------------------------------------

describe('systemSettingsPatchSchema — databaseBackup', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = systemSettingsPatchSchema.parse({});
    expect(result.databaseBackup).toBeUndefined();
  });

  it('accepts patch with only databaseBackup.enabled', () => {
    const result = systemSettingsPatchSchema.parse({
      databaseBackup: { enabled: true },
    });
    expect(result.databaseBackup?.enabled).toBe(true);
    expect(result.databaseBackup?.frequency).toBeUndefined();
  });

  it('accepts an empty databaseBackup object (no-op patch)', () => {
    const result = systemSettingsPatchSchema.parse({ databaseBackup: {} });
    expect(result.databaseBackup).toEqual({});
  });

  it('accepts patching multiple fields together', () => {
    const result = systemSettingsPatchSchema.parse({
      databaseBackup: {
        enabled: true,
        frequency: 'weekly',
        dayOfWeek: 3,
        timeOfDay: '03:30',
        retentionCount: 14,
      },
    });
    expect(result.databaseBackup).toEqual({
      enabled: true,
      frequency: 'weekly',
      dayOfWeek: 3,
      timeOfDay: '03:30',
      retentionCount: 14,
    });
  });

  it('accepts storageProvider: null explicitly', () => {
    const result = systemSettingsPatchSchema.parse({
      databaseBackup: { storageProvider: null },
    });
    expect(result.databaseBackup?.storageProvider).toBeNull();
  });

  it('accepts storageProvider as a string', () => {
    const result = systemSettingsPatchSchema.parse({
      databaseBackup: { storageProvider: 'r2' },
    });
    expect(result.databaseBackup?.storageProvider).toBe('r2');
  });

  it('rejects an out-of-range field in a partial patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        databaseBackup: { dayOfMonth: 29 },
      }),
    ).toThrow();
  });

  it('rejects an invalid enum value in a partial patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        databaseBackup: { restoreRollbackMode: 'nope' },
      }),
    ).toThrow();
  });

  it('rejects a malformed timeOfDay in a partial patch', () => {
    expect(() =>
      systemSettingsPatchSchema.parse({
        databaseBackup: { timeOfDay: '9:00' },
      }),
    ).toThrow();
  });
});

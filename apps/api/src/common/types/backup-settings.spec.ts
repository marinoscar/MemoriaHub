/**
 * Unit tests for the `backup.*` system-settings namespace (issue #310, epic
 * #308 — Local Media Backup via Worker Nodes). Read by NodeBackupQueryService
 * via the cached SystemSettingsService.getSettings() call. Mirrors the
 * pattern established by workflows-settings.spec.ts.
 */
import { DEFAULT_SYSTEM_SETTINGS } from './settings.types';
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from '../schemas/settings.schema';

describe('backup system settings', () => {
  describe('DEFAULT_SYSTEM_SETTINGS.backup', () => {
    it('matches the documented defaults', () => {
      expect(DEFAULT_SYSTEM_SETTINGS.backup).toEqual({
        maxPageSize: 200,
        feedSafetyHorizonSeconds: 5,
        runStaleMinutes: 15,
      });
    });

    it('parses cleanly against the Zod systemSettingsSchema (schema/defaults agree)', () => {
      const parsed = systemSettingsSchema.parse(DEFAULT_SYSTEM_SETTINGS);
      expect(parsed.backup).toEqual(DEFAULT_SYSTEM_SETTINGS.backup);
    });

    it('applies the schema default when the backup block is omitted entirely', () => {
      const { backup, ...rest } = DEFAULT_SYSTEM_SETTINGS as any;
      const parsed = systemSettingsSchema.parse(rest);
      expect(parsed.backup).toEqual(DEFAULT_SYSTEM_SETTINGS.backup);
    });
  });

  // ---------------------------------------------------------------------------
  // systemSettingsSchema (PUT — full replace)
  // ---------------------------------------------------------------------------

  describe('systemSettingsSchema bounds (Zod, PUT)', () => {
    it('accepts values at the documented min/max bounds', () => {
      const parsed = systemSettingsSchema.parse({
        ...DEFAULT_SYSTEM_SETTINGS,
        backup: {
          maxPageSize: 50, // min
          feedSafetyHorizonSeconds: 0, // min
          runStaleMinutes: 5, // min
        },
      });
      expect(parsed.backup).toEqual({
        maxPageSize: 50,
        feedSafetyHorizonSeconds: 0,
        runStaleMinutes: 5,
      });

      const parsedMax = systemSettingsSchema.parse({
        ...DEFAULT_SYSTEM_SETTINGS,
        backup: {
          maxPageSize: 500, // max
          feedSafetyHorizonSeconds: 60, // max
          runStaleMinutes: 120, // max
        },
      });
      expect(parsedMax.backup).toEqual({
        maxPageSize: 500,
        feedSafetyHorizonSeconds: 60,
        runStaleMinutes: 120,
      });
    });

    it('rejects maxPageSize below the min (49 < 50)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, maxPageSize: 49 },
        }),
      ).toThrow();
    });

    it('rejects maxPageSize above the max (501 > 500)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, maxPageSize: 501 },
        }),
      ).toThrow();
    });

    it('rejects feedSafetyHorizonSeconds below the min (-1 < 0)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, feedSafetyHorizonSeconds: -1 },
        }),
      ).toThrow();
    });

    it('rejects feedSafetyHorizonSeconds above the max (61 > 60)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, feedSafetyHorizonSeconds: 61 },
        }),
      ).toThrow();
    });

    it('rejects runStaleMinutes below the min (4 < 5)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, runStaleMinutes: 4 },
        }),
      ).toThrow();
    });

    it('rejects runStaleMinutes above the max (121 > 120)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, runStaleMinutes: 121 },
        }),
      ).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, maxPageSize: 200.5 },
        }),
      ).toThrow();
    });

    it('rejects string values', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          backup: { ...DEFAULT_SYSTEM_SETTINGS.backup, maxPageSize: '200' },
        }),
      ).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // systemSettingsPatchSchema (PATCH — partial update)
  // ---------------------------------------------------------------------------

  describe('systemSettingsPatchSchema (PATCH)', () => {
    it('accepts an empty object (all fields optional)', () => {
      const result = systemSettingsPatchSchema.parse({});
      expect(result.backup).toBeUndefined();
    });

    it('accepts a patch with only maxPageSize', () => {
      const result = systemSettingsPatchSchema.parse({
        backup: { maxPageSize: 300 },
      });
      expect(result.backup).toEqual({ maxPageSize: 300 });
    });

    it('accepts a patch with all three fields at their bounds', () => {
      const result = systemSettingsPatchSchema.parse({
        backup: { maxPageSize: 50, feedSafetyHorizonSeconds: 0, runStaleMinutes: 5 },
      });
      expect(result.backup).toEqual({
        maxPageSize: 50,
        feedSafetyHorizonSeconds: 0,
        runStaleMinutes: 5,
      });
    });

    it('allows any single field to be omitted (independently optional)', () => {
      const result = systemSettingsPatchSchema.parse({
        backup: { runStaleMinutes: 30 },
      });
      expect(result.backup).toEqual({ runStaleMinutes: 30 });
    });

    it('rejects maxPageSize 49 in a patch', () => {
      expect(() =>
        systemSettingsPatchSchema.parse({ backup: { maxPageSize: 49 } }),
      ).toThrow();
    });

    it('rejects maxPageSize 501 in a patch', () => {
      expect(() =>
        systemSettingsPatchSchema.parse({ backup: { maxPageSize: 501 } }),
      ).toThrow();
    });

    it('rejects feedSafetyHorizonSeconds -1 in a patch', () => {
      expect(() =>
        systemSettingsPatchSchema.parse({ backup: { feedSafetyHorizonSeconds: -1 } }),
      ).toThrow();
    });

    it('rejects feedSafetyHorizonSeconds 61 in a patch', () => {
      expect(() =>
        systemSettingsPatchSchema.parse({ backup: { feedSafetyHorizonSeconds: 61 } }),
      ).toThrow();
    });

    it('rejects runStaleMinutes 4 in a patch', () => {
      expect(() =>
        systemSettingsPatchSchema.parse({ backup: { runStaleMinutes: 4 } }),
      ).toThrow();
    });

    it('rejects runStaleMinutes 121 in a patch', () => {
      expect(() =>
        systemSettingsPatchSchema.parse({ backup: { runStaleMinutes: 121 } }),
      ).toThrow();
    });

    it('leaves other namespaces untouched when patching only backup', () => {
      const result = systemSettingsPatchSchema.parse({
        backup: { maxPageSize: 250 },
      });
      expect(result.storage).toBeUndefined();
      expect(result.workflows).toBeUndefined();
    });
  });
});

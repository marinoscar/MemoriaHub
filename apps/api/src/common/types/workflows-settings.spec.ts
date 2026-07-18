/**
 * Unit tests for the `workflows.*` system-settings namespace and the
 * `isWorkflowsEnabled` feature-gate helper (issue #139). The full namespace
 * ships in Phase 1 so later phases (#140-#144) read it via
 * SystemSettingsService.getSettings() with no further schema change.
 */
import {
  DEFAULT_SYSTEM_SETTINGS,
  FEATURE_KEYS,
  isWorkflowsEnabled,
} from './settings.types';
import { systemSettingsSchema } from '../schemas/settings.schema';

describe('workflows system settings', () => {
  describe('DEFAULT_SYSTEM_SETTINGS.workflows', () => {
    it('matches the documented Phase-1 defaults', () => {
      expect(DEFAULT_SYSTEM_SETTINGS.workflows).toEqual({
        maxItemsPerRun: 10000,
        batchSize: 200,
        maxConcurrentRuns: 2,
        requirePreview: true,
        allowHardDelete: false,
        maxWorkflowsPerCircle: 20,
        previewTtlHours: 24,
        runHistoryRetentionDays: 30,
        triggers: {
          onEnrichment: true,
          scheduled: true,
        },
        scheduleMinIntervalMinutes: 60,
      });
    });

    it('defaults features.workflows to false', () => {
      expect(DEFAULT_SYSTEM_SETTINGS.features[FEATURE_KEYS.WORKFLOWS]).toBe(false);
    });

    it('FEATURE_KEYS.WORKFLOWS is the string "workflows"', () => {
      expect(FEATURE_KEYS.WORKFLOWS).toBe('workflows');
    });

    it('parses cleanly against the Zod systemSettingsSchema (schema/defaults agree)', () => {
      const parsed = systemSettingsSchema.parse(DEFAULT_SYSTEM_SETTINGS);
      expect(parsed.workflows).toEqual(DEFAULT_SYSTEM_SETTINGS.workflows);
    });
  });

  describe('workflows schema bounds (Zod)', () => {
    it('accepts values at the documented min/max bounds', () => {
      const parsed = systemSettingsSchema.parse({
        ...DEFAULT_SYSTEM_SETTINGS,
        workflows: {
          maxItemsPerRun: 100, // min
          batchSize: 1000, // max
          maxConcurrentRuns: 10, // max
          requirePreview: false,
          allowHardDelete: true,
          maxWorkflowsPerCircle: 100, // max
          previewTtlHours: 168, // max
          runHistoryRetentionDays: 1, // min
          triggers: { onEnrichment: false, scheduled: false },
          scheduleMinIntervalMinutes: 10080, // max
        },
      });
      expect(parsed.workflows.maxItemsPerRun).toBe(100);
      expect(parsed.workflows.scheduleMinIntervalMinutes).toBe(10080);
    });

    it('rejects maxItemsPerRun below the min (100)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, maxItemsPerRun: 99 },
        }),
      ).toThrow();
    });

    it('rejects maxWorkflowsPerCircle above the max (100)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, maxWorkflowsPerCircle: 101 },
        }),
      ).toThrow();
    });

    it('rejects scheduleMinIntervalMinutes below the min (60)', () => {
      expect(() =>
        systemSettingsSchema.parse({
          ...DEFAULT_SYSTEM_SETTINGS,
          workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, scheduleMinIntervalMinutes: 59 },
        }),
      ).toThrow();
    });

    it('applies the schema default when the workflows block is omitted entirely', () => {
      const { workflows, ...rest } = DEFAULT_SYSTEM_SETTINGS as any;
      const parsed = systemSettingsSchema.parse(rest);
      expect(parsed.workflows).toEqual(DEFAULT_SYSTEM_SETTINGS.workflows);
    });
  });

  describe('isWorkflowsEnabled', () => {
    const originalEnv = process.env['WORKFLOWS_ENABLED'];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env['WORKFLOWS_ENABLED'];
      } else {
        process.env['WORKFLOWS_ENABLED'] = originalEnv;
      }
    });

    it('is false when features.workflows is false', () => {
      delete process.env['WORKFLOWS_ENABLED'];
      expect(isWorkflowsEnabled({ features: { workflows: false } })).toBe(false);
    });

    it('is false when features.workflows is absent', () => {
      delete process.env['WORKFLOWS_ENABLED'];
      expect(isWorkflowsEnabled({ features: {} })).toBe(false);
    });

    it('is false when features is entirely absent', () => {
      delete process.env['WORKFLOWS_ENABLED'];
      expect(isWorkflowsEnabled({})).toBe(false);
    });

    it('is true when features.workflows is true and no env override is set', () => {
      delete process.env['WORKFLOWS_ENABLED'];
      expect(isWorkflowsEnabled({ features: { workflows: true } })).toBe(true);
    });

    it('the WORKFLOWS_ENABLED=false env kill-switch overrides an enabled feature flag', () => {
      process.env['WORKFLOWS_ENABLED'] = 'false';
      expect(isWorkflowsEnabled({ features: { workflows: true } })).toBe(false);
    });

    it('any other WORKFLOWS_ENABLED value does not disable the feature', () => {
      process.env['WORKFLOWS_ENABLED'] = 'true';
      expect(isWorkflowsEnabled({ features: { workflows: true } })).toBe(true);

      process.env['WORKFLOWS_ENABLED'] = 'garbage';
      expect(isWorkflowsEnabled({ features: { workflows: true } })).toBe(true);
    });

    it('the env kill-switch has no effect when the feature flag is already false', () => {
      process.env['WORKFLOWS_ENABLED'] = 'false';
      expect(isWorkflowsEnabled({ features: { workflows: false } })).toBe(false);
    });
  });
});

/**
 * Notification channel settings (epic #481, issue #484):
 *   - system `notifications.{browserEnabled,pushEnabled,disabledTypes}`
 *   - user `notifications.push.{enabled,types}` (absent ⇒ enabled, no defaults)
 */
import {
  notificationPreferencesPatchSchema,
  notificationPreferencesSchema,
  systemSettingsPatchSchema,
  systemSettingsSchema,
} from './settings.schema';

const BASE = {
  ui: { allowUserThemeOverride: true },
  features: {},
  ai: {
    features: {
      search: { provider: null, model: null },
      tagging: { provider: null, model: null },
      embedding: { provider: null, model: null },
    },
  },
};

describe('system notifications channel switches', () => {
  it('defaults browserEnabled/pushEnabled to true and disabledTypes to [] when absent', () => {
    const parsed = systemSettingsSchema.parse(BASE);
    expect(parsed.notifications).toEqual({
      retentionDays: 30,
      purgeEnabled: true,
      browserEnabled: true,
      pushEnabled: true,
      disabledTypes: [],
    });
  });

  it('fills the new switches for a stored namespace that predates them', () => {
    const parsed = systemSettingsSchema.parse({
      ...BASE,
      notifications: { retentionDays: 5, purgeEnabled: false },
    });
    expect(parsed.notifications).toMatchObject({
      retentionDays: 5,
      browserEnabled: true,
      pushEnabled: true,
      disabledTypes: [],
    });
  });

  it('round-trips explicit values', () => {
    const value = {
      retentionDays: 7,
      purgeEnabled: true,
      browserEnabled: false,
      pushEnabled: false,
      disabledTypes: ['upload_completed', 'enrichment_failed'],
    };
    const parsed = systemSettingsSchema.parse({
      ...BASE,
      notifications: value,
    });
    expect(parsed.notifications).toEqual(value);
  });

  it('rejects unknown types and more than 50 entries', () => {
    expect(
      systemSettingsPatchSchema.safeParse({ notifications: { disabledTypes: ['bogus'] } }).success,
    ).toBe(false);
    expect(
      systemSettingsPatchSchema.safeParse({
        notifications: { disabledTypes: Array(51).fill('upload_completed') },
      }).success,
    ).toBe(false);
  });

  it('PATCH schema adds no defaults', () => {
    const parsed = systemSettingsPatchSchema.parse({ notifications: { pushEnabled: false } });
    expect(parsed.notifications).toEqual({ pushEnabled: false });
  });
});

describe('user notifications.push preferences', () => {
  it('is optional and injects nothing when absent', () => {
    expect(notificationPreferencesSchema.parse({})).toEqual({});
    expect(notificationPreferencesSchema.parse({ push: {} })).toEqual({ push: {} });
  });

  it('accepts a partial per-type map and rejects unknown keys/types', () => {
    expect(
      notificationPreferencesSchema.safeParse({ push: { types: { upload_completed: false } } })
        .success,
    ).toBe(true);
    expect(notificationPreferencesSchema.safeParse({ push: { types: { nope: false } } }).success).toBe(
      false,
    );
    expect(notificationPreferencesSchema.safeParse({ push: { extra: true } }).success).toBe(false);
  });

  it('PATCH accepts null to delete a type, the switch, or the whole sub-namespace', () => {
    expect(
      notificationPreferencesPatchSchema.safeParse({ push: { types: { upload_completed: null } } })
        .success,
    ).toBe(true);
    expect(notificationPreferencesPatchSchema.safeParse({ push: { enabled: null } }).success).toBe(true);
    expect(notificationPreferencesPatchSchema.safeParse({ push: null }).success).toBe(true);
    // PUT (stored shape) never accepts nulls
    expect(notificationPreferencesSchema.safeParse({ push: null }).success).toBe(false);
  });
});

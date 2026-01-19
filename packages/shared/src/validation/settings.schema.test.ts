/**
 * Tests for settings validation schemas
 */

import { describe, it, expect } from 'vitest';
import {
  smtpSettingsSchema,
  userPreferencesInputSchema,
  uiPreferencesSchema,
  privacyPreferencesSchema,
  emailNotificationPreferencesSchema,
  systemSettingsCategorySchema,
} from './settings.schema';

describe('Settings Validation Schemas', () => {
  describe('systemSettingsCategorySchema', () => {
    it('accepts valid categories', () => {
      expect(systemSettingsCategorySchema.parse('smtp')).toBe('smtp');
      expect(systemSettingsCategorySchema.parse('push')).toBe('push');
      expect(systemSettingsCategorySchema.parse('storage')).toBe('storage');
      expect(systemSettingsCategorySchema.parse('features')).toBe('features');
      expect(systemSettingsCategorySchema.parse('general')).toBe('general');
    });

    it('rejects invalid categories', () => {
      expect(() => systemSettingsCategorySchema.parse('invalid')).toThrow();
      expect(() => systemSettingsCategorySchema.parse('')).toThrow();
      expect(() => systemSettingsCategorySchema.parse(123)).toThrow();
    });
  });

  describe('smtpSettingsSchema', () => {
    it('accepts valid SMTP settings', () => {
      const result = smtpSettingsSchema.parse({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        secure: true,
      });

      expect(result.enabled).toBe(true);
      expect(result.host).toBe('smtp.example.com');
      expect(result.port).toBe(587);
    });

    it('accepts partial SMTP settings', () => {
      const result = smtpSettingsSchema.parse({
        enabled: false,
      });

      expect(result.enabled).toBe(false);
      expect(result.host).toBeUndefined();
    });

    it('rejects invalid port numbers', () => {
      expect(() =>
        smtpSettingsSchema.parse({
          port: 0, // Too low
        })
      ).toThrow();

      expect(() =>
        smtpSettingsSchema.parse({
          port: 70000, // Too high
        })
      ).toThrow();
    });

    it('rejects invalid email addresses', () => {
      expect(() =>
        smtpSettingsSchema.parse({
          fromAddress: 'not-an-email',
        })
      ).toThrow();
    });

    it('accepts empty string for fromAddress', () => {
      const result = smtpSettingsSchema.parse({
        fromAddress: '',
      });
      expect(result.fromAddress).toBe('');
    });
  });

  describe('uiPreferencesSchema', () => {
    it('accepts valid theme values', () => {
      expect(uiPreferencesSchema.parse({ theme: 'dark' }).theme).toBe('dark');
      expect(uiPreferencesSchema.parse({ theme: 'light' }).theme).toBe('light');
      expect(uiPreferencesSchema.parse({ theme: 'system' }).theme).toBe('system');
    });

    it('accepts valid grid size values', () => {
      expect(uiPreferencesSchema.parse({ gridSize: 'small' }).gridSize).toBe('small');
      expect(uiPreferencesSchema.parse({ gridSize: 'medium' }).gridSize).toBe('medium');
      expect(uiPreferencesSchema.parse({ gridSize: 'large' }).gridSize).toBe('large');
    });

    it('accepts boolean preferences', () => {
      const result = uiPreferencesSchema.parse({
        autoPlayVideos: false,
        showMetadata: true,
      });

      expect(result.autoPlayVideos).toBe(false);
      expect(result.showMetadata).toBe(true);
    });

    it('rejects invalid theme values', () => {
      expect(() => uiPreferencesSchema.parse({ theme: 'invalid' })).toThrow();
    });

    it('accepts empty object (all optional)', () => {
      const result = uiPreferencesSchema.parse({});
      expect(result).toEqual({});
    });
  });

  describe('privacyPreferencesSchema', () => {
    it('accepts valid privacy preferences', () => {
      const result = privacyPreferencesSchema.parse({
        showOnlineStatus: false,
        allowTagging: true,
        defaultAlbumVisibility: 'private',
      });

      expect(result.showOnlineStatus).toBe(false);
      expect(result.allowTagging).toBe(true);
      expect(result.defaultAlbumVisibility).toBe('private');
    });

    it('accepts valid visibility values', () => {
      expect(
        privacyPreferencesSchema.parse({ defaultAlbumVisibility: 'private' })
          .defaultAlbumVisibility
      ).toBe('private');
      expect(
        privacyPreferencesSchema.parse({ defaultAlbumVisibility: 'shared' })
          .defaultAlbumVisibility
      ).toBe('shared');
      expect(
        privacyPreferencesSchema.parse({ defaultAlbumVisibility: 'public' })
          .defaultAlbumVisibility
      ).toBe('public');
    });

    it('rejects invalid visibility values', () => {
      expect(() =>
        privacyPreferencesSchema.parse({ defaultAlbumVisibility: 'invalid' })
      ).toThrow();
    });
  });

  describe('emailNotificationPreferencesSchema', () => {
    it('accepts valid digest values', () => {
      expect(
        emailNotificationPreferencesSchema.parse({ digest: 'instant' }).digest
      ).toBe('instant');
      expect(
        emailNotificationPreferencesSchema.parse({ digest: 'daily' }).digest
      ).toBe('daily');
      expect(
        emailNotificationPreferencesSchema.parse({ digest: 'weekly' }).digest
      ).toBe('weekly');
      expect(
        emailNotificationPreferencesSchema.parse({ digest: 'never' }).digest
      ).toBe('never');
    });

    it('accepts notification type booleans', () => {
      const result = emailNotificationPreferencesSchema.parse({
        enabled: true,
        newShares: true,
        comments: false,
        albumUpdates: true,
        systemAlerts: false,
      });

      expect(result.enabled).toBe(true);
      expect(result.newShares).toBe(true);
      expect(result.comments).toBe(false);
    });
  });

  describe('userPreferencesInputSchema', () => {
    it('accepts complete user preferences', () => {
      const result = userPreferencesInputSchema.parse({
        notifications: {
          email: {
            enabled: true,
            digest: 'daily',
          },
          push: {
            enabled: false,
          },
        },
        ui: {
          theme: 'dark',
          gridSize: 'medium',
        },
        privacy: {
          showOnlineStatus: true,
          defaultAlbumVisibility: 'private',
        },
      });

      expect(result.notifications?.email?.enabled).toBe(true);
      expect(result.ui?.theme).toBe('dark');
      expect(result.privacy?.defaultAlbumVisibility).toBe('private');
    });

    it('accepts partial user preferences', () => {
      const result = userPreferencesInputSchema.parse({
        ui: {
          theme: 'light',
        },
      });

      expect(result.ui?.theme).toBe('light');
      expect(result.notifications).toBeUndefined();
    });

    it('accepts empty object', () => {
      const result = userPreferencesInputSchema.parse({});
      expect(result).toEqual({});
    });

    it('rejects invalid nested values', () => {
      expect(() =>
        userPreferencesInputSchema.parse({
          ui: {
            theme: 'invalid-theme',
          },
        })
      ).toThrow();
    });
  });
});

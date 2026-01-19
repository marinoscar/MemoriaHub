/**
 * System Settings Service Tests
 *
 * Tests for system-wide configuration management.
 * Covers caching, encryption, validation, and default values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SystemSettingsService } from '../../../../src/services/settings/system-settings.service.js';
import type { ISystemSettingsRepository } from '../../../../src/interfaces/index.js';
import type { SystemSettingsCategory } from '@memoriahub/shared';
import { ValidationError } from '../../../../src/domain/errors/index.js';

// Mock settings cache
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockCacheInvalidate = vi.fn();

vi.mock('../../../../src/infrastructure/cache/settings-cache.js', () => ({
  settingsCache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
    invalidate: (...args: unknown[]) => mockCacheInvalidate(...args),
  },
  CacheKeys: {
    systemSettings: (category: string) => `system:${category}`,
    allSystemSettings: () => 'system:all',
    featureFlags: () => 'features',
  },
  CacheTTL: {
    systemSettings: 300000,
    featureFlags: 60000,
  },
}));

// Mock crypto operations
vi.mock('../../../../src/infrastructure/crypto/settings-crypto.js', () => ({
  encryptSettingsFields: (settings: Record<string, unknown>, _fields: string[]) => ({
    ...settings,
    encrypted: true,
  }),
  decryptSettingsFields: (settings: Record<string, unknown>, _fields: string[]) => ({
    ...settings,
    decrypted: true,
  }),
  maskSettingsFields: (settings: Record<string, unknown>, fields: string[]) => {
    const masked = { ...settings };
    for (const field of fields) {
      if (field in masked) {
        masked[field] = '********';
      }
    }
    return masked;
  },
}));

// Mock logger
vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let mockRepository: ISystemSettingsRepository;

  const mockSmtpRow = {
    id: 'settings-1',
    category: 'smtp' as SystemSettingsCategory,
    settings: {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      fromAddress: 'noreply@example.com',
      password: 'secret-password',
    },
    updatedAt: new Date('2024-01-01'),
    updatedBy: 'admin-123',
  };

  const mockFeatureRow = {
    id: 'settings-2',
    category: 'features' as SystemSettingsCategory,
    settings: {
      aiSearch: true,
      sharing: true,
      publicLinks: false,
      comments: true,
    },
    updatedAt: new Date('2024-01-01'),
    updatedBy: 'admin-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRepository = {
      findByCategory: vi.fn(),
      findAll: vi.fn(),
      upsert: vi.fn(),
      patchSettings: vi.fn(),
    };

    service = new SystemSettingsService(mockRepository);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getByCategory', () => {
    it('returns cached settings when available', async () => {
      const cachedSettings = { enabled: true, host: 'cached.example.com' };
      mockCacheGet.mockReturnValue(cachedSettings);

      const result = await service.getByCategory('smtp');

      expect(result).toEqual(cachedSettings);
      expect(mockRepository.findByCategory).not.toHaveBeenCalled();
    });

    it('fetches from database when cache misses', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.findByCategory).mockResolvedValue(mockSmtpRow);

      const result = await service.getByCategory('smtp');

      expect(mockRepository.findByCategory).toHaveBeenCalledWith('smtp');
      expect(result).toHaveProperty('enabled', true);
    });

    it('returns defaults when category not in database', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.findByCategory).mockResolvedValue(null);

      const result = await service.getByCategory('smtp');

      // Should return default SMTP settings
      expect(result).toHaveProperty('enabled');
    });

    it('caches fetched settings', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.findByCategory).mockResolvedValue(mockSmtpRow);

      await service.getByCategory('smtp');

      expect(mockCacheSet).toHaveBeenCalledWith(
        'system:smtp',
        expect.any(Object),
        expect.any(Number)
      );
    });

    it('masks sensitive fields when masked=true', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: 'smtp.example.com',
        password: 'secret-password',
      });

      const result = await service.getByCategory('smtp', true);

      expect(result.password).toBe('********');
    });

    it('does not mask when masked=false', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: 'smtp.example.com',
        password: 'secret-password',
      });

      const result = await service.getByCategory('smtp', false);

      expect(result.password).toBe('secret-password');
    });
  });

  describe('getAll', () => {
    it('returns all categories with settings', async () => {
      vi.mocked(mockRepository.findAll).mockResolvedValue([mockSmtpRow, mockFeatureRow]);

      const result = await service.getAll();

      expect(result).toHaveLength(5); // smtp, push, storage, features, general
      expect(result.map(r => r.category)).toContain('smtp');
      expect(result.map(r => r.category)).toContain('features');
    });

    it('uses defaults for missing categories', async () => {
      vi.mocked(mockRepository.findAll).mockResolvedValue([mockSmtpRow]);

      const result = await service.getAll();

      // Should have all 5 categories even though only 1 is in DB
      expect(result).toHaveLength(5);

      // Check that missing categories have default settings
      const pushSettings = result.find(r => r.category === 'push');
      expect(pushSettings).toBeDefined();
    });

    it('masks sensitive fields when masked=true', async () => {
      vi.mocked(mockRepository.findAll).mockResolvedValue([mockSmtpRow]);

      const result = await service.getAll(true);

      const smtp = result.find(r => r.category === 'smtp');
      expect(smtp?.settings).toHaveProperty('password', '********');
    });
  });

  describe('update', () => {
    it('validates settings against schema', async () => {
      mockCacheGet.mockReturnValue({ enabled: false });

      // Invalid settings should throw ValidationError
      await expect(
        service.update('smtp', { port: 'invalid-port' }, 'admin-123')
      ).rejects.toThrow(ValidationError);
    });

    it('merges with existing settings', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: 'old.example.com',
        port: 587,
      });

      vi.mocked(mockRepository.patchSettings).mockResolvedValue({
        ...mockSmtpRow,
        settings: {
          enabled: true,
          host: 'new.example.com',
          port: 587,
        },
      });

      await service.update('smtp', { host: 'new.example.com' }, 'admin-123');

      expect(mockRepository.patchSettings).toHaveBeenCalledWith(
        'smtp',
        expect.objectContaining({
          settings: expect.objectContaining({
            host: 'new.example.com',
            port: 587,
          }),
          updatedBy: 'admin-123',
        })
      );
    });

    it('encrypts sensitive fields before storing', async () => {
      mockCacheGet.mockReturnValue({ enabled: true });

      vi.mocked(mockRepository.patchSettings).mockResolvedValue(mockSmtpRow);

      await service.update('smtp', { password: 'new-password' }, 'admin-123');

      expect(mockRepository.patchSettings).toHaveBeenCalledWith(
        'smtp',
        expect.objectContaining({
          settings: expect.objectContaining({
            encrypted: true,
          }),
        })
      );
    });

    it('invalidates cache after update', async () => {
      mockCacheGet.mockReturnValue({ enabled: true });
      vi.mocked(mockRepository.patchSettings).mockResolvedValue(mockSmtpRow);

      await service.update('smtp', { enabled: false }, 'admin-123');

      expect(mockCacheInvalidate).toHaveBeenCalledWith('system:smtp');
      expect(mockCacheInvalidate).toHaveBeenCalledWith('system:all');
    });

    it('returns masked settings in response', async () => {
      mockCacheGet.mockReturnValue({ enabled: true, password: 'old-password' });

      vi.mocked(mockRepository.patchSettings).mockResolvedValue({
        ...mockSmtpRow,
        settings: { ...mockSmtpRow.settings, password: 'new-password' },
      });

      const result = await service.update('smtp', { password: 'new-password' }, 'admin-123');

      expect(result.settings).toHaveProperty('password', '********');
    });
  });

  describe('getSmtpSettings', () => {
    it('returns typed SMTP settings', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        secure: true,
        fromAddress: 'noreply@example.com',
      });

      const result = await service.getSmtpSettings();

      expect(result.enabled).toBe(true);
      expect(result.host).toBe('smtp.example.com');
      expect(result.port).toBe(587);
    });
  });

  describe('getPushSettings', () => {
    it('returns typed push notification settings', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        provider: 'fcm',
      });

      const result = await service.getPushSettings();

      expect(result.enabled).toBe(true);
      expect(result.provider).toBe('fcm');
    });
  });

  describe('getFeatureFlags', () => {
    it('returns feature flags with caching', async () => {
      mockCacheGet.mockReturnValue({
        aiSearch: true,
        sharing: true,
        publicLinks: false,
      });

      const result = await service.getFeatureFlags();

      expect(result.aiSearch).toBe(true);
      expect(result.sharing).toBe(true);
      expect(result.publicLinks).toBe(false);
    });

    it('uses dedicated feature flags cache key', async () => {
      mockCacheGet.mockReturnValue(null);
      vi.mocked(mockRepository.findByCategory).mockResolvedValue(mockFeatureRow);

      await service.getFeatureFlags();

      expect(mockCacheGet).toHaveBeenCalledWith('features');
    });
  });

  describe('getGeneralSettings', () => {
    it('returns general settings', async () => {
      mockCacheGet.mockReturnValue({
        siteName: 'MemoriaHub',
        timezone: 'UTC',
      });

      const result = await service.getGeneralSettings();

      expect(result.siteName).toBe('MemoriaHub');
    });
  });

  describe('isFeatureEnabled', () => {
    it('returns true for enabled feature', async () => {
      mockCacheGet.mockReturnValue({ aiSearch: true, sharing: false });

      const result = await service.isFeatureEnabled('aiSearch');

      expect(result).toBe(true);
    });

    it('returns false for disabled feature', async () => {
      mockCacheGet.mockReturnValue({ aiSearch: true, sharing: false });

      const result = await service.isFeatureEnabled('sharing');

      expect(result).toBe(false);
    });

    it('returns false for undefined feature', async () => {
      mockCacheGet.mockReturnValue({ aiSearch: true });

      const result = await service.isFeatureEnabled('publicLinks');

      expect(result).toBe(false);
    });
  });

  describe('isSmtpEnabled', () => {
    it('returns true when SMTP is fully configured', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: 'smtp.example.com',
        fromAddress: 'noreply@example.com',
      });

      const result = await service.isSmtpEnabled();

      expect(result).toBe(true);
    });

    it('returns false when SMTP is disabled', async () => {
      mockCacheGet.mockReturnValue({
        enabled: false,
        host: 'smtp.example.com',
        fromAddress: 'noreply@example.com',
      });

      const result = await service.isSmtpEnabled();

      expect(result).toBe(false);
    });

    it('returns false when host is missing', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: '',
        fromAddress: 'noreply@example.com',
      });

      const result = await service.isSmtpEnabled();

      expect(result).toBe(false);
    });

    it('returns false when fromAddress is missing', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        host: 'smtp.example.com',
        fromAddress: '',
      });

      const result = await service.isSmtpEnabled();

      expect(result).toBe(false);
    });
  });

  describe('isPushEnabled', () => {
    it('returns true when push is configured', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        provider: 'fcm',
      });

      const result = await service.isPushEnabled();

      expect(result).toBe(true);
    });

    it('returns false when push is disabled', async () => {
      mockCacheGet.mockReturnValue({
        enabled: false,
        provider: 'fcm',
      });

      const result = await service.isPushEnabled();

      expect(result).toBe(false);
    });

    it('returns false when provider is missing', async () => {
      mockCacheGet.mockReturnValue({
        enabled: true,
        provider: '',
      });

      const result = await service.isPushEnabled();

      expect(result).toBe(false);
    });
  });
});

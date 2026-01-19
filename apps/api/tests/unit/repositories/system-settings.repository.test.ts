/**
 * System Settings Repository Tests
 *
 * Tests for PostgreSQL system settings repository implementation.
 * Covers CRUD operations for system settings by category.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { SystemSettingsCategory } from '@memoriahub/shared';

// Mock the database client
const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/database/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock the logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { SystemSettingsRepository } from '../../../src/infrastructure/database/repositories/system-settings.repository.js';

describe('SystemSettingsRepository', () => {
  let repository: SystemSettingsRepository;

  const mockSettingsRow = {
    id: 'settings-123',
    category: 'features' as SystemSettingsCategory,
    settings: {
      aiSearch: true,
      faceRecognition: false,
      webdavSync: true,
      publicSharing: true,
      guestUploads: false,
    },
    updated_at: new Date('2024-01-15T10:30:00Z'),
    updated_by: 'admin-user-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new SystemSettingsRepository();
  });

  describe('findByCategory', () => {
    it('returns settings for existing category', async () => {
      mockQuery.mockResolvedValue({
        rows: [mockSettingsRow],
      });

      const result = await repository.findByCategory('features');

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM system_settings WHERE category = $1',
        ['features']
      );
      expect(result).toEqual({
        id: 'settings-123',
        category: 'features',
        settings: mockSettingsRow.settings,
        updatedAt: mockSettingsRow.updated_at,
        updatedBy: 'admin-user-123',
      });
    });

    it('returns null when category not found', async () => {
      mockQuery.mockResolvedValue({
        rows: [],
      });

      const result = await repository.findByCategory('smtp');

      expect(result).toBeNull();
    });

    it('queries with correct category parameter', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repository.findByCategory('push');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['push']
      );
    });

    it('correctly maps database row to domain entity', async () => {
      const dbRow = {
        id: 'id-456',
        category: 'smtp' as SystemSettingsCategory,
        settings: { enabled: true, host: 'smtp.test.com' },
        updated_at: new Date('2024-02-20'),
        updated_by: null,
      };
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const result = await repository.findByCategory('smtp');

      expect(result).toEqual({
        id: 'id-456',
        category: 'smtp',
        settings: { enabled: true, host: 'smtp.test.com' },
        updatedAt: dbRow.updated_at,
        updatedBy: null,
      });
    });
  });

  describe('findAll', () => {
    it('returns all settings ordered by category', async () => {
      const rows = [
        { ...mockSettingsRow, category: 'features' as SystemSettingsCategory },
        {
          id: 'settings-456',
          category: 'general' as SystemSettingsCategory,
          settings: { siteName: 'TestHub' },
          updated_at: new Date('2024-01-10'),
          updated_by: 'admin-user-123',
        },
      ];
      mockQuery.mockResolvedValue({ rows });

      const result = await repository.findAll();

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM system_settings ORDER BY category'
      );
      expect(result).toHaveLength(2);
      expect(result[0].category).toBe('features');
      expect(result[1].category).toBe('general');
    });

    it('returns empty array when no settings exist', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findAll();

      expect(result).toEqual([]);
    });

    it('maps all rows correctly', async () => {
      const rows = [
        {
          id: '1',
          category: 'smtp' as SystemSettingsCategory,
          settings: { enabled: false },
          updated_at: new Date(),
          updated_by: 'user-1',
        },
        {
          id: '2',
          category: 'push' as SystemSettingsCategory,
          settings: { enabled: true },
          updated_at: new Date(),
          updated_by: 'user-2',
        },
      ];
      mockQuery.mockResolvedValue({ rows });

      const result = await repository.findAll();

      expect(result).toHaveLength(2);
      result.forEach((item, index) => {
        expect(item.id).toBe(rows[index].id);
        expect(item.category).toBe(rows[index].category);
        expect(item.settings).toEqual(rows[index].settings);
        expect(item.updatedAt).toBe(rows[index].updated_at);
        expect(item.updatedBy).toBe(rows[index].updated_by);
      });
    });
  });

  describe('upsert', () => {
    it('inserts new settings when category does not exist', async () => {
      const newSettings = {
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
      };
      const returnedRow = {
        id: 'new-id',
        category: 'smtp' as SystemSettingsCategory,
        settings: newSettings,
        updated_at: new Date(),
        updated_by: 'admin-123',
      };
      mockQuery.mockResolvedValue({ rows: [returnedRow] });

      const result = await repository.upsert('smtp', {
        settings: newSettings,
        updatedBy: 'admin-123',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO system_settings'),
        ['smtp', JSON.stringify(newSettings), 'admin-123']
      );
      expect(result.category).toBe('smtp');
      expect(result.settings).toEqual(newSettings);
    });

    it('updates existing settings on conflict', async () => {
      const updatedSettings = { aiSearch: true };
      const returnedRow = {
        id: 'existing-id',
        category: 'features' as SystemSettingsCategory,
        settings: updatedSettings,
        updated_at: new Date(),
        updated_by: 'admin-456',
      };
      mockQuery.mockResolvedValue({ rows: [returnedRow] });

      const result = await repository.upsert('features', {
        settings: updatedSettings,
        updatedBy: 'admin-456',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (category) DO UPDATE'),
        expect.any(Array)
      );
      expect(result.settings).toEqual(updatedSettings);
    });

    it('uses RETURNING clause to get updated row', async () => {
      mockQuery.mockResolvedValue({
        rows: [mockSettingsRow],
      });

      await repository.upsert('features', {
        settings: { aiSearch: true },
        updatedBy: 'user-1',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING *'),
        expect.any(Array)
      );
    });

    it('correctly serializes settings to JSON', async () => {
      const complexSettings = {
        nested: { value: true },
        array: [1, 2, 3],
        string: 'test',
      };
      mockQuery.mockResolvedValue({
        rows: [{
          id: '1',
          category: 'general' as SystemSettingsCategory,
          settings: complexSettings,
          updated_at: new Date(),
          updated_by: 'user',
        }],
      });

      await repository.upsert('general', {
        settings: complexSettings,
        updatedBy: 'user',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['general', JSON.stringify(complexSettings), 'user']
      );
    });
  });

  describe('patchSettings', () => {
    it('merges settings using JSONB concatenation', async () => {
      const partialSettings = { aiSearch: false };
      const returnedRow = {
        id: 'existing-id',
        category: 'features' as SystemSettingsCategory,
        settings: { ...mockSettingsRow.settings, aiSearch: false },
        updated_at: new Date(),
        updated_by: 'admin-789',
      };
      mockQuery.mockResolvedValue({ rows: [returnedRow] });

      const result = await repository.patchSettings('features', {
        settings: partialSettings,
        updatedBy: 'admin-789',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('system_settings.settings || $2::jsonb'),
        expect.any(Array)
      );
      expect(result.settings.aiSearch).toBe(false);
    });

    it('inserts new settings if category does not exist', async () => {
      const newSettings = { enabled: true };
      mockQuery.mockResolvedValue({
        rows: [{
          id: 'new-id',
          category: 'push' as SystemSettingsCategory,
          settings: newSettings,
          updated_at: new Date(),
          updated_by: 'admin',
        }],
      });

      await repository.patchSettings('push', {
        settings: newSettings,
        updatedBy: 'admin',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO system_settings'),
        expect.any(Array)
      );
    });

    it('uses RETURNING clause', async () => {
      mockQuery.mockResolvedValue({
        rows: [mockSettingsRow],
      });

      await repository.patchSettings('features', {
        settings: { aiSearch: true },
        updatedBy: 'user',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING *'),
        expect.any(Array)
      );
    });

    it('correctly serializes partial settings to JSON', async () => {
      const partialSettings = { faceRecognition: true };
      mockQuery.mockResolvedValue({
        rows: [{
          id: '1',
          category: 'features' as SystemSettingsCategory,
          settings: partialSettings,
          updated_at: new Date(),
          updated_by: 'user',
        }],
      });

      await repository.patchSettings('features', {
        settings: partialSettings,
        updatedBy: 'user',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['features', JSON.stringify(partialSettings), 'user']
      );
    });
  });

  describe('row to entity mapping', () => {
    it('converts snake_case to camelCase', async () => {
      const dbRow = {
        id: 'test-id',
        category: 'smtp' as SystemSettingsCategory,
        settings: { enabled: true },
        updated_at: new Date('2024-03-01T12:00:00Z'),
        updated_by: 'user-123',
      };
      mockQuery.mockResolvedValue({ rows: [dbRow] });

      const result = await repository.findByCategory('smtp');

      expect(result).toHaveProperty('updatedAt');
      expect(result).toHaveProperty('updatedBy');
      expect(result).not.toHaveProperty('updated_at');
      expect(result).not.toHaveProperty('updated_by');
    });

    it('preserves Date type for updatedAt', async () => {
      const date = new Date('2024-03-15T14:30:00Z');
      mockQuery.mockResolvedValue({
        rows: [{
          id: '1',
          category: 'features' as SystemSettingsCategory,
          settings: {},
          updated_at: date,
          updated_by: null,
        }],
      });

      const result = await repository.findByCategory('features');

      expect(result?.updatedAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toEqual(date);
    });

    it('handles null updatedBy', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: '1',
          category: 'features' as SystemSettingsCategory,
          settings: {},
          updated_at: new Date(),
          updated_by: null,
        }],
      });

      const result = await repository.findByCategory('features');

      expect(result?.updatedBy).toBeNull();
    });
  });
});

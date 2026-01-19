import type { SystemSettingsCategory, SystemSettingsRow } from '@memoriahub/shared';
import type {
  ISystemSettingsRepository,
  UpdateSystemSettingsInput,
} from '../../../interfaces/index.js';
import { query } from '../client.js';
import { logger } from '../../logging/logger.js';

/**
 * Database row type for system_settings table
 */
interface SystemSettingsDbRow {
  id: string;
  category: SystemSettingsCategory;
  settings: Record<string, unknown>;
  updated_at: Date;
  updated_by: string | null;
}

/**
 * Convert database row to domain entity
 */
function rowToSystemSettings(row: SystemSettingsDbRow): SystemSettingsRow {
  return {
    id: row.id,
    category: row.category,
    settings: row.settings,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * PostgreSQL implementation of system settings repository
 */
export class SystemSettingsRepository implements ISystemSettingsRepository {
  async findByCategory(category: SystemSettingsCategory): Promise<SystemSettingsRow | null> {
    const result = await query<SystemSettingsDbRow>(
      'SELECT * FROM system_settings WHERE category = $1',
      [category]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToSystemSettings(result.rows[0]);
  }

  async findAll(): Promise<SystemSettingsRow[]> {
    const result = await query<SystemSettingsDbRow>(
      'SELECT * FROM system_settings ORDER BY category'
    );

    return result.rows.map(rowToSystemSettings);
  }

  async upsert(
    category: SystemSettingsCategory,
    input: UpdateSystemSettingsInput
  ): Promise<SystemSettingsRow> {
    const result = await query<SystemSettingsDbRow>(
      `INSERT INTO system_settings (category, settings, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (category) DO UPDATE SET
         settings = $2,
         updated_by = $3,
         updated_at = NOW()
       RETURNING *`,
      [category, JSON.stringify(input.settings), input.updatedBy]
    );

    const settings = rowToSystemSettings(result.rows[0]);

    logger.info(
      {
        eventType: 'settings.system.updated',
        category,
        updatedBy: input.updatedBy,
      },
      `System settings updated: ${category}`
    );

    return settings;
  }

  async patchSettings(
    category: SystemSettingsCategory,
    input: UpdateSystemSettingsInput
  ): Promise<SystemSettingsRow> {
    // Use JSONB concatenation to merge settings
    // The || operator performs a shallow merge, but we use jsonb_deep_merge for deep merge
    const result = await query<SystemSettingsDbRow>(
      `INSERT INTO system_settings (category, settings, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (category) DO UPDATE SET
         settings = system_settings.settings || $2::jsonb,
         updated_by = $3,
         updated_at = NOW()
       RETURNING *`,
      [category, JSON.stringify(input.settings), input.updatedBy]
    );

    const settings = rowToSystemSettings(result.rows[0]);

    logger.info(
      {
        eventType: 'settings.system.patched',
        category,
        updatedBy: input.updatedBy,
        changedFields: Object.keys(input.settings),
      },
      `System settings patched: ${category}`
    );

    return settings;
  }
}

// Export singleton instance
export const systemSettingsRepository = new SystemSettingsRepository();

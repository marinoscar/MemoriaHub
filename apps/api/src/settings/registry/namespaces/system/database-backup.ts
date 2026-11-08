// PLATFORM-ADOPTION-SHIM(RETRO-D4): the db-backup slice swaps this for DATABASE_BACKUP_SYSTEM_SETTINGS.
import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'timeOfDay must be "HH:mm"'),
  timezone: z.string().min(1),
  retentionCount: z.number().int().min(1).max(100),
  storageProvider: z.string().nullable(),
  runStaleMinutes: z.number().int().min(5).max(240),
  compressionLevel: z.number().int().min(0).max(9),
  restoreRollbackMode: z.enum(['retain_database', 'pre_restore_dump']),
  oldDatabaseRetentionHours: z.number().int().min(1).max(720),
});
export type DatabaseBackupSettingsValue = z.infer<typeof schema>;

export const DATABASE_BACKUP_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'databaseBackup',
  description: 'PostgreSQL backup schedule, retention, compression and restore rollback policy.',
  schema,
  defaults: {
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
  },
});

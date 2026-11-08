import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

// Local Media Backup change feed (epic #308), read by NodeBackupQueryService.
const schema = z.object({
  maxPageSize: z.number().int().min(50).max(500),
  feedSafetyHorizonSeconds: z.number().int().min(0).max(60),
  runStaleMinutes: z.number().int().min(5).max(120),
});
export type BackupSettingsValue = z.infer<typeof schema>;

export const BACKUP_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'backup',
  description: 'Local Media Backup change feed: page size, safety horizon and run staleness.',
  schema,
  defaults: { maxPageSize: 200, feedSafetyHorizonSeconds: 5, runStaleMinutes: 15 },
});

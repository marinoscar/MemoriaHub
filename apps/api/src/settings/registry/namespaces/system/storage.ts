// PLATFORM-ADOPTION-SHIM(RETRO-D1): the storage slice swaps this for STORAGE_SYSTEM_SETTINGS plus an
// extension carrying `insights` and `trash`.
import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

const schema = z.object({
  activeProvider: z.string(),
  insights: z.object({ refreshIntervalHours: z.number().int().min(1).max(168) }),
  trash: z.object({ retentionDays: z.number().int().min(1).max(365) }),
});
export type StorageSettingsValue = z.infer<typeof schema>;

export const STORAGE_SYSTEM_SETTINGS = defineSystemNamespace({
  key: 'storage',
  description: 'The active object-storage provider, storage-insights cadence and trash retention.',
  schema,
  defaults: {
    activeProvider: process.env['STORAGE_PROVIDER'] ?? 's3',
    insights: { refreshIntervalHours: 4 },
    trash: { retentionDays: 30 },
  },
});

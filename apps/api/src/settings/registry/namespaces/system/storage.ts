// =============================================================================
// MemoriaHub's fields in the platform `storage` system-settings namespace (RETRO-D1, #563)
// =============================================================================
//
// Since RETRO-D1 the `storage` namespace is the storage slice's declaration
// (`STORAGE_SYSTEM_SETTINGS` of `@marinoscar/platform-api/storage`: `provider`, the
// `drivers` record and the deprecated flat aliases). MemoriaHub keeps two product
// settings under the same key, unchanged in the `global` row, as an EXTENSION of it:
//
//   insights.refreshIntervalHours  the storage-insights snapshot cadence
//   trash.retentionDays            how long trashed media stay recoverable
//
// The old `activeProvider` field is no longer declared: it stays in the row (the
// platform preserves unmodelled keys) until `scripts/migrate-storage-settings.ts`
// copies it to `provider`, and nothing reads it any more.
// =============================================================================

import type { SystemSettingsNamespaceExtension } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const storedSchema = z.object({
  insights: z.object({ refreshIntervalHours: z.number().int().min(1).max(168) }),
  trash: z.object({ retentionDays: z.number().int().min(1).max(365) }),
});

/** MemoriaHub's own fields under `storage`. */
export type StorageAppSettingsValue = z.infer<typeof storedSchema>;

const patchSchema = z.object({
  insights: z.object({ refreshIntervalHours: z.number().int().min(1).max(168) }).partial(),
  trash: z.object({ retentionDays: z.number().int().min(1).max(365) }).partial(),
}).partial();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const DEFAULTS = {
  insights: { refreshIntervalHours: 4 },
  trash: { retentionDays: 30 },
} as const;

export const STORAGE_SYSTEM_SETTINGS_EXTENSION: SystemSettingsNamespaceExtension = {
  key: 'storage',
  storedSchema,
  patchSchema,
  wirePatchSchema: patchSchema,
  defaults: structuredClone(DEFAULTS) as unknown as Record<string, unknown>,
  // Each sub-object merges field by field (a PATCH of `trash.retentionDays` keeps `insights`), on
  // top of the defaults: a stored row written before these keys existed (or by the platform's
  // storage writes, which know nothing of them) gets them back on the next write, instead of
  // failing the stored schema.
  merge(current, patch, baseMerge) {
    const merged = baseMerge(current, patch) as Record<string, unknown>;
    for (const key of ['insights', 'trash'] as const) {
      const stored = isRecord(current[key]) ? current[key] : {};
      const patched = isRecord(patch) && isRecord(patch[key]) ? patch[key] : {};
      merged[key] = { ...DEFAULTS[key], ...stored, ...patched };
    }
    return merged;
  },
};

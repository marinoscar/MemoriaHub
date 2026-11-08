import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// Per-user Memories preferences (issue #307). ABSENT MEANS NO PREFERENCE: nobody hidden, no sensitive
// date range, digest not opted out. Read-time filters only, never a generation input (a Memory row is
// circle content shared by every member). No `.default()` anywhere.
export const MEMORIES_MAX_HIDDEN_PERSON_IDS = 200;
export const MEMORIES_MAX_HIDDEN_DATE_RANGES = 50;
export const MEMORIES_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A `YYYY-MM-DD` that names a REAL calendar day: the regex alone accepts 2026-02-31.
const memoriesDateSchema = z
  .string()
  .regex(MEMORIES_DATE_PATTERN, 'Date must be formatted YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, 'Date must be a real calendar day');

export const memoriesHiddenDateRangeSchema = z
  .object({ from: memoriesDateSchema, to: memoriesDateSchema })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'hiddenDateRanges entries require from <= to' });

const hiddenPersonIds = z.array(z.string().uuid()).max(MEMORIES_MAX_HIDDEN_PERSON_IDS);
const hiddenDateRanges = z.array(memoriesHiddenDateRangeSchema).max(MEMORIES_MAX_HIDDEN_DATE_RANGES);

export const memoriesPreferencesSchema = z
  .object({
    hiddenPersonIds: hiddenPersonIds.optional(),
    hiddenDateRanges: hiddenDateRanges.optional(),
    emailDigestOptOut: z.boolean().optional(),
  })
  .strict();

// Any field may be null to DELETE it, resetting it to absent rather than pinning an explicit empty list.
export const memoriesPreferencesPatchSchema = z
  .object({
    hiddenPersonIds: hiddenPersonIds.nullable().optional(),
    hiddenDateRanges: hiddenDateRanges.nullable().optional(),
    emailDigestOptOut: z.boolean().nullable().optional(),
  })
  .strict();

export type MemoriesPreferencesValue = z.infer<typeof memoriesPreferencesSchema>;
export type MemoriesPreferencesPatch = z.infer<typeof memoriesPreferencesPatchSchema>;

const FIELDS = ['hiddenPersonIds', 'hiddenDateRanges', 'emailDigestOptOut'] as const;

/** Field-wise: a listed field replaces, an unlisted one is untouched, null deletes it. */
export function mergeMemoriesPreferences(
  current: MemoriesPreferencesValue | undefined,
  patch: MemoriesPreferencesPatch | null | undefined,
): MemoriesPreferencesValue | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;

  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const field of FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  return Object.keys(merged).length > 0 ? (merged as MemoriesPreferencesValue) : undefined;
}

export const MEMORIES_USER_SETTINGS = {
  key: 'memories',
  description: 'Per-user Memories preferences: hidden people, sensitive date ranges, digest opt-out. Absent means none.',
  schema: memoriesPreferencesSchema,
  patchSchema: memoriesPreferencesPatchSchema,
  merge: mergeMemoriesPreferences,
} satisfies UserSettingsNamespace<'memories', MemoriesPreferencesValue, MemoriesPreferencesPatch>;

import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// Which search fields the panel shows. Replaced wholesale on PATCH.
const schema = z.object({ visibleFields: z.array(z.string()) });
// The wire body may omit `visibleFields`; it then stores an empty list, as it did before RETRO-B3.
const wire = z.object({ visibleFields: z.array(z.string()).optional() });
export type SearchPreferencesValue = z.infer<typeof schema>;

export const SEARCH_USER_SETTINGS = {
  key: 'search',
  description: 'Which fields the search panel shows.',
  schema,
  patchSchema: wire,
  putSchema: wire,
  wirePatchSchema: wire,
  merge(current: SearchPreferencesValue | undefined, patch: { visibleFields?: string[] } | null | undefined) {
    if (patch === undefined) return current;
    if (patch === null) return undefined;
    return { visibleFields: patch.visibleFields ?? [] };
  },
} satisfies UserSettingsNamespace<'search', SearchPreferencesValue, { visibleFields?: string[] }>;

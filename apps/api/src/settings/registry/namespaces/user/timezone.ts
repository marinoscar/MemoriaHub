import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

import { isSupportedTimeZone } from '../../../../common/time/zone.util';

// Per-user time zone (issue #444). ABSENT means no preference expressed, which is deliberately
// distinct from an explicit 'UTC': GET /api/auth/me returns the RAW value so a client can tell a
// user who never chose from one who picked UTC. Never materialised server-side, never `.default()`.
//
// The platform keeps a zone at `profile.timezone`; this app has always stored it at the top level of
// the document, and moving it would rewrite every row. Until a deliberate data step does, the
// top-level key is the one that is read and written (see docs/platform-adoption/local-exceptions.md).
//
// `isSupportedTimeZone` is NOT an Intl.supportedValuesOf membership test: that list is canonical
// names only and omits live aliases a browser reports (Asia/Kolkata, Europe/Kyiv).
export const userTimeZoneSchema = z.string().min(1).refine(isSupportedTimeZone, 'Unknown IANA time zone');
export type TimezonePreferenceValue = z.infer<typeof userTimeZoneSchema>;

export const TIMEZONE_USER_SETTINGS = {
  key: 'timezone',
  description: 'The IANA zone the user wants instants rendered in. Absent is not UTC.',
  schema: userTimeZoneSchema,
  patchSchema: userTimeZoneSchema.nullable(),
  // A scalar: plain JSON Merge Patch. Absent keeps, a value replaces, null clears back to "no preference".
  merge(current: string | undefined, patch: string | null | undefined) {
    if (patch === undefined) return current;
    return patch === null ? undefined : patch;
  },
} satisfies UserSettingsNamespace<'timezone', string, string>;

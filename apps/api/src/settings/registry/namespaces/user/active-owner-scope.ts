import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// The library the web app shows (RETRO-I6, #588): the caller's own personal library (`me`) or one
// shared library (`group`, a platform group id; a former shared circle's id, decision 1 of
// docs/platform-adoption/circles-to-groups.md). It replaces the old top-level `activeCircleId`,
// which no namespace declared and which the settings slice therefore dropped since RETRO-B3.
//
// UX state only: it NEVER authorizes anything. Every route re-checks the scope it is given, and a
// stored group the user has since left is simply ignored by the client (it falls back to `me`).
// ABSENT means `me`; there is deliberately no `.default()`.
export const activeOwnerScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('me') }).strict(),
  z.object({ kind: z.literal('group'), groupId: z.string().uuid() }).strict(),
]);
export type ActiveOwnerScopeValue = z.infer<typeof activeOwnerScopeSchema>;

export const ACTIVE_OWNER_SCOPE_USER_SETTINGS = {
  key: 'activeOwnerScope',
  description: 'The library the web app shows: `me` (the personal library) or a group. UX state only; absent means `me`.',
  schema: activeOwnerScopeSchema,
  patchSchema: activeOwnerScopeSchema.nullable(),
  // Replaced wholesale: absent keeps, a value replaces, null clears back to `me`.
  merge(current: ActiveOwnerScopeValue | undefined, patch: ActiveOwnerScopeValue | null | undefined) {
    if (patch === undefined) return current;
    return patch === null ? undefined : patch;
  },
} satisfies UserSettingsNamespace<'activeOwnerScope', ActiveOwnerScopeValue, ActiveOwnerScopeValue>;

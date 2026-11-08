// =============================================================================
// MemoriaHub's identity registrations (RETRO-B2, issue #611)
// =============================================================================
//
// Registered AT IMPORT TIME: the registries freeze once the application has
// bootstrapped (`platform/identity/identity.config.ts` imports this file).

import { registerCurrentUserExtension } from '@marinoscar/platform-api/identity';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * `GET /api/auth/me` -> `extensions.memoriahub`.
 *
 * `timezone` is the RAW `user_settings.timezone` (issue #444): `null` when the
 * user never expressed a preference, never resolved to `'UTC'`, so the client can
 * tell "chose UTC" from "never chose". Before the identity slice it was a
 * top-level `timezone` field of `/me`; the platform payload has no such field,
 * so it moved here (the web reads `extensions.memoriahub.timezone`).
 *
 * The resolver reads `user_settings` straight off the client, as the old
 * `AuthService.readStoredTimeZone` did: `getSettings()` would CREATE a default
 * row as a side effect of a pure read.
 */
let client: Pick<PrismaService, 'userSettings'> | null = null;

/** Bound once, by `ProfileModule`, when the Prisma service exists. */
export function bindIdentityExtensionClient(prisma: PrismaService): void {
  client = prisma;
}

registerCurrentUserExtension({
  id: 'memoriahub',
  resolve: async (userId: string) => {
    if (!client) return { timezone: null };
    const row = await client.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const value = row?.value;
    const tz =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)['timezone']
        : undefined;
    return { timezone: typeof tz === 'string' && tz.length > 0 ? tz : null };
  },
});

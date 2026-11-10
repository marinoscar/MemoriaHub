import type { UserSettingsNamespaceExtension } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

// The platform's `navigation` namespace holds `railCollapsed`. MemoriaHub adds the user's pinned
// destinations (spec §5): SUB-destinations only, never one of the four primaries.
export const NAVIGATION_PINNABLE_KEYS = [
  'albums',
  'people',
  'places',
  'memories',
  'map',
  'favorites',
  'archive',
  'trash',
  'shared',
  'bursts',
  'duplicates',
  'locations',
  'enhancements',
  'review-insights',
  'automations',
] as const;
export type NavigationPinnableKey = (typeof NAVIGATION_PINNABLE_KEYS)[number];

/** Max pinned destinations one user may persist. */
export const NAVIGATION_MAX_PINNED = 6;

const pinnable: ReadonlySet<string> = new Set(NAVIGATION_PINNABLE_KEYS);

/**
 * Runtime membership test for a stored pin key.
 *
 * On WRITE the zod enum REJECTS an unknown key (a client bug worth surfacing). On READ an unknown
 * key is DROPPED, not rejected: a stored unknown key is our own past self (a destination a later
 * release removed), and rejecting it would make the whole settings document unreadable over one
 * dead pin. The drop is also what keeps the strict enum safe on the next unrelated PATCH.
 */
export function isNavigationPinnableKey(value: string): value is NavigationPinnableKey {
  return pinnable.has(value);
}

/** `navigation` with every pin this release no longer knows removed. */
export function sanitizeNavigation<T extends object | undefined>(navigation: T): T {
  const stored = navigation as Record<string, unknown> | undefined;
  if (!stored || !Array.isArray(stored['pinned'])) return navigation;
  const pinned = (stored['pinned'] as unknown[]).filter(
    (key): key is string => typeof key === 'string' && isNavigationPinnableKey(key),
  );
  return { ...stored, pinned } as T;
}

const pinned = z.array(z.enum(NAVIGATION_PINNABLE_KEYS)).max(NAVIGATION_MAX_PINNED);

export const NAVIGATION_USER_SETTINGS_EXTENSION: UserSettingsNamespaceExtension = {
  key: 'navigation',
  schema: z.object({ pinned: pinned.optional() }),
  patchSchema: z.object({ pinned: pinned.nullable().optional() }),
  // The base merge handles `railCollapsed` and the namespace-level null; this adds `pinned`
  // (null deletes it) and sanitises the stored list first, so a dead pin never survives a write.
  merge(current, patch, baseMerge) {
    const clean = sanitizeNavigation(current);
    if (patch === undefined) return clean;
    if (patch === null) return undefined;

    const { pinned: patchPinned, ...rest } = patch;
    const { pinned: currentPinned, ...currentRest } = clean ?? {};
    const base = (baseMerge(Object.keys(currentRest).length > 0 ? currentRest : undefined, rest) ?? {}) as Record<string, unknown>;
    const nextPinned = patchPinned !== undefined ? patchPinned : currentPinned;
    const merged: Record<string, unknown> = { ...base };
    if (nextPinned !== undefined && nextPinned !== null) merged['pinned'] = nextPinned;
    return Object.keys(merged).length > 0 ? merged : undefined;
  },
};

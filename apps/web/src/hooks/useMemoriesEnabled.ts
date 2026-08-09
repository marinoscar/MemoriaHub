import { useFeatureFlags } from './useFeatureFlags';

/**
 * Is the Memories feature (epic #300) available to this user?
 *
 * Reads `GET /api/features` — the least-privilege carrier any authenticated
 * user can read — NOT `GET /api/system-settings`, which needs the Admin-only
 * `system_settings:read` and would 403 for an ordinary circle member.
 *
 * Returns `true | false | null`: `null` means "not resolved yet". Callers must
 * gate on `=== true` (never a truthy check) so a nav entry or a carousel cannot
 * flash in while the flags are still loading, and so a flags outage — which
 * leaves `features` null rather than throwing — hides the affordance instead of
 * guessing. This is the same convention `Sidebar` already documents for the
 * picture-enhancer entry.
 */
export function useMemoriesEnabled(): boolean | null {
  const { features, isLoading } = useFeatureFlags();
  if (isLoading || features === null) return null;
  return features['memories'] === true;
}

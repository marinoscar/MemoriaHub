import { useState, useEffect, useCallback } from 'react';
import { ApiError } from '../services/api';
import { getFeatures } from '../services/features';
import type { FeatureFlags, PictureEnhancementPolicy } from '../services/features';

// ---------------------------------------------------------------------------
// Module-level cache
//
// Feature flags change rarely, but several components gate affordances on them
// (MediaGallery, MediaLightbox, ...). Without a shared cache, every mount would
// fire its own GET /api/features. A module-scoped promise doubles as both the
// in-flight dedup (concurrent mounts share one request) and the short-TTL cache
// (later mounts reuse the resolved value). `refresh()` busts it.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

let cachedPromise: Promise<FeatureFlags> | null = null;
let cachedAt = 0;

function loadFeatures(force = false): Promise<FeatureFlags> {
  const fresh = cachedPromise !== null && Date.now() - cachedAt < CACHE_TTL_MS;
  if (!force && fresh) return cachedPromise as Promise<FeatureFlags>;

  cachedAt = Date.now();
  cachedPromise = getFeatures().catch((err) => {
    // Never cache a failure — the next consumer should retry.
    cachedPromise = null;
    cachedAt = 0;
    throw err;
  });
  return cachedPromise;
}

/** Test/escape hatch: drop the module-level cache. */
export function clearFeatureFlagsCache(): void {
  cachedPromise = null;
  cachedAt = 0;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseFeatureFlagsReturn {
  /** Raw feature-flag record; null while loading or on failure. */
  features: Record<string, boolean> | null;
  /** Picture-enhancement client policy; null while loading or on failure. */
  pictureEnhancement: PictureEnhancementPolicy | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Read-only feature flags for any authenticated user.
 *
 * Degrades gracefully: a fetch failure leaves `features`/`pictureEnhancement`
 * null and populates `error` — it never throws, so a flag outage can only hide
 * a gated affordance, never break the surface hosting it.
 */
export function useFeatureFlags(): UseFeatureFlagsReturn {
  const [flags, setFlags] = useState<FeatureFlags | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await loadFeatures(force);
      setFlags(data);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Failed to load feature flags';
      setFlags(null);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    loadFeatures()
      .then((data) => {
        if (active) setFlags(data);
      })
      .catch((err) => {
        if (!active) return;
        setFlags(null);
        setError(
          err instanceof ApiError ? err.message : 'Failed to load feature flags',
        );
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(() => load(true), [load]);

  return {
    features: flags?.features ?? null,
    pictureEnhancement: flags?.pictureEnhancement ?? null,
    isLoading,
    error,
    refresh,
  };
}

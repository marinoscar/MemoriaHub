import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { MemoriahubWebHostProvider, useMemoriahubHost } from '@marinoscar/memoriahub-web/core/headless';
import type { MemoriahubFeatures, MemoriahubPrincipal } from '@marinoscar/memoriahub-web/core/headless';

import { useAuth } from '../contexts/AuthContext';
import { useOwnerScope } from '../contexts/OwnerScopeContext';
import { useSearch } from '../contexts/SearchContext';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import { buildMemoriahubHost } from './host';

/**
 * Provides the `MemoriahubWebHost` to the packaged slices. Mounted inside the
 * auth and owner-scope providers it reads, above the routes.
 */
export function MemoriahubHostBinding({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const ownerScope = useOwnerScope();
  const flags = useFeatureFlags({ enabled: user !== null });
  const navigate = useNavigate();

  const principal = useMemo<MemoriahubPrincipal | null>(
    () =>
      user
        ? {
            id: user.id,
            permissions: user.permissions ?? [],
            roles: (user.roles ?? []).map((r) => r.name),
            displayName: user.displayName ?? null,
            timeZone: user.timezone ?? null,
          }
        : null,
    [user],
  );

  const features = useMemo<MemoriahubFeatures>(
    () => ({
      flags: flags.features,
      pictureEnhancement: flags.pictureEnhancement,
      isLoading: flags.isLoading,
      error: flags.error,
      refresh: flags.refresh,
    }),
    [flags.features, flags.pictureEnhancement, flags.isLoading, flags.error, flags.refresh],
  );

  const host = useMemo(
    () => buildMemoriahubHost({ principal, authLoading: isLoading, features, ownerScope, navigate }),
    [principal, isLoading, features, ownerScope, navigate],
  );

  return <MemoriahubWebHostProvider host={host}>{children}</MemoriahubWebHostProvider>;
}

/**
 * Adds the search surface to the host: `SearchProvider` mounts with the shell
 * (below the host binding), so the bridge sits under it and re-provides the host
 * with `search` filled in.
 */
export function MemoriahubSearchBridge({ children }: { children: ReactNode }) {
  const host = useMemoriahubHost();
  const { runDeterministicSearch } = useSearch();
  const value = useMemo(
    () => ({ ...host, search: { runDeterministicSearch } }),
    [host, runDeterministicSearch],
  );
  return <MemoriahubWebHostProvider host={value}>{children}</MemoriahubWebHostProvider>;
}

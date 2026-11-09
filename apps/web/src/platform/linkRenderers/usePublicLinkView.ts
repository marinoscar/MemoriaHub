import { useEffect, useState } from 'react';
import { LINK_TOKEN_HEADER } from '@marinoscar/platform-contract/sharing';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

/**
 * Fetches one of MemoriaHub's public link views (`/public/links/media` or `/public/links/album`)
 * with the token in the `X-Link-Token` header, never in a path or a query string.
 */
export function usePublicLinkView<T>(apiClient: PlatformApiClient, path: string, token: string) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'unavailable'; view: T | null }>({
    status: 'loading',
    view: null,
  });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', view: null });
    apiClient
      .get<T>(path, { headers: { [LINK_TOKEN_HEADER]: token } })
      .then((view) => live && setState({ status: 'ready', view }))
      .catch(() => live && setState({ status: 'unavailable', view: null }));
    return () => {
      live = false;
    };
  }, [apiClient, path, token]);
  return state;
}

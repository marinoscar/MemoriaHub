/** The public view of an `album` link (RETRO-I4, #578): the grid and its lightbox. */
import { useEffect } from 'react';
import type { LinkRendererProps } from '@marinoscar/platform-web/sharing/headless';

import { AlbumViewer, CenteredSpinner, UnavailableMessage, type PublicAlbumLinkView } from './publicMediaViews';
import { usePublicLinkView } from './usePublicLinkView';

export function AlbumLinkRenderer({ token, apiClient }: LinkRendererProps) {
  const { status, view } = usePublicLinkView<PublicAlbumLinkView>(apiClient, '/public/links/album', token);
  useEffect(() => {
    document.title = 'Shared album';
  }, []);
  if (status === 'loading') return <CenteredSpinner />;
  if (status === 'unavailable' || !view) return <UnavailableMessage />;
  return <AlbumViewer itemCount={view.itemCount} items={view.items} />;
}

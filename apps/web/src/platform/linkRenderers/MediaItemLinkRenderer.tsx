/** The public view of a `media_item` link (RETRO-I4, #578): one photo or video, full screen. */
import { useEffect } from 'react';
import type { LinkRendererProps } from '@marinoscar/platform-web/sharing/headless';

import { CenteredSpinner, SingleMediaViewer, UnavailableMessage, type PublicMediaLinkView } from './publicMediaViews';
import { usePublicLinkView } from './usePublicLinkView';

export function MediaItemLinkRenderer({ token, apiClient }: LinkRendererProps) {
  const { status, view } = usePublicLinkView<PublicMediaLinkView>(apiClient, '/public/links/media', token);
  useEffect(() => {
    document.title = 'Shared media';
  }, []);
  if (status === 'loading') return <CenteredSpinner />;
  if (status === 'unavailable' || !view) return <UnavailableMessage />;
  return <SingleMediaViewer item={view.media} />;
}

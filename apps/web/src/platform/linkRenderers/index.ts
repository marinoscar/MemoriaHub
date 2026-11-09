/**
 * MemoriaHub's link renderers (RETRO-I4, #578): how the public `/s` page
 * (`PublicLinkPage` of `@marinoscar/platform-web/sharing/ui`) shows each resource type a
 * public link can open. Any other type shows the slice's neutral "This link is not available".
 *
 * Called ONCE from `main.tsx`, before the first render; the registry is frozen right after,
 * so a renderer registered later throws `FROZEN` instead of quietly changing a public page.
 */
import { freezeLinkRenderers, linkRenderers, registerLinkRenderer } from '@marinoscar/platform-web/sharing/headless';

import { AlbumLinkRenderer } from './AlbumLinkRenderer';
import { MediaItemLinkRenderer } from './MediaItemLinkRenderer';

/** Registers the `media_item` and `album` renderers, then freezes the registry (idempotent). */
export function registerAppLinkRenderers(): void {
  if (linkRenderers.isFrozen()) return;
  registerLinkRenderer('media_item', MediaItemLinkRenderer);
  registerLinkRenderer('album', AlbumLinkRenderer);
  freezeLinkRenderers();
}

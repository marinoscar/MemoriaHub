import { defineHostSlot } from '../../core/ui/index.js';
import { VIEWER_LINK_SHARE_PANEL_SLOT } from '../headless/slot-names.js';

/**
 * Props of the inline public-link controls the host supplies.
 *
 * @stability experimental
 */
export interface LinkSharePanelSlotProps {
  /** What the link shares. */
  target: { type: 'media_item' | 'album'; id: string };
}

/**
 * The host's inline public-link controls (create a link with an expiry, copy it, revoke it).
 *
 * @remarks
 * A host slot for good: sharing is the platform's, and the panel renders as a plain node, never a modal, because
 * the drawer and the lightbox are themselves modals. A host that registers none renders the viewer without it.
 *
 * @stability experimental
 * @extensionPoint host
 */
export const LinkSharePanel = defineHostSlot<LinkSharePanelSlotProps>(VIEWER_LINK_SHARE_PANEL_SLOT);

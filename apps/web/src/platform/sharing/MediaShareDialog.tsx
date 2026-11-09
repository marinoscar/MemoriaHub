/**
 * The share dialog of a photo, a video or an album (RETRO-I4, #578): the sharing slice's
 * `ShareDialog` with MemoriaHub's roles, public links on, and "Never" among the link expiries.
 * Replaced `components/share/ShareDialog.tsx`. For a surface that is itself a modal (the media
 * drawer, the lightbox) use the inline `LinkSharePanel` instead: a dialog opened over a temporary
 * drawer freezes in a nested focus trap.
 */
import { ShareDialog } from '@marinoscar/platform-web/sharing/ui';

import { LINK_EXPIRY_PRESETS, MEDIA_LINK_ROLES, MEDIA_SHARE_ROLES, type MediaShareType } from './shareOptions';

export interface MediaShareDialogProps {
  open: boolean;
  onClose: () => void;
  target: { type: MediaShareType; id: string };
  /** The record's name, for the title ("Share <name>"). */
  title?: string;
}

export function MediaShareDialog({ open, onClose, target, title }: MediaShareDialogProps) {
  // Mounted only while open: the slice's dialog runs its sharing hooks (which need the platform
  // host) as soon as it mounts, and a page that only MIGHT share (an album page) should not.
  if (!open) return null;
  return (
    <ShareDialog
      open={open}
      onClose={onClose}
      resource={{ type: target.type, id: target.id }}
      {...(title === undefined ? {} : { resourceTitle: title })}
      roles={MEDIA_SHARE_ROLES}
      allowLinks
      linkRoles={MEDIA_LINK_ROLES}
      linkExpiryPresets={LINK_EXPIRY_PRESETS}
    />
  );
}

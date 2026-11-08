/**
 * NotificationBell — the AppBar bell (RETRO-D3, #576): the packaged
 * `NotificationBell` (`@marinoscar/platform-web/notifications/ui`) over the
 * shell's `NotificationProvider`, with this app's footer, a link to the full
 * inbox at `/notifications`.
 *
 * The bell owns the badge (its accessible name carries the unread count), the
 * recent list with a count chip on a folded row, mark-read and dismiss, and the
 * live stream. A row's link carries its circle (`?c=<circleId>`, written by the
 * event templates), so opening it switches the active circle first:
 * `useCircleLinkParam` in the shell layout.
 */

import { Button } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { NotificationBell as PlatformNotificationBell } from '@marinoscar/platform-web/notifications/ui';

export function NotificationBell() {
  return (
    <PlatformNotificationBell
      slots={{
        footer: ({ close }) => (
          <Button component={RouterLink} to="/notifications" onClick={close} fullWidth size="small">
            View all notifications
          </Button>
        ),
      }}
    />
  );
}

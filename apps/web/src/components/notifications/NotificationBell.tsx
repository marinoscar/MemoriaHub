/**
 * NotificationBell — AppBar bell + unread badge (issue #249).
 *
 * Reads the shared `useNotifications` store, so the count here and the count
 * on any other surface (#250's sidebar entry / `/notifications` page) come
 * from ONE 60s poller, not one per mount.
 *
 * A11Y: `aria-label` embeds the unread count so a screen reader announces
 * "Notifications, 3 unread" rather than just "Notifications" — the badge digit
 * itself is decorative markup a reader would otherwise read out of context.
 */

import { useCallback, useRef, useState } from 'react';
import { Badge, IconButton, Tooltip } from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import { useNotifications } from '../../hooks/useNotifications';
import { NotificationPanel } from './NotificationPanel';

/** Minimum comfortable touch target (WCAG 2.5.5 / Material). */
const TOUCH_TARGET = 44;

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const { unreadCount, refreshList } = useNotifications();

  const handleOpen = useCallback(() => {
    setOpen(true);
    // The list is fetched on demand, not polled — a closed bell costs only the
    // unread-count integer per minute.
    void refreshList();
  }, [refreshList]);

  const handleClose = useCallback(() => setOpen(false), []);

  const label =
    unreadCount > 0
      ? `Notifications, ${unreadCount} unread`
      : 'Notifications, no unread';

  return (
    <>
      <Tooltip title="Notifications">
        <IconButton
          ref={anchorRef}
          color="inherit"
          onClick={handleOpen}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open ? 'true' : undefined}
          sx={{ flexShrink: 0, width: TOUCH_TARGET, height: TOUCH_TARGET }}
        >
          <Badge
            badgeContent={unreadCount}
            color="error"
            max={99}
            overlap="circular"
            // The digit is presentational; the accessible name on the button
            // above already carries the count.
            slotProps={{ badge: { 'aria-hidden': true } }}
          >
            {unreadCount > 0 ? <NotificationsIcon /> : <NotificationsNoneIcon />}
          </Badge>
        </IconButton>
      </Tooltip>

      <NotificationPanel open={open} anchorEl={anchorRef.current} onClose={handleClose} />
    </>
  );
}

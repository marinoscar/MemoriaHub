/**
 * NotificationPanel — the bell's dropdown (issue #249).
 *
 * RESPONSIVE SHELL
 * ----------------
 * Below `sm` (<600px) the panel is a bottom `Drawer` sheet spanning the full
 * viewport width, because a ~380px floating card anchored to a toolbar icon on
 * a 360px phone is both cramped and clipped by the viewport edge. At `sm` and
 * up it is a `Popover` anchored to the bell. Only the shell differs — the
 * header / list / footer content is one shared subtree.
 *
 * CIRCLE-SWITCH-THEN-NAVIGATE
 * ---------------------------
 * The review-queue notifications carry circle-agnostic links (`/bursts`,
 * `/duplicates`, …) that render whatever circle is currently active. Tapping a
 * row for a NON-active circle therefore has to switch the active circle first,
 * or the user lands on the right page showing the wrong circle's data. We call
 * `CircleContext.setActiveCircle` (which also persists `activeCircleId` to user
 * settings) and then `navigate` in the same event handler: `setActiveCircle`
 * updates its React state synchronously before its first `await`, so both
 * updates land in one render batch and the destination mounts already scoped to
 * the new circle — no need to await the settings PATCH round-trip.
 */

import {
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  List,
  Popover,
  Skeleton,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useNotifications } from '../../hooks/useNotifications';
import { NotificationRow } from './NotificationRow';
import type { NotificationItem } from '../../types/notifications';

interface NotificationPanelProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

const PANEL_WIDTH = 380;

export function NotificationPanel({ open, anchorEl, onClose }: NotificationPanelProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const { circles, activeCircleId, setActiveCircle } = useCircle();

  const { items, hasLoadedList, error, unreadCount, markRead, dismiss, markAllRead } =
    useNotifications();

  const handleOpenNotification = (notification: NotificationItem) => {
    onClose();

    // Optimistic — the badge drops before the request resolves, and rolls back
    // inside the store if it fails.
    if (!notification.readAt) void markRead(notification.id);

    // Switch circle BEFORE navigating (see file header).
    //
    // The membership check guards the stale-row case: a notification can
    // outlive the user's access to its circle, and `setActiveCircle` would
    // happily persist an id that resolves to no circle at all, leaving the
    // whole app in a sticky "no active circle" state. `circles.length === 0`
    // is treated as "not loaded yet" rather than "member of nothing" — every
    // user always has a personal circle, so an empty list only ever means the
    // CircleContext init is still in flight.
    const circleKnown =
      circles.length === 0 || circles.some((c) => c.id === notification.circleId);

    if (notification.circleId && notification.circleId !== activeCircleId && circleKnown) {
      void setActiveCircle(notification.circleId);
    }

    if (notification.link) navigate(notification.link);
  };

  const handleSeeAll = () => {
    onClose();
    navigate('/notifications');
  };

  // ---------------------------------------------------------------------------
  // Shared content
  // ---------------------------------------------------------------------------

  const content = (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: isPhone ? '100%' : PANEL_WIDTH,
        maxWidth: '100%',
        maxHeight: isPhone ? '80vh' : 460,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 2,
          py: 1.5,
          flexShrink: 0,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Notifications
        </Typography>
        <Button
          size="small"
          onClick={() => void markAllRead()}
          disabled={unreadCount === 0}
          sx={{ minHeight: 36 }}
        >
          Mark all as read
        </Button>
      </Box>

      <Divider />

      {/* Body */}
      <Box sx={{ overflowY: 'auto', flexGrow: 1 }}>
        {error && (
          <Alert severity="error" sx={{ m: 2 }}>
            {error}
          </Alert>
        )}

        {/* Loading skeleton — shown until the FIRST list fetch resolves.
            Keyed off `hasLoadedList` rather than `isLoading` so it also covers
            the tick between the panel opening and `refreshList()` starting,
            and so later background refreshes swap rows in place instead of
            flashing the skeleton again. */}
        {!hasLoadedList && !error && (
          <Box sx={{ px: 2, py: 1.5 }} data-testid="notification-panel-skeleton">
            {[0, 1, 2].map((i) => (
              <Box key={i} sx={{ display: 'flex', gap: 1.5, py: 1 }}>
                <Skeleton variant="circular" width={32} height={32} />
                <Box sx={{ flexGrow: 1 }}>
                  <Skeleton variant="text" width="80%" />
                  <Skeleton variant="text" width="40%" />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {hasLoadedList && items.length === 0 && !error && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
              px: 3,
              py: 5,
              textAlign: 'center',
            }}
          >
            <NotificationsNoneIcon color="disabled" />
            <Typography variant="body2" color="text.secondary">
              You&apos;re all caught up
            </Typography>
          </Box>
        )}

        {hasLoadedList && items.length > 0 && (
          <List disablePadding>
            {items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onOpen={handleOpenNotification}
                onDismiss={(n) => void dismiss(n.id)}
              />
            ))}
          </List>
        )}
      </Box>

      <Divider />

      {/* Footer */}
      <Box sx={{ p: 1, flexShrink: 0 }}>
        {/* "See all notifications", not "See all": with the Notifications drawer
            row deleted (spec §3.3) this footer is the ONLY path to
            /notifications, so its label has to name the destination without
            relying on the surrounding popover for context. */}
        <Button fullWidth size="small" onClick={handleSeeAll} sx={{ minHeight: 40 }}>
          See all notifications
        </Button>
      </Box>
    </Box>
  );

  // ---------------------------------------------------------------------------
  // Phone: full-width bottom sheet
  // ---------------------------------------------------------------------------

  if (isPhone) {
    return (
      <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            'aria-label': 'Notifications',
            sx: {
              width: '100%',
              maxHeight: '80vh',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
            },
          },
        }}
      >
        {/* Grab handle */}
        <Box
          aria-hidden
          sx={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: 'divider',
            mx: 'auto',
            mt: 1,
          }}
        />
        {content}
      </Drawer>
    );
  }

  // ---------------------------------------------------------------------------
  // Tablet / desktop: anchored popover
  // ---------------------------------------------------------------------------

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        paper: {
          'aria-label': 'Notifications',
          sx: { mt: 1, width: PANEL_WIDTH, maxWidth: 'calc(100vw - 16px)' },
        },
      }}
    >
      {content}
    </Popover>
  );
}

/**
 * One row in the notification panel (issue #249).
 *
 * The dismiss (×) button is ALWAYS rendered and always hit-testable. It is
 * deliberately not a hover-reveal control: issue #243 shipped an `opacity: 0`
 * affordance that stayed clickable (and therefore invisible-but-tappable) on
 * touch devices. The rule this file follows is — if a control is visually
 * hidden it must also set `pointerEvents: 'none'` or be gated behind
 * `@media (hover: hover)`. Here we simply never hide it.
 */

import {
  Box,
  IconButton,
  ListItem,
  ListItemButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { relativeTime } from '../../utils/formatBytes';
import { notificationMeta } from './notificationMeta';
import type { NotificationItem } from '../../types/notifications';

interface NotificationRowProps {
  notification: NotificationItem;
  onOpen: (notification: NotificationItem) => void;
  onDismiss: (notification: NotificationItem) => void;
}

/** Minimum comfortable touch target (WCAG 2.5.5 / Material). */
const TOUCH_TARGET = 44;

export function NotificationRow({ notification, onOpen, onDismiss }: NotificationRowProps) {
  const meta = notificationMeta(notification.type);
  const isUnread = notification.readAt === null;

  return (
    <ListItem
      disablePadding
      // `secondaryAction` renders the dismiss button OUTSIDE the ListItemButton,
      // so tapping × never also triggers the row's navigate.
      secondaryAction={
        <Tooltip title="Dismiss">
          <IconButton
            edge="end"
            aria-label={`Dismiss notification: ${notification.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(notification);
            }}
            sx={{
              width: TOUCH_TARGET,
              height: TOUCH_TARGET,
              color: 'text.secondary',
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      }
      sx={{
        alignItems: 'stretch',
        backgroundColor: isUnread ? 'action.hover' : 'transparent',
      }}
    >
      <ListItemButton
        onClick={() => onOpen(notification)}
        sx={{
          alignItems: 'flex-start',
          gap: 1.5,
          // Leave room for the 44px secondaryAction so long titles don't run
          // underneath it.
          pr: `${TOUCH_TARGET + 8}px`,
          py: 1.25,
          minHeight: TOUCH_TARGET,
        }}
      >
        {/* Type icon */}
        <Box
          aria-hidden
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: 32,
            height: 32,
            borderRadius: '50%',
            mt: 0.25,
            color: `${meta.tone}.main`,
            backgroundColor: 'action.selected',
          }}
        >
          {meta.icon}
        </Box>

        {/* Text block */}
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography
            variant="body2"
            sx={{
              fontWeight: isUnread ? 600 : 400,
              // Two-line clamp — titles carry a circle name and can be long.
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {notification.title}
          </Typography>

          {notification.body && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {notification.body}
            </Typography>
          )}

          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.25 }}
          >
            {relativeTime(notification.createdAt)}
          </Typography>
        </Box>

        {/* Unread dot — announced via the visually-hidden text below it so the
            state is not conveyed by color alone. */}
        {isUnread && (
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', mt: 1 }}>
            <Box
              aria-hidden
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: 'primary.main',
              }}
            />
            <Box component="span" sx={visuallyHidden}>
              Unread
            </Box>
          </Box>
        )}
      </ListItemButton>
    </ListItem>
  );
}

/** Local copy of MUI's `visuallyHidden` style object (avoids a utils import). */
const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute' as const,
  whiteSpace: 'nowrap' as const,
  width: '1px',
};

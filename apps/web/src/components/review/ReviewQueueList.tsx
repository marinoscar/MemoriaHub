/**
 * The Review inbox, as a queue list — the one model at every breakpoint.
 *
 * Spec §4.5. Deliberately a standalone component rather than markup inside
 * `ReviewHubPage`: issue #392 mounts THIS component as the desktop context pane,
 * and a second implementation there would let count-refresh, row order and
 * feature gating drift between the two surfaces that are supposed to be the same
 * list at two sizes.
 *
 * Not tabs, and not a segmented control, at any width — see the rationale in
 * `config/reviewQueues.tsx`.
 */

import {
  Box,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material';
import { CheckCircleOutlined as CheckCircleOutlinedIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { LoadingSpinner } from '../common/LoadingSpinner';
import type { ReviewQueueKey } from '../../config/reviewQueues';
import type { ResolvedReviewQueue } from '../../hooks/useReviewQueues';
import { useReviewQueues } from '../../hooks/useReviewQueues';

export interface ReviewQueueListProps {
  /**
   * `hub` is the full-width list on the hub page; `pane` is the denser
   * treatment #392 will mount beside the queue on desktop. The difference is
   * density only — the contents, order and gating are identical by design.
   */
  variant?: 'hub' | 'pane';
  /** Fired in addition to (not instead of) navigation; #392 uses it to close/scroll. */
  onNavigate?: (entry: ResolvedReviewQueue) => void;
  /** Which entry is currently being viewed, for the pane's selected state. */
  activeKey?: ReviewQueueKey | null;
}

/** The route a row points at. Rows always go through the hub's own namespace. */
export function reviewQueuePath(key: ReviewQueueKey): string {
  return `/review/${key}`;
}

/**
 * A drained queue reads as an em dash, never "0" (spec §4.5 requirement 4).
 * `null` — not applicable, or not loaded yet — reads the same way, since in both
 * cases there is no number worth showing.
 */
function countLabel(count: number | null): string {
  return count && count > 0 ? String(count) : '—';
}

/**
 * The accessible name carries the count, because a badge must never be the sole
 * carrier of meaning (spec §7). Secondary entries have no count to carry.
 */
function accessibleName(entry: ResolvedReviewQueue): string {
  if (entry.countKey === null) return entry.label;
  if (entry.count === null) return entry.label;
  if (entry.count === 0) return `${entry.label}, none pending`;
  return `${entry.label}, ${entry.count} pending`;
}

function QueueRow({
  entry,
  variant,
  active,
  onNavigate,
}: {
  entry: ResolvedReviewQueue;
  variant: 'hub' | 'pane';
  active: boolean;
  onNavigate?: (entry: ResolvedReviewQueue) => void;
}) {
  const { Icon } = entry;
  const pending = entry.count !== null && entry.count > 0;

  return (
    <ListItem disablePadding>
      {/* A real link: focusable, middle-clickable, and it survives a keyboard
          user tabbing the list — an onClick div would give up all three. */}
      <ListItemButton
        component={RouterLink}
        to={reviewQueuePath(entry.key)}
        selected={active}
        aria-current={active ? 'page' : undefined}
        aria-label={accessibleName(entry)}
        onClick={() => onNavigate?.(entry)}
        sx={{
          borderRadius: 1,
          py: variant === 'pane' ? 0.5 : 1,
          // Every flex item needs an explicit floor: `min-width` defaults to
          // `auto`, so a long label would otherwise set a hard min-content width
          // on the whole column (issue #291).
          minWidth: 0,
        }}
      >
        <ListItemIcon sx={{ minWidth: variant === 'pane' ? 36 : 44 }}>
          <Icon fontSize={variant === 'pane' ? 'small' : 'medium'} />
        </ListItemIcon>
        <ListItemText
          primary={entry.label}
          slotProps={{
            primary: { variant: variant === 'pane' ? 'body2' : 'body1', noWrap: true },
          }}
          sx={{ minWidth: 0, my: 0 }}
        />
        {entry.countKey !== null && (
          <Typography
            component="span"
            // The name above already says "4 pending"; announcing the bare
            // numeral again would just be noise.
            aria-hidden
            variant={variant === 'pane' ? 'body2' : 'body1'}
            sx={{
              ml: 1,
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
              fontWeight: pending ? 600 : 400,
              color: pending ? 'text.primary' : 'text.disabled',
            }}
          >
            {countLabel(entry.count)}
          </Typography>
        )}
      </ListItemButton>
    </ListItem>
  );
}

export function ReviewQueueList({
  variant = 'hub',
  onNavigate,
  activeKey = null,
}: ReviewQueueListProps) {
  const { entries, anyEnabled, isLoading } = useReviewQueues();

  const queues = entries.filter((entry) => entry.group === 'queue');
  const secondary = entries.filter((entry) => entry.group === 'secondary');

  // Every queue drained. `count === 0` and not `!count`, so a queue whose count
  // has not loaded (null) cannot masquerade as drained and flash the payoff
  // state before the numbers arrive.
  const allClear = queues.length > 0 && queues.every((entry) => entry.count === 0);

  // Render nothing until BOTH the flags and the counts have answered. Each
  // half has its own flash to avoid: a partially-resolved entry list pops rows
  // in as flags land, and a resolved row with an unloaded count renders as an
  // em dash — which in this list means "drained", i.e. it would state the
  // opposite of the truth for as long as the request is in flight.
  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Defensive: `insights` carries no feature flag, so today this cannot happen.
  // It is kept because it is the correct response if that ever changes, and
  // because the alternative — silently rendering an empty box — is unreadable.
  if (!anyEnabled) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body1" sx={{ mb: 0.5 }}>
          No review features are enabled
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Bursts, duplicates, location suggestions and AI enhancements are turned
          on by an administrator.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      {queues.length === 0 ? (
        // Every queue-producing feature is off, but Insights/Automations below
        // still resolve. Say so, rather than leaving a bare divider floating
        // above them with nothing on the other side of it.
        <Box sx={{ py: 3, px: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            No review queues are enabled.
          </Typography>
        </Box>
      ) : allClear ? (
        // Not four rows of "0" — one confident state (spec §4.5 requirement 4).
        // This is the payoff that makes clearing a backlog feel like something.
        <Box sx={{ py: variant === 'pane' ? 3 : 6, px: 2, textAlign: 'center' }}>
          <CheckCircleOutlinedIcon
            color="success"
            sx={{ fontSize: variant === 'pane' ? 32 : 48, mb: 1 }}
          />
          <Typography variant={variant === 'pane' ? 'subtitle1' : 'h6'} sx={{ mb: 0.5 }}>
            You&apos;re all caught up
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Nothing waiting on you. New suggestions appear here after your next
            import.
          </Typography>
        </Box>
      ) : (
        <List dense={variant === 'pane'} disablePadding>
          {queues.map((entry) => (
            <QueueRow
              key={entry.key}
              entry={entry}
              variant={variant}
              active={activeKey === entry.key}
              onNavigate={onNavigate}
            />
          ))}
        </List>
      )}

      {secondary.length > 0 && (
        <>
          {/* Insights is analytics and Automations is configuration — neither is
              a queue, so both survive an empty inbox unchanged. */}
          <Divider sx={{ my: 1 }} />
          <List dense={variant === 'pane'} disablePadding>
            {secondary.map((entry) => (
              <QueueRow
                key={entry.key}
                entry={entry}
                variant={variant}
                active={activeKey === entry.key}
                onNavigate={onNavigate}
              />
            ))}
          </List>
        </>
      )}
    </Box>
  );
}

export default ReviewQueueList;

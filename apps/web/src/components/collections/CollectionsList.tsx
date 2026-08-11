/**
 * Collections as a list — the Collections analogue of `ReviewQueueList`.
 *
 * Spec §4.6. Deliberately a standalone component rather than markup inside
 * `CollectionsHubPage`, for exactly the reason `ReviewQueueList` is: issue #392
 * mounts THIS component as the desktop context pane, and a second
 * implementation there would let row order, feature gating and count refresh
 * drift between two surfaces that are supposed to be the same list at two
 * sizes.
 *
 * The two hubs must not drift into different interaction models either, so the
 * props, the row anatomy and the accessible-name rule below are the same shape
 * `ReviewQueueList` already established.
 */

import { Box, Divider, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { CollectionDef, CollectionKey } from '../../config/collections';
import { useCollectionSummaries } from '../../hooks/useCollectionSummaries';
import type { CollectionCount, CollectionSummary } from '../../hooks/useCollectionSummaries';

export interface CollectionsListProps {
  /**
   * `hub` is the full-width list; `pane` is the denser treatment #392 will
   * mount beside the content on desktop. The difference is density only — the
   * contents, order and gating are identical by design.
   */
  variant?: 'hub' | 'pane';
  /** Fired in addition to (not instead of) navigation; #392 uses it to close/scroll. */
  onNavigate?: (entry: CollectionDef) => void;
  /** Which entry is currently being viewed, for the pane's selected state. */
  activeKey?: CollectionKey | null;
}

/**
 * The count this entry should show, or `null` for "no number here".
 *
 * `null` covers three situations on purpose — sourceless (Map), still loading,
 * and failed — because all three render identically: label only. A count is
 * never invented to fill the gap.
 *
 * The three display helpers below live here, beside this one, so the card grid
 * and the list render the SAME number and the SAME accessible name from the
 * SAME value. Two surfaces formatting one count independently is exactly how
 * they would come to disagree.
 */
export function collectionCount(
  entry: CollectionDef,
  summaries: Record<string, CollectionSummary | undefined>,
): CollectionCount | null {
  if (entry.source === null) return null;
  const summary = summaries[entry.source];
  if (!summary || summary.status !== 'ready') return null;
  return summary.count;
}

/** The visible label. An approximate count is a floor, so it reads "50+". */
export function formatCollectionCount(count: CollectionCount): string {
  return count.approximate ? `${count.value}+` : String(count.value);
}

/**
 * The accessible name carries the count, because a count must never be the sole
 * carrier of meaning (spec §7) — "Albums, 24 items".
 *
 * An approximate count must stay truthful here too: "50 or more items", never
 * the "50 items" a naive read of the numeral would produce. The visible "+" is
 * not something a screen reader can be relied on to announce.
 */
export function collectionAccessibleName(
  entry: CollectionDef,
  count: CollectionCount | null,
): string {
  if (count === null) return entry.label;
  if (count.approximate) return `${entry.label}, ${count.value} or more items`;
  return `${entry.label}, ${count.value} ${count.value === 1 ? 'item' : 'items'}`;
}

function CollectionRow({
  entry,
  count,
  variant,
  active,
  onNavigate,
}: {
  entry: CollectionDef;
  count: CollectionCount | null;
  variant: 'hub' | 'pane';
  active: boolean;
  onNavigate?: (entry: CollectionDef) => void;
}) {
  const { Icon } = entry;

  return (
    <ListItem disablePadding>
      {/* A real link: focusable, middle-clickable, and it survives a keyboard
          user tabbing the list — an onClick div would give up all three. */}
      <ListItemButton
        component={RouterLink}
        to={entry.path}
        selected={active}
        aria-current={active ? 'page' : undefined}
        aria-label={collectionAccessibleName(entry, count)}
        onClick={() => onNavigate?.(entry)}
        sx={{
          borderRadius: 1,
          py: variant === 'pane' ? 0.5 : 1,
          // Every flex item needs an explicit floor: `min-width` defaults to
          // `auto`, so a long label would otherwise set a hard min-content
          // width on the whole column (issue #291).
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
        {count !== null && (
          <Typography
            component="span"
            // The accessible name above already says "24 items"; announcing the
            // bare numeral again would just be noise.
            aria-hidden
            variant={variant === 'pane' ? 'body2' : 'body1'}
            sx={{
              ml: 1,
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
              color: 'text.secondary',
            }}
          >
            {formatCollectionCount(count)}
          </Typography>
        )}
      </ListItemButton>
    </ListItem>
  );
}

export function CollectionsList({
  variant = 'hub',
  onNavigate,
  activeKey = null,
}: CollectionsListProps) {
  // One hook, so the list and the grid can never disagree about which entries
  // exist or what the counts are.
  const { entries, summaries } = useCollectionSummaries();

  const primary = entries.filter((entry) => entry.group === 'primary');
  const secondary = entries.filter((entry) => entry.group === 'secondary');

  // No loading gate, deliberately — unlike `ReviewQueueList`, which must wait
  // because an unloaded count there renders as an em dash meaning "drained",
  // i.e. the opposite of the truth. Here an unloaded count simply renders no
  // number, which is never wrong, so the rows go up immediately.
  return (
    <Box sx={{ minWidth: 0 }}>
      <List dense={variant === 'pane'} disablePadding>
        {primary.map((entry) => (
          <CollectionRow
            key={entry.key}
            entry={entry}
            count={collectionCount(entry, summaries)}
            variant={variant}
            active={activeKey === entry.key}
            onNavigate={onNavigate}
          />
        ))}
      </List>

      {secondary.length > 0 && (
        <>
          {/* Favorites / Archive / Trash are lower-frequency, and Trash in
              particular must never read as a primary browse target (§4.6). */}
          <Divider sx={{ my: 1 }} />
          <List dense={variant === 'pane'} disablePadding>
            {secondary.map((entry) => (
              <CollectionRow
                key={entry.key}
                entry={entry}
                count={collectionCount(entry, summaries)}
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

export default CollectionsList;

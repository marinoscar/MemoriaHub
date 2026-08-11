/**
 * `/collections` — the Collections hub (issue #391, spec §3.1 / §4.6 / §6.1).
 *
 * This is the one screen in the epic that SPENDS a tap: Albums, People and Map
 * each move one level deeper than they were. Spec §6.1 states the kill
 * criterion plainly — "if Collections ships as a text list, this proposal makes
 * the app worse" — so real cover imagery and live counts are requirements here,
 * not decoration.
 *
 * TWO SURFACES, ONE MODEL (§4.6), resolved exactly the way the Review hub
 * resolves it:
 *
 *   phone   (< md)  →  the card grid, 2 columns
 *   tablet  (md–lg) →  the same card grid, 3 columns
 *   desktop (≥ lg)  →  NO grid. Redirect to `/albums`.
 *
 * The desktop redirect is the part most likely to be "fixed" by a later reader,
 * so: #392's context pane already lists every collection with its live count,
 * and a card grid beside that pane is a menu next to a menu. Landing straight
 * in Albums puts photos on screen in zero clicks — mirroring `/review` → first
 * queue. It is also what makes §6.1 coherent: the extra tap exists only where
 * the expensive cover art is built to offset it, and desktop pays no tap at
 * all.
 *
 * PERFORMANCE CONTRACT: the layout renders immediately and covers fill in
 * progressively. There is no full-page spinner and no `Promise.all` — see
 * `useCollectionSummaries`, where the four requests are deliberately kept
 * independent so one slow or failed source degrades exactly one card.
 *
 * NOTE ON CSS CONTAINMENT (issue #291): a cover-image card grid is precisely
 * the component shape that caused the runaway-width bug, so this file uses no
 * `content-visibility` / `contain-intrinsic-size` at all, and every flex/grid
 * item carries `minWidth: 0`. If containment is ever added here it must use the
 * `containIntrinsicWidth` / `containIntrinsicHeight` LONGHANDS — the shorthand
 * with a single length sizes BOTH axes.
 */

import { Box, Divider, Skeleton, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import type { CollectionDef } from '../../config/collections';
// The count, its visible label and its accessible name all come from
// `CollectionsList`'s helpers rather than being re-derived here, so the grid and
// the list (and #392's pane) cannot render one collection two different ways.
import {
  collectionAccessibleName,
  collectionCount,
  formatCollectionCount,
} from '../../components/collections/CollectionsList';
import { PersonAvatar } from '../../components/people/PersonAvatar';
import { useCollectionSummaries } from '../../hooks/useCollectionSummaries';
import type { CollectionCount, CollectionSummary } from '../../hooks/useCollectionSummaries';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';

/** Where a desktop visit to `/collections` actually lands. First primary entry. */
const DESKTOP_LANDING_PATH = '/albums';

// ---------------------------------------------------------------------------
// Cover treatments
// ---------------------------------------------------------------------------

/**
 * The cover area of a card. Four treatments, one per state — and the fallback
 * ladder matters: a card must never render a broken image well, or an empty
 * grey box that reads as a failure when the library is simply empty.
 */
function CoverArea({
  entry,
  summary,
}: {
  entry: CollectionDef;
  summary: CollectionSummary | undefined;
}) {
  const { Icon } = entry;

  const frameSx = {
    position: 'relative' as const,
    width: '100%',
    aspectRatio: '1 / 1',
    borderRadius: 2,
    overflow: 'hidden',
    bgcolor: 'action.hover',
    minWidth: 0,
  };

  // Sourceless entry (Map). A tasteful icon plate, never a broken cover.
  if (entry.source === null) {
    return (
      <Box
        sx={{
          ...frameSx,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: (theme) =>
            `linear-gradient(135deg, ${theme.palette.action.hover}, ${theme.palette.action.selected})`,
        }}
      >
        <Icon sx={{ fontSize: 44, color: 'text.secondary' }} />
      </Box>
    );
  }

  // Still in flight. A skeleton the exact size of the eventual cover, so the
  // grid does not reflow when the photos land.
  if (!summary || summary.status === 'loading') {
    return <Skeleton variant="rounded" sx={{ ...frameSx, bgcolor: undefined }} />;
  }

  // This one source failed. Its own icon, and (via `collectionCount`) no count.
  // The other cards are untouched.
  if (summary.status === 'error') {
    return (
      <Box
        sx={{ ...frameSx, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon sx={{ fontSize: 44, color: 'text.disabled' }} />
      </Box>
    );
  }

  // People render through `PersonAvatar`, which already resolves the face crop,
  // the profile-picture override and the video frame-thumbnail fallback. A row
  // of faces reads as "People" in a way a square photo mosaic never does.
  if (entry.source === 'people' && summary.people.length > 0) {
    const faces = summary.people.slice(0, 4);
    return (
      <Box
        sx={{
          ...frameSx,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 1,
        }}
      >
        <Box sx={{ display: 'flex', minWidth: 0 }}>
          {faces.map((person, index) => (
            <Box
              key={person.id}
              sx={{
                // Overlapped, like a stacked avatar group — it fits four faces
                // into a card that is only half a phone wide.
                ml: index === 0 ? 0 : -1.5,
                borderRadius: '50%',
                border: (theme) => `2px solid ${theme.palette.background.paper}`,
                flexShrink: 0,
                lineHeight: 0,
              }}
            >
              <PersonAvatar person={person} size={44} />
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  const covers = summary.coverUrls;

  // Nothing to show: the collection is genuinely empty. Say so with the entry's
  // own icon rather than an ambiguous blank plate.
  if (covers.length === 0) {
    return (
      <Box sx={{ ...frameSx, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon sx={{ fontSize: 44, color: 'text.disabled' }} />
      </Box>
    );
  }

  // Four covers → a 2x2 mosaic, which reads far better than one thumbnail
  // stretched to a square. Fewer than four → a single cover, because a 2x2 with
  // holes in it looks broken.
  const mosaic = covers.length >= 4 ? covers.slice(0, 4) : null;

  return (
    <Box
      sx={{
        ...frameSx,
        display: 'grid',
        gridTemplateColumns: mosaic ? '1fr 1fr' : '1fr',
        gridTemplateRows: mosaic ? '1fr 1fr' : '1fr',
        gap: mosaic ? '2px' : 0,
      }}
    >
      {(mosaic ?? covers.slice(0, 1)).map((url, index) => (
        <Box
          key={`${url}-${index}`}
          component="img"
          src={url}
          alt=""
          // The card's `aria-label` already names the collection; the tiles are
          // decorative, so they stay out of the accessibility tree entirely.
          aria-hidden
          loading="lazy"
          decoding="async"
          sx={{
            width: '100%',
            height: '100%',
            minWidth: 0,
            objectFit: 'cover',
            display: 'block',
            bgcolor: 'action.hover',
          }}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CollectionCard({
  entry,
  summary,
  count,
}: {
  entry: CollectionDef;
  summary: CollectionSummary | undefined;
  count: CollectionCount | null;
}) {
  return (
    <Box
      component={RouterLink}
      to={entry.path}
      aria-label={collectionAccessibleName(entry, count)}
      sx={{
        display: 'block',
        minWidth: 0,
        textDecoration: 'none',
        color: 'inherit',
        borderRadius: 2,
        // Keyboard focus needs a visible state on every navigation control
        // (spec §7); the default outline is suppressed by the reset, so it is
        // restored explicitly here.
        '&:focus-visible': {
          outline: (theme) => `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
        '&:hover img': { opacity: 0.88 },
      }}
    >
      <CoverArea entry={entry} summary={summary} />
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 0.75,
          mt: 0.75,
          minWidth: 0,
        }}
      >
        <Typography variant="subtitle2" noWrap sx={{ minWidth: 0, fontWeight: 600 }}>
          {entry.label}
        </Typography>
        {count !== null && (
          <Typography
            variant="caption"
            // The link's accessible name already carries the count.
            aria-hidden
            sx={{ color: 'text.secondary', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
          >
            {formatCollectionCount(count)}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function SecondaryLink({ entry }: { entry: CollectionDef }) {
  const { Icon } = entry;
  return (
    <Box
      component={RouterLink}
      to={entry.path}
      aria-label={entry.label}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minWidth: 0,
        px: 1.5,
        py: 0.75,
        borderRadius: 5,
        border: (theme) => `1px solid ${theme.palette.divider}`,
        textDecoration: 'none',
        color: 'text.secondary',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': {
          outline: (theme) => `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
      }}
    >
      <Icon fontSize="small" />
      <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
        {entry.label}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------

export default function CollectionsHubPage() {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));

  // Hooks run unconditionally, above the redirect branch. Restoration is a
  // no-op on desktop, where this page never paints a scrollable grid.
  useScrollRestoration('collections-hub', { enabled: !isDesktop });
  const { entries, summaries } = useCollectionSummaries();

  if (isDesktop) {
    // `replace`, so Back from Albums returns to wherever the user actually came
    // from rather than bouncing through a route that immediately redirects
    // again — the same trap the admin drill-down redirects avoid.
    return <Navigate to={DESKTOP_LANDING_PATH} replace />;
  }

  const primary = entries.filter((entry) => entry.group === 'primary');
  const secondary = entries.filter((entry) => entry.group === 'secondary');

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Collections
      </Typography>

      <Box
        sx={{
          display: 'grid',
          // Phone 2 columns, tablet 3 (spec §4.6). No `auto-fill` — the column
          // count is a design decision per breakpoint, not a function of a
          // minimum card width.
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' },
          gap: { xs: 1.5, md: 2 },
          // Belt and braces against issue #291: a grid item's implicit minimum
          // size is `auto`, so a wide child could otherwise push the track (and
          // the app shell) past the viewport.
          minWidth: 0,
        }}
      >
        {primary.map((entry) => (
          <CollectionCard
            key={entry.key}
            entry={entry}
            summary={entry.source ? summaries[entry.source] : undefined}
            count={collectionCount(entry, summaries)}
          />
        ))}
      </Box>

      {secondary.length > 0 && (
        <>
          {/* Lower-frequency destinations, and Trash must never read as a
              primary browse target (§4.6) — hence no cover art here. */}
          <Divider sx={{ my: 2.5 }} />
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
            {secondary.map((entry) => (
              <SecondaryLink key={entry.key} entry={entry} />
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}

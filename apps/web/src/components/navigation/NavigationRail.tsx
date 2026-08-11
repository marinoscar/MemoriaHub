/**
 * The navigation rail — tablet and desktop chrome for the four destinations.
 *
 * Issue #392, epic #388, spec §4.2 / §4.3. This REPLACES `Sidebar`'s 240px
 * drawer at `sm` and up. Material 3 deprecated the navigation drawer in favour
 * of the rail for exactly the reason that matters here: a rail is always
 * visible, so navigating costs ZERO taps, where a drawer costs one before
 * navigation can even begin (spec §2.2).
 *
 * TWO TREATMENTS, ONE COMPONENT
 * -----------------------------
 *   medium  (sm–lg)  →  collapsed, ~56px, icon over a short label
 *   expanded (≥ lg)  →  expanded, 220px, labelled rows + numeric Review badge
 *                       + a PINNED group + a collapse toggle
 *
 * A desktop user may collapse the rail to the tablet treatment; the choice
 * persists in `user_settings.navigation.railCollapsed`.
 *
 * WHY SEARCH IS NOT IN THE RAIL — do not "fix" this
 * -------------------------------------------------
 * Search is one of the four destinations at every breakpoint, but at `sm` and
 * up it is carried by the TOP BAR's search pill rather than by the rail, and so
 * gives up its rail slot (spec §4.2). This is the one place the destination set
 * differs by form factor and it is deliberate: below `sm` Search is a bottom-bar
 * tab (which is what freed the top bar of its search field on a 360px screen),
 * and at `sm` and up there is width in the toolbar for a real search input,
 * which beats a rail row that only routes to one. Adding Search here would also
 * make the desktop collapse toggle lossy — collapsing "to the tablet treatment"
 * would then silently drop a destination.
 *
 * CONSOLE MODE — and where it deliberately stops
 * ----------------------------------------------
 * At any `/admin/*` route the rail swaps its CONTENTS (spec §3.2), promoting
 * `SettingsHubPage`'s five permission-gated sections from a page into
 * navigation, so an admin-to-admin move no longer routes back through a landing
 * screen. It swaps ONLY WHEN EXPANDED. A 56px column cannot host 23 labelled
 * rows in five groups, and 23 near-identical unlabelled icons is worse than no
 * rail swap at all — so a collapsed rail keeps LIBRARY navigation with Console
 * marked active, and `SettingsHubPage` is the navigation. That is precisely
 * spec §4.4's phone rationale ("there is no rail to swap, so the admin surface
 * is a drill-down"), applied to the other size class that has no room either,
 * and it preserves §4.4 requirement 2 — the user is always one click out of the
 * admin surface.
 */

import { useMemo } from 'react';
import {
  Badge,
  Box,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import {
  Home as HomeIcon,
  Collections as CollectionsIcon,
  FactCheck as FactCheckIcon,
  AdminPanelSettings as AdminIcon,
  ArrowBack as ArrowBackIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useReviewQueues } from '../../hooks/useReviewQueues';
import { useNavigationPrefs, usePinnedDestinations } from '../../hooks/useNavigationPrefs';
import { owns, resolveActiveDestination } from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';
import { ADMIN_HUB_PATH, visibleAdminSections } from '../../config/adminSections';

/**
 * ~52px per spec §4.2, rounded to 56 so a 24px icon clears 16px of horizontal
 * padding without the caption below it wrapping on a two-syllable label.
 */
export const RAIL_WIDTH_COLLAPSED = 56;
export const RAIL_WIDTH_EXPANDED = 220;

/** The AppBar's `Toolbar` height at `sm` and up (MUI's default Toolbar steps to
 * 64px at exactly that breakpoint), which is the only place the rail renders. */
const APPBAR_HEIGHT = 64;

interface RailRowProps {
  to: string;
  Icon: SvgIconComponent;
  /** Shown when expanded. */
  label: string;
  /**
   * Shown when collapsed, where 56px will not hold "Collections". The visible
   * text is `aria-hidden` and the FULL label travels in `accessibleName`, which
   * is spec §7's "expose the label to assistive technology even when collapsed".
   */
  compactLabel?: string;
  /** Full accessible name; carries the badge count when there is one (spec §7). */
  accessibleName: string;
  active: boolean;
  expanded: boolean;
  /** Pending-work count, or `null` for rows that carry none. */
  badgeCount?: number | null;
}

function RailRow({
  to,
  Icon,
  label,
  compactLabel,
  accessibleName,
  active,
  expanded,
  badgeCount = null,
}: RailRowProps) {
  const theme = useTheme();
  const pending = badgeCount !== null && badgeCount > 0;

  const button = (
    // A real link: focusable, middle-clickable, and it survives a keyboard user
    // tabbing the rail — an onClick div would give up all three.
    <ListItemButton
      component={RouterLink}
      to={to}
      selected={active}
      // `selected` is a visual state only; assistive technology needs the
      // explicit landmark (spec §7).
      aria-current={active ? 'page' : undefined}
      aria-label={accessibleName}
      sx={{
        borderRadius: 1,
        mx: 0.5,
        // `min-width: auto` on a flex item is a hard floor at its min-content
        // width, so one long label would widen the rail — and, through it, the
        // whole app shell (issue #291).
        minWidth: 0,
        ...(expanded
          ? { py: 0.75 }
          : {
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.25,
              px: 0.5,
              py: 0.75,
            }),
        // Keyboard focus must be visible on every navigation control (spec §7).
        // Stated explicitly rather than relying on the theme's default, which a
        // later theme change could quietly remove.
        '&.Mui-focusVisible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
      }}
    >
      <ListItemIcon
        sx={{
          color: active ? theme.palette.primary.main : theme.palette.text.secondary,
          minWidth: expanded ? 40 : 'auto',
          justifyContent: 'center',
        }}
      >
        {/* Collapsed has no room for a numeral, so the badge degrades to a dot.
            The count is not lost — it is in `accessibleName`, which is the whole
            point of spec §7's "a badge is never the sole carrier of meaning". */}
        {!expanded && pending ? (
          <Badge variant="dot" color="primary" overlap="circular">
            <Icon fontSize="small" />
          </Badge>
        ) : (
          <Icon fontSize={expanded ? 'medium' : 'small'} />
        )}
      </ListItemIcon>

      {expanded ? (
        <>
          <ListItemText
            primary={label}
            slotProps={{ primary: { variant: 'body2', noWrap: true } }}
            sx={{ minWidth: 0, my: 0 }}
          />
          {pending && (
            <Typography
              component="span"
              // The name already says "12 items pending"; announcing the bare
              // numeral again is noise.
              aria-hidden
              variant="caption"
              sx={{
                ml: 1,
                flexShrink: 0,
                px: 0.75,
                borderRadius: 5,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                color: theme.palette.primary.contrastText,
                backgroundColor: theme.palette.primary.main,
              }}
            >
              {badgeCount > 99 ? '99+' : badgeCount}
            </Typography>
          )}
        </>
      ) : (
        <Typography
          aria-hidden
          variant="caption"
          noWrap
          sx={{
            fontSize: '0.625rem',
            lineHeight: 1.2,
            maxWidth: '100%',
            color: active ? theme.palette.primary.main : theme.palette.text.secondary,
          }}
        >
          {compactLabel ?? label}
        </Typography>
      )}
    </ListItemButton>
  );

  return (
    <ListItem disablePadding sx={{ minWidth: 0 }}>
      {/* A tooltip only where the visible text is abbreviated. It is a pointer
          affordance on top of the accessible name, never a substitute for it. */}
      {expanded ? button : <Tooltip title={label} placement="right">{button}</Tooltip>}
    </ListItem>
  );
}

interface RailDestinationDef {
  key: DestinationKey;
  label: string;
  compactLabel: string;
  Icon: SvgIconComponent;
  path: string;
}

/**
 * The rail's destination set. Photos, Collections, Review — Search is
 * deliberately absent, see the file header.
 */
const RAIL_DESTINATIONS: readonly RailDestinationDef[] = [
  { key: 'photos', label: 'Photos', compactLabel: 'Photos', Icon: HomeIcon, path: '/' },
  {
    key: 'collections',
    label: 'Collections',
    compactLabel: 'Collect',
    Icon: CollectionsIcon,
    path: '/collections',
  },
  {
    key: 'review',
    label: 'Review',
    compactLabel: 'Review',
    Icon: FactCheckIcon,
    path: '/review',
  },
];

export function NavigationRail() {
  const theme = useTheme();
  const { pathname } = useLocation();
  const { isAdmin, hasPermission } = usePermissions();
  // ONE `useReviewQueues` for the whole rail — the aggregate badge and the pin
  // resolver both read this instance. `useReviewCounts` beneath it deliberately
  // does not dedupe requests across consumers, so a second call here would
  // double every counts fetch.
  const { totalPending, entries: reviewEntries } = useReviewQueues();
  const { pinned, railCollapsed, toggleRailCollapsed } = useNavigationPrefs();
  const pinnedEntries = usePinnedDestinations(pinned, reviewEntries);

  // The rail is mounted by `Layout` only at `sm` and up (issue #402), so this
  // distinguishes the two rail treatments, not "is there a rail at all". It
  // stays at `lg`: lowering the EXPANDED tier toward M3's 840dp is a separate
  // design decision, deliberately not bundled with #402's rail-threshold fix.
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));

  // The medium tier is ALWAYS collapsed — the preference is a desktop
  // affordance, and honouring it below `lg` would let a stale
  // `railCollapsed: false` render a 220px rail on a 600px screen.
  const expanded = isDesktop && !railCollapsed;

  const isConsole = owns('/admin', pathname);
  // Console mode needs room for 23 labelled rows in five groups; see the file
  // header for why a collapsed rail keeps Library navigation instead.
  const consoleMode = isConsole && expanded && isAdmin;

  const activeDestination = resolveActiveDestination(pathname);

  const consoleSections = useMemo(
    () => (consoleMode ? visibleAdminSections(hasPermission) : []),
    [consoleMode, hasPermission],
  );

  // Console paths genuinely nest (`/admin/settings/jobs` vs
  // `/admin/settings/jobs/insights`), so `owns` alone would light up TWO rows
  // and emit `aria-current="page"` twice. Longest prefix wins (spec §3.5).
  const consoleActivePath = useMemo(() => {
    if (!consoleMode) return null;
    return consoleSections
      .flatMap((section) => section.cards)
      .reduce<string | null>((best, card) => {
        if (!card.path || card.disabled) return best;
        if (!owns(card.path, pathname)) return best;
        return best === null || card.path.length > best.length ? card.path : best;
      }, null);
  }, [consoleMode, consoleSections, pathname]);

  const subheaderSx = {
    fontSize: '0.65rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: theme.palette.text.disabled,
    lineHeight: '2rem',
    backgroundColor: 'transparent',
  };

  return (
    <Box
      component="nav"
      // Spec §7: the rail is a landmark with an accessible name. The name says
      // which mode it is in, because in Console mode its contents are entirely
      // different and a screen-reader user landing on "Main navigation" full of
      // admin pages would have no way to tell.
      aria-label={consoleMode ? 'Console navigation' : 'Main navigation'}
      sx={{
        width: expanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COLLAPSED,
        flexShrink: 0,
        // Load-bearing, not cosmetic (issue #291): without it a long admin card
        // title inside the rail sets a min-content floor that widens the shell.
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.palette.background.paper,
        borderRight: `1px solid ${theme.palette.divider}`,
        // Sticky rather than fixed, so the rail participates in the shell's flex
        // row and `main` does not need a hard-coded left offset that would drift
        // from the width above.
        position: 'sticky',
        top: APPBAR_HEIGHT,
        alignSelf: 'flex-start',
        height: `calc(100vh - ${APPBAR_HEIGHT}px)`,
        '@supports (height: 100dvh)': {
          height: `calc(100dvh - ${APPBAR_HEIGHT}px)`,
        },
        overflowY: 'auto',
        overflowX: 'hidden',
        transition: theme.transitions.create('width', {
          duration: theme.transitions.duration.shorter,
        }),
        // Spec §7. A 168px width animation is exactly the kind of motion that
        // triggers vestibular discomfort, and the toggle works identically
        // without it.
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
        },
      }}
    >
      {consoleMode ? (
        <Box sx={{ flexGrow: 1, py: 1, minWidth: 0 }}>
          {/* Console is a MODE, so the way out must be permanent and obvious —
              never a route the user has to guess at (spec §3.2). */}
          <List dense disablePadding>
            <RailRow
              to="/"
              Icon={ArrowBackIcon}
              label="Back to library"
              accessibleName="Back to library"
              active={false}
              expanded
            />
          </List>
          <Divider sx={{ my: 1 }} />

          {consoleSections.map((section) => (
            <List
              key={section.label}
              dense
              disablePadding
              subheader={
                <ListSubheader disableSticky sx={subheaderSx}>
                  {section.label}
                </ListSubheader>
              }
            >
              {section.cards.map((card) =>
                !card.path || card.disabled ? null : (
                  <RailRow
                    key={card.path}
                    to={card.path}
                    Icon={card.Icon}
                    label={card.title}
                    accessibleName={card.title}
                    active={card.path === consoleActivePath}
                    expanded
                  />
                ),
              )}
            </List>
          ))}
        </Box>
      ) : (
        <Box sx={{ flexGrow: 1, py: 1, minWidth: 0 }}>
          <List dense disablePadding>
            {RAIL_DESTINATIONS.map((destination) => {
              const isReview = destination.key === 'review';
              // Review renders UNCONDITIONALLY — never hidden at a zero count,
              // never hidden when its features are off (spec §6.3). Navigation
              // that changes shape is worse than navigation that is slightly
              // long. Keep the destination, drop the badge.
              const badgeCount = isReview ? totalPending : null;
              return (
                <RailRow
                  key={destination.key}
                  to={destination.path}
                  Icon={destination.Icon}
                  label={destination.label}
                  compactLabel={destination.compactLabel}
                  accessibleName={
                    isReview && totalPending > 0
                      ? `Review, ${totalPending} items pending`
                      : destination.label
                  }
                  active={activeDestination === destination.key}
                  expanded={expanded}
                  badgeCount={badgeCount}
                />
              );
            })}
          </List>

          {/* PINNED (spec §4.3 / §5). Expanded only: the group needs a heading
              to mean anything, and a heading does not fit in 56px. A pin whose
              feature is off is already filtered out by `usePinnedDestinations`
              — filtered for RENDER, never removed from storage, so re-enabling
              the feature restores the pin. */}
          {expanded && pinnedEntries.length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <List
                dense
                disablePadding
                subheader={
                  <ListSubheader disableSticky sx={subheaderSx}>
                    Pinned
                  </ListSubheader>
                }
              >
                {pinnedEntries.map((entry) => (
                  <RailRow
                    key={entry.key}
                    to={entry.path}
                    Icon={entry.Icon}
                    label={entry.label}
                    accessibleName={entry.label}
                    // A pin is a shortcut INTO a destination, and that
                    // destination's own row above already carries
                    // `aria-current`. Marking the pin current as well would
                    // emit the landmark twice on one nav.
                    active={false}
                    expanded
                  />
                ))}
              </List>
            </>
          )}
        </Box>
      )}

      {/* Console pinned at the foot, visually separated — a MODE affordance
          rather than one of the four destinations, which is why it lives below
          a divider rather than in the list above. Hidden in Console mode: the
          "Back to library" row is the affordance there. */}
      {isAdmin && !consoleMode && (
        <>
          <Divider />
          <List dense disablePadding sx={{ py: 0.5 }}>
            <RailRow
              to={ADMIN_HUB_PATH}
              Icon={AdminIcon}
              label="Console"
              compactLabel="Console"
              accessibleName="Console"
              active={activeDestination === 'console'}
              expanded={expanded}
            />
          </List>
        </>
      )}

      {/* The collapse toggle is desktop-only: tablet is forced collapsed, so a
          toggle there would either do nothing or produce a 220px rail on a
          900px screen. A real <button> with `aria-expanded` (spec §7) — not an
          icon-shaped div, and not a link. */}
      {isDesktop && (
        <>
          <Divider />
          <Box
            sx={{
              display: 'flex',
              justifyContent: expanded ? 'flex-end' : 'center',
              px: 0.5,
              py: 0.5,
            }}
          >
            <IconButton
              size="small"
              onClick={toggleRailCollapsed}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
              sx={{
                '&.Mui-focusVisible': {
                  outline: `2px solid ${theme.palette.primary.main}`,
                  outlineOffset: -2,
                },
              }}
            >
              {expanded ? (
                <ChevronLeftIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          </Box>
        </>
      )}
    </Box>
  );
}

export default NavigationRail;

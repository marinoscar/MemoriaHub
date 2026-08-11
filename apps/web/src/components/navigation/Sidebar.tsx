import { useCallback } from 'react';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Toolbar,
  Divider,
  Box,
  Badge,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  Home as HomeIcon,
  AdminPanelSettings as AdminIcon,
  ArrowBack as ArrowBackIcon,
  Collections as CollectionsIcon,
  Search as SearchIcon,
  FactCheck as FactCheckIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useReviewQueues } from '../../hooks/useReviewQueues';
import { resolveActiveDestination } from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';
import { ADMIN_HUB_PATH, visibleAdminSections } from '../../config/adminSections';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

interface NavItemDef {
  label: string;
  icon: React.ReactElement;
  path: string;
  /**
   * The destination this row represents, when it is one of the four (spec
   * §3.5). Its active state resolves through `resolveActiveDestination` rather
   * than a prefix match on `path`, because a destination must light up for
   * routes that do not resemble it — `/bursts` is Review, `/albums/:id` and
   * `/places/countries` are Collections. Console rows have no destination key
   * and keep the `owns`-based match.
   */
  destination?: DestinationKey;
  /** Optional pending-work count. Rendered as a badge only when > 0. */
  badgeCount?: number;
  /**
   * Accessible name override. Required wherever a badge carries meaning: a
   * badge must never be the sole carrier of it (spec §7), so the count is
   * spelled into the name — "Review, 12 items pending".
   */
  ariaLabel?: string;
}

const DRAWER_WIDTH = 240;

/**
 * Does `prefix` own `path`? Matches on SEGMENT boundaries — the path must equal
 * the prefix or continue with a `/`.
 *
 * Spec §3.5: a bare `startsWith` makes `/review` match `/reviewer` and
 * `/bursts` match `/burstsfoo`. That was a latent bug in the old `isActive`,
 * and it becomes load-bearing here because the same helper now decides whether
 * the whole drawer renders in Console mode.
 */
const owns = (prefix: string, path: string): boolean =>
  prefix === '/' ? path === '/' : path === prefix || path.startsWith(`${prefix}/`);

export function Sidebar({ open, onClose }: SidebarProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin, hasPermission } = usePermissions();
  // The single aggregate badge for the whole Review inbox (issue #390). It sums
  // only the ENABLED queues, and it observes the same refresh signal the hub
  // list does — so the badge and the list refetch together and cannot end up
  // showing two different numbers on one screen.
  const { totalPending } = useReviewQueues();

  // Console mode (spec §3.2): at any `/admin/*` route the drawer swaps its
  // CONTENTS, not the app shell — same Drawer, same NavItem, no second Layout.
  // This is what removes the old cost of every admin-to-admin move routing back
  // through the hub landing page, and it lets the admin surface grow past 25
  // pages without global navigation ever growing a row.
  const isConsole = owns('/admin', location.pathname);

  // FOUR DESTINATIONS (spec §3.1), and this is the row set the whole epic was
  // aiming at. Issue #389 removed the eight rows that duplicated chrome already
  // on screen; #390 collapsed five UTILITIES rows into one badged Review inbox;
  // #391 folds the six remaining browse rows — Memories, Map, Albums, and the
  // LIBRARY section's People / Archive / Trash — into Collections.
  //
  // Nothing became unreachable: every one of those routes still resolves and is
  // listed on `/collections` (and, from #392, in the desktop context pane).
  //
  // "Explore" is renamed **Search** here (spec §3.4): it always routed to
  // `/search`, while a separate explore-style hub lives at `/places`. Two
  // different things called explore was a naming collision, not a feature.
  //
  // Review renders UNCONDITIONALLY — never hidden at a zero count, never hidden
  // when the features are off (spec §6.3). Navigation that changes shape is
  // worse than navigation that is slightly long: a user cannot find a feature
  // they know exists, and cannot build muscle memory against a moving target.
  // Keep the destination, drop the badge.
  const libraryItems: NavItemDef[] = [
    { label: 'Photos', icon: <HomeIcon />, path: '/', destination: 'photos' },
    {
      label: 'Collections',
      icon: <CollectionsIcon />,
      path: '/collections',
      destination: 'collections',
    },
    { label: 'Search', icon: <SearchIcon />, path: '/search', destination: 'search' },
    {
      label: 'Review',
      icon: <FactCheckIcon />,
      path: '/review',
      destination: 'review',
      badgeCount: totalPending,
      ariaLabel: totalPending > 0 ? `Review, ${totalPending} items pending` : 'Review',
    },
  ];

  // One mechanism for all four rows, not a per-row prefix match: Collections
  // owns nine prefixes (`/albums`, `/people`, `/places`, `/memories`, `/map`,
  // `/archive`, `/trash`, `/tags`) and Review owns nine more, none of which
  // resemble the row's own path (spec §3.5).
  const activeDestination = resolveActiveDestination(location.pathname);

  // Console mode "invents no new admin IA" (spec §3.2) — these are the SAME
  // five permission-gated sections the hub renders, from the one shared
  // declaration, so the rail and the hub cannot drift apart.
  const consoleSections = visibleAdminSections(hasPermission);

  // Console paths genuinely nest (`/admin/settings/jobs` vs
  // `/admin/settings/jobs/insights`), so `owns` alone would light up TWO rows
  // and emit `aria-current="page"` twice. Longest prefix wins (spec §3.5) —
  // the same rule `adminPageTitle` applies to resolve the page title.
  const consoleActivePath = isConsole
    ? consoleSections
        .flatMap((section) => section.cards)
        .reduce<string | null>((best, card) => {
          if (!card.path || card.disabled) return best;
          if (!owns(card.path, location.pathname)) return best;
          return best === null || card.path.length > best.length ? card.path : best;
        }, null)
    : null;

  const handleNavigate = useCallback(
    (path: string) => {
      onClose();
      setTimeout(() => {
        navigate(path);
      }, 0);
    },
    [onClose, navigate],
  );

  const subheaderSx = {
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: theme.palette.text.disabled,
    lineHeight: '2rem',
    mt: 1,
    backgroundColor: theme.palette.background.paper,
  };

  const NavItem = ({
    item,
    active: activeOverride,
  }: {
    item: NavItemDef;
    /**
     * Explicit active state, for the Console rows: their paths genuinely nest
     * (`/admin/settings/jobs` vs `/admin/settings/jobs/insights`), so the caller
     * resolves longest-prefix-wins once and passes the winner down.
     */
    active?: boolean;
  }) => {
    // Precedence: an explicit override (Console), then the destination model
    // (every Library row), then a plain prefix match (the "Back to library"
    // affordance, which is not a destination and must never light up).
    const active =
      activeOverride ??
      (item.destination
        ? activeDestination === item.destination
        : owns(item.path, location.pathname));
    return (
      <ListItem disablePadding>
        <ListItemButton
          selected={active}
          // `selected` alone is a visual state; assistive technology needs the
          // explicit landmark (spec §7). Set here, once, so it holds in both
          // Library and Console mode.
          aria-current={active ? 'page' : undefined}
          aria-label={item.ariaLabel}
          onClick={() => handleNavigate(item.path)}
          sx={{
            borderRadius: 1,
            mx: 0.5,
            '&.Mui-selected': {
              backgroundColor: theme.palette.action.selected,
              '&:hover': {
                backgroundColor: theme.palette.action.hover,
              },
            },
          }}
        >
          <ListItemIcon
            sx={{
              color: active
                ? theme.palette.primary.main
                : theme.palette.text.secondary,
              minWidth: 40,
            }}
          >
            {item.icon}
          </ListItemIcon>
          <ListItemText
            primary={
              item.badgeCount && item.badgeCount > 0 ? (
                <Badge
                  badgeContent={item.badgeCount}
                  color="primary"
                  max={999}
                  sx={{ '& .MuiBadge-badge': { right: -10 } }}
                >
                  {item.label}
                </Badge>
              ) : (
                item.label
              )
            }
          />
        </ListItemButton>
      </ListItem>
    );
  };

  const consoleContent = (
    <>
      <Toolbar />
      <Divider />
      <Box sx={{ overflow: 'auto', flexGrow: 1, py: 1 }}>
        {/* Console is a MODE, so the way out of it must be permanent and
            obvious — never a route the user has to guess at (spec §3.2). */}
        <List dense disablePadding>
          <NavItem item={{ label: 'Back to library', icon: <ArrowBackIcon />, path: '/' }} />
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
                <NavItem
                  key={card.path}
                  active={card.path === consoleActivePath}
                  item={{
                    label: card.title,
                    icon: <card.Icon />,
                    path: card.path,
                  }}
                />
              ),
            )}
          </List>
        ))}
      </Box>
    </>
  );

  const libraryContent = (
    <>
      <Toolbar />
      <Divider />
      <Box sx={{ overflow: 'auto', flexGrow: 1, py: 1 }}>
        {/* Four destinations, ONE flat list — no subheaders. The old LIBRARY
            subheader went away with the three rows it grouped: a heading over a
            four-row list that is the entire navigation is pure chrome. */}
        <List dense disablePadding>
          {libraryItems.map((item) => (
            <NavItem key={item.path} item={item} />
          ))}
        </List>
      </Box>

      {/* Console pinned at the foot, where User Settings used to sit. It is a
          MODE affordance rather than one of the nine rows — the epic counts it
          separately, which is why it lives below the divider. */}
      {isAdmin && (
        <>
          <Divider />
          <List dense disablePadding sx={{ py: 0.5 }}>
            <NavItem
              item={{ label: 'Console', icon: <AdminIcon />, path: ADMIN_HUB_PATH }}
            />
          </List>
        </>
      )}
    </>
  );

  const drawerContent = isConsole ? consoleContent : libraryContent;

  if (isDesktop) {
    return (
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
            backgroundColor: theme.palette.background.paper,
            borderRight: `1px solid ${theme.palette.divider}`,
            display: 'flex',
            flexDirection: 'column',
            top: 64,
            height: 'calc(100% - 64px)',
          },
        }}
      >
        {drawerContent}
      </Drawer>
    );
  }

  return (
    <Drawer
      variant="temporary"
      open={open}
      onClose={onClose}
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiBackdrop-root': {
          top: { xs: 56, sm: 64 },
        },
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          backgroundColor: theme.palette.background.paper,
          borderRight: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          flexDirection: 'column',
          top: { xs: 56, sm: 64 },
          height: { xs: 'calc(100% - 56px)', sm: 'calc(100% - 64px)' },
        },
      }}
      ModalProps={{
        keepMounted: false,
        disablePortal: true,
      }}
    >
      {drawerContent}
    </Drawer>
  );
}

export { DRAWER_WIDTH };

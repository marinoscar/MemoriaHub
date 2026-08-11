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
  Map as MapIcon,
  Groups as GroupsIcon,
  Explore as ExploreIcon,
  PhotoAlbum as AlbumIcon,
  BurstMode as BurstModeIcon,
  Archive as ArchiveOutlinedIcon,
  Delete as DeleteOutlineIcon,
  ContentCopy as ContentCopyIcon,
  MyLocation as MyLocationIcon,
  Insights as InsightsIcon,
  AccountTree as AccountTreeIcon,
  AutoFixHigh as AutoFixHighIcon,
  AutoAwesomeMotion as AutoAwesomeMotionIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkflowsEnabled } from '../../hooks/useWorkflowSubjects';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { useReviewCounts } from '../../hooks/useReviewCounts';
import { ADMIN_HUB_PATH, visibleAdminSections } from '../../config/adminSections';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

interface NavItemDef {
  label: string;
  icon: React.ReactElement;
  path: string;
  /** Optional pending-work count. Rendered as a badge only when > 0. */
  badgeCount?: number;
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
  const workflowsEnabled = useWorkflowsEnabled();
  const { pictureEnhancement } = useFeatureFlags();
  // The AI Enhancements badge is the sole consumer of these counts, and that
  // entry only renders when the enhancer flag is on — so the hook is gated on
  // the same condition and issues NO request while the flag is off or still
  // loading (issue #204). `useReviewCounts` is keyed on the active circle, so
  // when it IS enabled this is one small counts-only request per circle
  // switch, not per navigation, and not the full dashboard payload.
  const { data: reviewCounts } = useReviewCounts({
    enabled: pictureEnhancement?.enabled === true,
  });
  const pendingEnhancements = reviewCounts?.pendingEnhancements ?? 0;
  // Same module-level flag cache the enhancer entry above reads — this adds no
  // second request. `=== true` for the same reason documented there: the entry
  // must not flash in while the flags load, and a flags outage must hide it.
  const memoriesEnabled = useMemoriesEnabled();

  // Console mode (spec §3.2): at any `/admin/*` route the drawer swaps its
  // CONTENTS, not the app shell — same Drawer, same NavItem, no second Layout.
  // This is what removes the old cost of every admin-to-admin move routing back
  // through the hub landing page, and it lets the admin surface grow past 25
  // pages without global navigation ever growing a row.
  const isConsole = owns('/admin', location.pathname);

  // Eight rows were removed in issue #389 because each duplicates chrome that
  // is already on screen (spec §1.2): Circles (top-bar circle chip + avatar
  // menu), Notifications (the AppBar bell, same badge, with a persistent "See
  // all notifications" footer), User Settings (avatar menu), and the five
  // ADMINISTRATION shortcuts — an arbitrary sample of a 23-page hub, now
  // carried in full by Console mode below.
  const primaryItems: NavItemDef[] = [
    { label: 'Photos', icon: <HomeIcon />, path: '/' },
    ...(memoriesEnabled === true
      ? [{ label: 'Memories', icon: <AutoAwesomeMotionIcon />, path: '/memories' }]
      : []),
    { label: 'Explore', icon: <ExploreIcon />, path: '/search' },
    { label: 'Map', icon: <MapIcon />, path: '/map' },
    { label: 'Albums', icon: <AlbumIcon />, path: '/albums' },
  ];

  const libraryItems: NavItemDef[] = [
    { label: 'People', icon: <GroupsIcon />, path: '/people' },
    { label: 'Archive', icon: <ArchiveOutlinedIcon />, path: '/archive' },
    { label: 'Trash', icon: <DeleteOutlineIcon />, path: '/trash' },
  ];

  const utilitiesItems: NavItemDef[] = [
    { label: 'Review Bursts', icon: <BurstModeIcon />, path: '/bursts' },
    { label: 'Review Duplicates', icon: <ContentCopyIcon />, path: '/duplicates' },
    { label: 'Review Insights', icon: <InsightsIcon />, path: '/review-insights' },
    { label: 'Location Suggestions', icon: <MyLocationIcon />, path: '/location-suggestions' },
    ...(workflowsEnabled === true
      ? [{ label: 'Workflows', icon: <AccountTreeIcon />, path: '/workflows' }]
      : []),
    // `=== true` (not a truthy check) so the entry does not flash in while the
    // flag is still loading — `pictureEnhancement` is null until then, and
    // useFeatureFlags degrades to null on failure rather than throwing.
    ...(pictureEnhancement?.enabled === true
      ? [
          {
            label: 'AI Enhancements',
            icon: <AutoFixHighIcon />,
            path: '/enhancements',
            badgeCount: pendingEnhancements,
          },
        ]
      : []),
  ];

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
    /** Escape hatch for Console mode, where nesting needs longest-prefix-wins. */
    active?: boolean;
  }) => {
    const active = activeOverride ?? owns(item.path, location.pathname);
    return (
      <ListItem disablePadding>
        <ListItemButton
          selected={active}
          // `selected` alone is a visual state; assistive technology needs the
          // explicit landmark (spec §7). Set here, once, so it holds in both
          // Library and Console mode.
          aria-current={active ? 'page' : undefined}
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
        {/* PRIMARY section — no subheader */}
        <List dense disablePadding>
          {primaryItems.map((item) => (
            <NavItem key={item.path} item={item} />
          ))}
        </List>

        {/* LIBRARY section */}
        <List
          dense
          disablePadding
          subheader={
            <ListSubheader disableSticky sx={subheaderSx}>
              Library
            </ListSubheader>
          }
        >
          {libraryItems.map((item) => (
            <NavItem key={item.path} item={item} />
          ))}
        </List>

        {/* UTILITIES section */}
        <List
          dense
          disablePadding
          subheader={
            <ListSubheader disableSticky sx={subheaderSx}>
              Utilities
            </ListSubheader>
          }
        >
          {utilitiesItems.map((item) => (
            <NavItem key={item.path} item={item} />
          ))}
        </List>
      </Box>

      {/* Console pinned at the foot, where User Settings used to sit. It is a
          MODE affordance rather than one of the 14 rows — the epic counts it
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

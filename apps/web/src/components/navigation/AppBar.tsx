import { useState, useCallback } from 'react';
import {
  AppBar as MuiAppBar,
  Box,
  Toolbar,
  Typography,
  IconButton,
  Button,
  Snackbar,
  Alert,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon,
  CloudUpload as UploadIcon,
  ArrowBack as ArrowBackIcon,
} from '@mui/icons-material';
import { useNavigate, useLocation } from 'react-router-dom';
import { useThemeContext } from '../../contexts/ThemeContext';
import { useCircle } from '../../hooks/useCircle';
import { useMediaRefresh } from '../../contexts/MediaRefreshContext';
import { UserMenu } from './UserMenu';
import { CircleChip } from './CircleChip';
import { NotificationBell } from '../notifications/NotificationBell';
import { TopbarSearch } from '../search/TopbarSearch';
import { MediaUploadDialog } from '../media/MediaUploadDialog';
import { ADMIN_HUB_PATH, adminPageTitle } from '../../config/adminSections';
import { APP_NAME } from '../../constants/app';
import appLogo from '../../assets/app_logo.png';

/**
 * The top bar.
 *
 * Takes no props as of issue #392: the `onMenuClick` hamburger callback went
 * away with the drawer it opened. Navigation below `sm` is the bottom bar, and
 * at `sm` and up it is the permanent rail — neither needs anything from here.
 */
export function AppBar() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isDarkMode, toggleMode } = useThemeContext();
  const { activeCircle } = useCircle();
  const { triggerRefresh } = useMediaRefresh();
  // Both gates are the Material 3 compact/medium boundary at 600px, matching
  // `Layout`'s `showRail` (issue #402 — see the coupled-gate list there). They
  // were `md` (900px) and drifted apart from the wordmark's `sm`; now that all
  // of this chrome pivots on the same window class, ONE query drives the
  // compact treatment rather than two identically-defined ones that could
  // silently diverge again.
  const isTabletUp = useMediaQuery(theme.breakpoints.up('sm'));
  // Drives three things, all of which are properties of the compact window
  // class rather than three independent preferences: the wordmark is dropped,
  // and — because there is no rail to swap into Console mode (spec §4.4) — the
  // admin surface becomes a drill-down with this bar as its header.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadSnackbar, setUploadSnackbar] = useState(false);

  const handleUploadSuccess = useCallback(() => {
    setUploadOpen(false);
    triggerRefresh();
    setUploadSnackbar(true);
  }, [triggerRefresh]);

  // Segment-safe, so a future `/administration` route can never be mistaken for
  // the admin surface — the same rule spec §3.5 mandates for destination
  // ownership, applied to the one prefix this component cares about.
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
  const adminDrillDown = isCompactWindow && isAdminRoute;

  // Up one level, expressed as an explicit destination rather than
  // `navigate(-1)`: history can contain anything (a deep link, a redirect, a
  // reload), whereas "the level above this page" is a property of the route.
  // In the ordinary drill-down flow (hub → detail → back) the two agree, which
  // is spec §4.4 requirement 3.
  const adminBackTarget =
    pathname === ADMIN_HUB_PATH || pathname === '/admin' ? '/' : ADMIN_HUB_PATH;

  return (
    <>
      <MuiAppBar
        position="sticky"
        color="default"
        elevation={0}
        sx={{
          backgroundColor: theme.palette.background.paper,
          // Ensure the phone search overlay (position:absolute inside Toolbar)
          // renders above sibling elements.
          zIndex: theme.zIndex.appBar,
        }}
      >
        {/* THE PHONE ROW, POST-#392 — the crowding documented in
            docs/audits/mobile-topbar-audit.md is now structurally resolved
            rather than tuned.

            At 360px the row is: logo + CIRCLE CHIP + upload + bell + theme +
            avatar. Two items that used to be here are gone for good, and both
            left because a DESTINATION took over their job, not because they
            were squeezed out:
              - the hamburger, with the drawer it opened (spec §4.1);
              - the search pill, because Search is a bottom-bar tab below `sm`
                (see the `isTabletUp` gate on TopbarSearch below).
            Together they return ~80px. The four fixed icon buttons plus the
            32px logo now measure ~232px of the 360px viewport, leaving the chip
            ~120px — comfortably past its 108px cap, so on a phone it renders at
            full width instead of truncating.

            The tightened 4px gap below `sm` is kept anyway: it costs nothing,
            and the slack it buys is what absorbs a larger system font or a
            2-digit notification badge without the row reflowing. The chip
            remains the only shrinkable item here (every icon button is
            `flexShrink: 0`), which is what guarantees the toolbar can never
            push the app shell sideways. */}
        <Toolbar sx={{ gap: { xs: 0.5, sm: 1 }, position: 'relative' }}>
          {adminDrillDown ? (
            <>
              {/* Admin drill-down header (spec §4.4). Everything that is not
                  back / title / avatar is dropped: nearly every admin page is
                  global rather than circle-scoped, so the circle chip, upload
                  and search buy nothing here, and a title that survives
                  "Near-Duplicate Detection" is worth more than any of them.
                  The theme toggle goes too — it is not admin-specific, it is
                  reachable from user Settings, and keeping it would leave the
                  title ~40px to truncate into on a 360px screen.
                  The bottom bar still carries Library navigation on these
                  screens, so dropping the brand does not strand anyone. */}
              <IconButton
                color="inherit"
                aria-label="Back"
                edge="start"
                onClick={() => navigate(adminBackTarget)}
                sx={{ flexShrink: 0 }}
              >
                <ArrowBackIcon />
              </IconButton>

              <Typography
                variant="h6"
                component="h1"
                noWrap
                sx={{
                  flexGrow: 1,
                  minWidth: 0,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {adminPageTitle(pathname)}
              </Typography>

              <UserMenu />
            </>
          ) : (
            <>
              {/* Brand — logo always shown; wordmark added on tablet/desktop.
                  `edge="start"`-style alignment now belongs to the logo: the
                  hamburger that used to hold this slot was deleted with the
                  drawer in #392. */}
              <Box
                onClick={() => navigate('/')}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <Box
                  component="img"
                  src={appLogo}
                  alt={APP_NAME}
                  sx={{ height: 32, width: 'auto', display: 'block', objectFit: 'contain' }}
                />
                {!isCompactWindow && (
                  <Typography
                    variant="h6"
                    component="div"
                    sx={{
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {APP_NAME}
                  </Typography>
                )}
              </Box>

              {/* Active circle — the one piece of chrome that renders at every
                  breakpoint, and on phone it occupies the space the wordmark
                  already vacated. It is the ONLY shrinkable item in this row:
                  every icon button is `flexShrink: 0` and `TopbarSearch`'s
                  collapsed phone state bottoms out at its 40px icon, so when
                  the row would overflow the chip is what gives, and the
                  toolbar cannot push the app shell sideways. See CircleChip's
                  own comment for the minWidth/maxWidth rule. */}
              <CircleChip />

              {/* Central search pill — `sm` and up ONLY (spec §4.1 / §4.2).
                  Below `sm` this pill is absent, which frees the scarcest row in
                  the app and permanently resolves the ~354px-against-360px
                  crowding the topbar audit documents. At `sm` and up the Search
                  destination gives up its RAIL slot instead and is carried here,
                  where there is width for a real input — see the header of
                  `NavigationRail`.

                  `TopbarSearch` has its own internal `down('sm')` split between
                  its collapsed-icon and inline-pill forms; since #402 this gate
                  sits on the SAME boundary, so the pill mounts exactly where its
                  own inline branch renders and the collapsed branch is only ever
                  reached from the phone overlay path.

                  ⚠️ THIS GATE IS ONLY VALID BECAUSE `/search` OWNS ITS OWN INPUT.
                  The tab is NOT by itself an equivalent replacement for this
                  pill: `TopbarSearch` is the sole opener of `SearchPanel` and the
                  sole free-text/agentic entry point in the toolbar, and issue
                  #400 is the production outage that happened when this gate
                  landed while `SearchPage` still only rendered results. What
                  makes it correct now is `PageSearchBar`, mounted in all four
                  `SearchPage` branches, which carries both capabilities. Do not
                  remove that bar — deleting it silently recreates the outage
                  below 600px, where this pill does not render at all. */}
              {isTabletUp && <TopbarSearch />}

              {/* The flexible spacer that `TopbarSearch` used to supply.
                  Removing it without a replacement is EXACTLY the regression
                  docs/audits/mobile-topbar-audit.md records for issue #95 — the
                  icons pack to the left with dead space on the right, because
                  nothing in the row grows. Rendered only where the search pill
                  is absent, so the two never compete for the same free space. */}
              {!isTabletUp && <Box aria-hidden sx={{ flexGrow: 1, minWidth: 0 }} />}

              {/* Upload button */}
              {activeCircle && (
                isTabletUp ? (
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<UploadIcon />}
                    onClick={() => setUploadOpen(true)}
                    aria-label="Upload media"
                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    Upload
                  </Button>
                ) : (
                  <IconButton
                    color="inherit"
                    aria-label="Upload media"
                    onClick={() => setUploadOpen(true)}
                    sx={{ flexShrink: 0 }}
                  >
                    <UploadIcon />
                  </IconButton>
                )
              )}

              {/* Notifications (between upload and the theme toggle) */}
              <NotificationBell />

              {/* Theme Toggle */}
              <IconButton
                onClick={toggleMode}
                color="inherit"
                aria-label="toggle theme"
                sx={{ flexShrink: 0 }}
              >
                {isDarkMode ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>

              {/* User Menu */}
              <UserMenu />
            </>
          )}
        </Toolbar>
      </MuiAppBar>

      {/* Upload dialog */}
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircle?.id}
      />

      {/* Upload success snackbar */}
      <Snackbar
        open={uploadSnackbar}
        autoHideDuration={4000}
        onClose={() => setUploadSnackbar(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setUploadSnackbar(false)}
          severity="success"
          sx={{ width: '100%' }}
        >
          Upload complete
        </Alert>
      </Snackbar>
    </>
  );
}

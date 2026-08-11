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
  Menu as MenuIcon,
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

interface AppBarProps {
  onMenuClick?: () => void;
}

export function AppBar({ onMenuClick }: AppBarProps) {
  const theme = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isDarkMode, toggleMode } = useThemeContext();
  const { activeCircle } = useCircle();
  const { triggerRefresh } = useMediaRefresh();
  const isMd = useMediaQuery(theme.breakpoints.up('md'));
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  // Console mode does not exist below `md` (spec §4.4): there is no rail to
  // swap, so the admin surface is a drill-down and the top bar becomes its
  // header. Note this is `down('md')`, not the `isPhone` (`down('sm')`) used
  // for the wordmark — a tablet has a rail and keeps the normal toolbar.
  const isCompactNav = useMediaQuery(theme.breakpoints.down('md'));

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
  const adminDrillDown = isCompactNav && isAdminRoute;

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
        {/* `gap` tightens on phone. At 360px the row is hamburger + logo +
            CIRCLE CHIP + collapsed search + upload + bell + theme + avatar;
            with the desktop 8px gap the fixed items alone measured ~354px
            against 360px of viewport — 6px of slack, which a slightly larger
            system font or a 2-digit badge would blow through. Dropping to 4px
            below `sm` buys back ~28px so the fixed items measure ~330px. See
            docs/audits/mobile-topbar-audit.md for the previous regression of
            this class.

            The chip is added on top of that ~330px, which is why it (alone in
            this row) shrinks: on a 360px device it renders truncated to
            whatever is left rather than overflowing, and it reaches its full
            108px cap around 430px. That squeeze is transitional — issue #390
            moves search out of the top bar into a tab and #392 deletes the
            hamburger, together returning ~80px to this row on phone. */}
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
              {/* Hamburger. Stays for this phase — the drawer is not removed
                  until issue #392. */}
              <IconButton
                color="inherit"
                aria-label="toggle drawer"
                edge="start"
                onClick={onMenuClick}
                sx={{ flexShrink: 0 }}
              >
                <MenuIcon />
              </IconButton>

              {/* Brand — logo always shown; wordmark added on tablet/desktop */}
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
                {!isPhone && (
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

              {/* Central search pill — takes available space */}
              <TopbarSearch />

              {/* Upload button */}
              {activeCircle && (
                isMd ? (
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

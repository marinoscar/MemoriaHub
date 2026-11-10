/**
 * The top bar — this app's binding of the packaged `ShellAppBar`
 * (`@marinoscar/platform-web/shell/ui`, RETRO-F1 #571).
 *
 * The bar itself (its sticky flat chrome, the theme toggle, and below `sm` the
 * settings drill-down: back arrow, structural up rather than history, plus the
 * resolved page title on `/admin/settings/*` and `/settings/*`) is the
 * package's, and with it breakpoint gate 5 (`isCompactWindow`, `down('sm')`).
 * This file fills its slots:
 *
 *   - `brand`: the logo, the wordmark (from `md` up, by CSS, so it is not a
 *     breakpoint read) and the CIRCLE CHIP. The chip sits in the brand so it
 *     stays next to the logo and, like before, disappears in the drill-down
 *     (the brand is not drawn there). The chip is the row's one shrinkable
 *     item, which is what keeps the toolbar from pushing the shell sideways
 *     (issue #291).
 *   - `actions` (both treatments): the search pill at `sm` and up, and the
 *     notification bell.
 *   - `wideActions` (outside the drill-down): Upload.
 *   - `userMenu`: the app's account menu (see `UserMenu.tsx`).
 *
 * ONE breakpoint read is left here, `up('sm')` for the search pill and the
 * labelled Upload button. It is not a navigation gate: it decides only which
 * controls the bar carries, and it is the documented exception listed in
 * `__tests__/config/breakpointGates.test.ts`. Below `sm` Search is a
 * bottom-bar tab, and `SearchPage`'s own `PageSearchBar` carries free-text and
 * agentic search there (issue #400: never remove that bar).
 */
import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { Alert, Box, Button, IconButton, Snackbar, Typography, useMediaQuery, useTheme } from '@mui/material';
import UploadIcon from '@mui/icons-material/CloudUpload';
import { ShellAppBar } from '@marinoscar/platform-web/shell/ui';
import { APP_NAVIGATION } from '../../config/shell';
import { useOwnerScope } from '../../hooks/useOwnerScope';
import { useMediaRefresh } from '../../contexts/MediaRefreshContext';
import { UserMenu } from './UserMenu';
import { OwnerScopeChip } from './OwnerScopeChip';
import { NotificationBell } from '../notifications/NotificationBell';
import { TopbarSearch } from '../search/TopbarSearch';
import { MediaUploadDialog } from '../media/MediaUploadDialog';
import { APP_NAME } from '../../constants/app';
import appLogo from '../../assets/app_logo.png';

/** Stops a click inside the chip (or its portalled menu) reaching the brand's "go home". */
function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

function Brand() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Box
        component="img"
        src={appLogo}
        alt={APP_NAME}
        sx={{ height: 32, width: 'auto', display: 'block', objectFit: 'contain', flexShrink: 0 }}
      />
      {/* The wordmark keeps its own, higher threshold (`md`): through the
          medium band the chip and the search pill need its ~110px more. */}
      <Typography
        component="span"
        variant="h6"
        sx={{ display: { xs: 'none', md: 'inline' }, fontWeight: 600, whiteSpace: 'nowrap' }}
      >
        {APP_NAME}
      </Typography>
      <Box onClick={stopPropagation} sx={{ display: 'flex', minWidth: 0, cursor: 'default' }}>
        <OwnerScopeChip />
      </Box>
    </Box>
  );
}

export function AppBar() {
  const theme = useTheme();
  const { activeCircle } = useOwnerScope();
  const { triggerRefresh } = useMediaRefresh();
  // The documented non-gate (see the file header).
  const isTabletUp = useMediaQuery(theme.breakpoints.up('sm'));

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadSnackbar, setUploadSnackbar] = useState(false);

  const handleUploadSuccess = useCallback(() => {
    setUploadOpen(false);
    triggerRefresh();
    setUploadSnackbar(true);
  }, [triggerRefresh]);

  const upload = activeCircle ? (
    isTabletUp ? (
      <Button
        variant="outlined"
        size="small"
        startIcon={<UploadIcon />}
        onClick={() => setUploadOpen(true)}
        aria-label="Upload media"
        sx={{ flexShrink: 0, whiteSpace: 'nowrap', mr: 1 }}
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
  ) : null;

  return (
    <>
      <ShellAppBar
        navigation={APP_NAVIGATION}
        brand={<Brand />}
        actions={
          <>
            {isTabletUp && <TopbarSearch />}
            <NotificationBell />
          </>
        }
        wideActions={upload}
        userMenu={<UserMenu />}
      />

      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
        circleId={activeCircle?.id}
      />

      <Snackbar
        open={uploadSnackbar}
        autoHideDuration={4000}
        onClose={() => setUploadSnackbar(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setUploadSnackbar(false)} severity="success" sx={{ width: '100%' }}>
          Upload complete
        </Alert>
      </Snackbar>
    </>
  );
}

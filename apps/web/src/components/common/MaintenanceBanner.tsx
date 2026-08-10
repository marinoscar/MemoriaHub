import { Alert, AlertTitle, Box, Button } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useMaintenance } from '../../hooks/useMaintenance';

/** How often to re-check the persisted state so a toggle in another tab, or by
 *  another admin, reaches this one without a reload. */
const BANNER_POLL_MS = 60_000;

/**
 * Persistent, non-dismissible banner shown to admins whenever maintenance mode
 * is active (issue #348).
 *
 * This is load-bearing rather than decorative: with `allowAdmins: true` — the
 * default — an admin's own requests are never 503ed, so the app looks entirely
 * normal to the one person who can turn maintenance off. Leaving it on by
 * accident is the most likely real-world failure of this feature, and the
 * banner is the only thing standing between "upgrade finished" and "the site
 * stayed dark all night".
 *
 * It reads the PERSISTED state (`GET /api/admin/maintenance`) rather than the
 * client-observed 503 store precisely because an admin sees no 503s. There is
 * no dismiss control on purpose.
 */
export function MaintenanceBanner() {
  const { state, canRead } = useMaintenance(BANNER_POLL_MS);

  if (!canRead || !state?.active) {
    return null;
  }

  const startedAt = state.startedAt ? new Date(state.startedAt) : null;
  const startedAtLabel =
    startedAt && !Number.isNaN(startedAt.getTime())
      ? startedAt.toLocaleString()
      : null;

  return (
    <Box sx={{ position: 'sticky', top: 0, zIndex: (theme) => theme.zIndex.appBar + 1 }}>
      <Alert
        severity="warning"
        variant="filled"
        square
        role="alert"
        icon={false}
        action={
          <Button
            color="inherit"
            size="small"
            component={RouterLink}
            to="/admin/settings/general"
          >
            Manage
          </Button>
        }
        sx={{ borderRadius: 0, alignItems: 'center' }}
      >
        <AlertTitle sx={{ mb: 0 }}>Maintenance mode is ON</AlertTitle>
        {state.allowAdmins
          ? 'Other users cannot use the application. You can, because admins are exempt.'
          : 'All users are blocked, including admins.'}
        {state.message ? ` — “${state.message}”` : ''}
        {startedAtLabel ? ` (since ${startedAtLabel})` : ''}
      </Alert>
    </Box>
  );
}

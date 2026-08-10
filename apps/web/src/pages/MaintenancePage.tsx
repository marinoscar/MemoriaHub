import {
  Box,
  Button,
  CircularProgress,
  Container,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import BuildCircleIcon from '@mui/icons-material/BuildCircle';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearMaintenance } from '../services/maintenanceState';
import { useMaintenanceMode } from '../hooks/useMaintenanceMode';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

/** How often to re-probe readiness while sitting on the maintenance screen. */
export const MAINTENANCE_POLL_MS = 15_000;

/**
 * Probe `GET /api/health/ready`.
 *
 * That route is `@AllowDuringMaintenance()` (so it always answers) but
 * deliberately reports 503 while maintenance is active — see
 * apps/api/src/health/health.controller.ts. It is therefore the one endpoint
 * whose 200 means "maintenance is genuinely over", unlike the exempt auth
 * routes, which answer 200 throughout and would falsely signal recovery.
 *
 * Uses raw fetch rather than the api wrapper on purpose: the wrapper would
 * re-publish a maintenance notice on every failed poll, and the readiness 503
 * has a different body shape (no marker) anyway.
 */
async function probeReady(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/health/ready`, {
      credentials: 'include',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

function formatStartedAt(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export interface MaintenancePageProps {
  /**
   * Supplied by MaintenanceGate only for users the client already knows are
   * admins. Renders the escape hatch back into the app so an admin who hit a
   * 503 (i.e. `allowAdmins: false`) can still reach the toggle and turn
   * maintenance off — `GET`/`PUT /api/admin/maintenance` stay reachable
   * throughout, since the controller is `@AllowDuringMaintenance()`.
   */
  onContinueAsAdmin?: () => void;
}

/**
 * Full-screen maintenance takeover (issue #348).
 *
 * Rendered by MaintenanceGate in place of the router once the API has reported
 * a maintenance 503, so a user never sees a dozen pages each inventing their
 * own error. Polls readiness and recovers automatically — an admin flipping
 * maintenance off should not require every user to know to hit reload.
 */
export default function MaintenancePage({
  onContinueAsAdmin,
}: MaintenancePageProps = {}) {
  const notice = useMaintenanceMode();
  const [isChecking, setIsChecking] = useState(false);
  // Guards against overlapping probes when a slow request is still in flight
  // as the next interval tick fires.
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsChecking(true);
    try {
      if (await probeReady()) {
        // Recovery is a full reload, not just clearing the notice: pages
        // mounted before the window began hold stale/failed data, and every
        // in-flight request during maintenance already errored out.
        clearMaintenance();
        window.location.reload();
      }
    } finally {
      inFlight.current = false;
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => void check(), MAINTENANCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [check]);

  const startedAt = formatStartedAt(notice?.startedAt ?? null);

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          py: 4,
        }}
      >
        <Paper
          role="alert"
          aria-live="polite"
          sx={{ p: { xs: 3, sm: 5 }, width: '100%', textAlign: 'center' }}
        >
          <BuildCircleIcon
            color="warning"
            sx={{ fontSize: 64, mb: 2 }}
            aria-hidden
          />

          <Typography variant="h4" component="h1" gutterBottom>
            Down for maintenance
          </Typography>

          <Typography color="text.secondary" sx={{ mb: 3 }}>
            {notice?.message ||
              'The application is temporarily down for maintenance. Please check back shortly.'}
          </Typography>

          {startedAt && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Maintenance started {startedAt}
            </Typography>
          )}

          <Stack
            direction="row"
            spacing={1}
            sx={{ alignItems: 'center', justifyContent: 'center' }}
          >
            <Button
              variant="contained"
              onClick={() => void check()}
              disabled={isChecking}
              startIcon={
                isChecking ? <CircularProgress size={16} color="inherit" /> : undefined
              }
            >
              {isChecking ? 'Checking…' : 'Try again'}
            </Button>

            {onContinueAsAdmin && (
              <Button variant="outlined" onClick={onContinueAsAdmin}>
                Manage maintenance mode
              </Button>
            )}
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>
            This page checks automatically and will reload itself as soon as the
            application is back.
          </Typography>
        </Paper>
      </Box>
    </Container>
  );
}

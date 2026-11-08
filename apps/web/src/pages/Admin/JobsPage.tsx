/**
 * Admin → Settings → Job Queue (`/admin/settings/jobs`).
 *
 * The platform's page (RETRO-C1, #575): the queue summary, "Retry all failed", "Reset stuck", the
 * paginated job list with per-row retry and delete, and the link to Job Insights. This file is the
 * lazy-loaded binding: the one queue-wide action the platform page does not know,
 * "Repair missing thumbnails" (`POST /api/admin/media/thumbnails/repair`, an app endpoint that
 * enqueues the global `thumbnail_repair` job at priority 0), joins the page's toolbar slot.
 * The registry card is spread from `jobsAdminSections` in `config/adminSections.tsx` and the route,
 * gated on the `jobs:read` the API enforces, is in `App.tsx`.
 */
import { useState } from 'react';
import { Alert, Button, Snackbar } from '@mui/material';
import HealingIcon from '@mui/icons-material/Healing';
import { JobsPage as PackagedJobsPage } from '@marinoscar/platform-web/jobs/ui';

import { usePermissions } from '../../hooks/usePermissions';
import { repairThumbnails } from '../../services/jobs';

/** The extra toolbar button: queue a global thumbnail-repair sweep now instead of at the next hourly tick. */
export function RepairThumbnailsButton() {
  const { hasPermission } = usePermissions();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);

  // The endpoint is `storage:delete_any` (Admin); the platform page only knows `jobs:write`.
  if (!hasPermission('jobs:write') || !hasPermission('storage:delete_any')) return null;

  const handleClick = async () => {
    setBusy(true);
    try {
      const result = await repairThumbnails();
      setMessage({ severity: 'success', text: `Thumbnail repair queued (job ${result.jobId.slice(0, 8)}…)` });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err instanceof Error ? err.message : 'Failed to queue thumbnail repair',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outlined" startIcon={<HealingIcon />} disabled={busy} onClick={() => void handleClick()}>
        Repair missing thumbnails
      </Button>
      <Snackbar open={message !== null} autoHideDuration={6000} onClose={() => setMessage(null)}>
        {message ? (
          <Alert severity={message.severity} onClose={() => setMessage(null)} sx={{ width: '100%' }}>
            {message.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </>
  );
}

const SLOTS = { Toolbar: RepairThumbnailsButton };

export default function JobsPage() {
  return <PackagedJobsPage slots={SLOTS} />;
}

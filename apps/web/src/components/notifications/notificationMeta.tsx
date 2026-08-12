/**
 * Per-type presentation metadata for a notification row (issue #249).
 *
 * Kept in its own module (not inline in the panel) so #250's `/notifications`
 * page renders identical icons/colors without duplicating the mapping.
 *
 * An unknown `type` — a row produced by a newer API than this bundle — falls
 * back to a generic bell rather than rendering nothing.
 */

import type { ReactElement } from 'react';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import BurstModeIcon from '@mui/icons-material/BurstMode';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import PublicIcon from '@mui/icons-material/Public';

/** Theme palette key used to tint the row's icon. */
export type NotificationTone = 'primary' | 'warning' | 'error' | 'success' | 'info';

export interface NotificationMeta {
  icon: ReactElement;
  tone: NotificationTone;
  /** Short human label for the type, used as the icon's accessible name. */
  label: string;
}

const META: Record<string, NotificationMeta> = {
  review_queue_bursts: {
    icon: <BurstModeIcon fontSize="small" />,
    tone: 'primary',
    label: 'Burst review',
  },
  review_queue_duplicates: {
    icon: <ContentCopyIcon fontSize="small" />,
    tone: 'primary',
    label: 'Duplicate review',
  },
  review_queue_location_suggestions: {
    icon: <MyLocationIcon fontSize="small" />,
    tone: 'primary',
    label: 'Location suggestions',
  },
  review_queue_enhancements: {
    icon: <AutoFixHighIcon fontSize="small" />,
    tone: 'primary',
    label: 'AI enhancements',
  },
  upload_completed: {
    icon: <CloudUploadIcon fontSize="small" />,
    tone: 'success',
    label: 'Upload complete',
  },
  enrichment_failed: {
    icon: <ErrorOutlineIcon fontSize="small" />,
    tone: 'error',
    label: 'Enrichment failed',
  },
  workflow_run_completed: {
    icon: <AccountTreeIcon fontSize="small" />,
    tone: 'info',
    label: 'Workflow run',
  },
  share_expiring: {
    icon: <PublicIcon fontSize="small" />,
    tone: 'warning',
    label: 'Share expiring',
  },
  // Epic #300 / issue #311. Positive tone on purpose: unlike every other row in
  // this map, "your memories are ready" is good news the user opted into, not a
  // queue to drain or a failure to fix.
  memories_ready: {
    icon: <AutoAwesomeIcon fontSize="small" />,
    tone: 'success',
    label: 'Memories ready',
  },
};

const FALLBACK: NotificationMeta = {
  icon: <NotificationsNoneIcon fontSize="small" />,
  tone: 'info',
  label: 'Notification',
};

export function notificationMeta(type: string): NotificationMeta {
  return META[type] ?? FALLBACK;
}

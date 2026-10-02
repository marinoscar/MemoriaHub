/**
 * The files the phone's last sync could not upload (issue #515): the last
 * run's `details.failedSample` — name, folder, size, attempts, last error —
 * plus Retry failed and, inside the TWA, a deep link to the phone's own file
 * list.
 */
import { Alert, Box, Button, List, ListItem, Skeleton, Typography } from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import type { MediaSyncDevice, MediaSyncRun } from '../../../services/mediaSync';
import { mediaSyncDeepLink } from '../../../utils/androidIdentity';
import { formatBytes } from '../../../utils/formatBytes';
import { formatDateTime } from './format';

interface FailedFilesProps {
  device: MediaSyncDevice;
  runs: MediaSyncRun[];
  isLoading: boolean;
  error: string | null;
  inTwa: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}

export function FailedFiles({ device, runs, isLoading, error, inTwa, canRetry, retrying, onRetry }: FailedFilesProps) {
  const lastRun = runs[0] ?? null;
  const sample = lastRun?.details?.failedSample ?? [];
  const failedNow = (device.stats?.failed ?? 0) + (device.stats?.blocked ?? 0);

  let body;
  if (isLoading && runs.length === 0) {
    body = <Skeleton width="70%" />;
  } else if (error && runs.length === 0) {
    body = <Alert severity="error">{error}</Alert>;
  } else if (sample.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary" data-testid="no-failed-files">
        {lastRun ? 'The last sync reported no failed files.' : 'No syncs yet.'}
        {failedNow > 0 ? ` The phone currently counts ${failedNow} failed or blocked file${failedNow === 1 ? '' : 's'}.` : ''}
      </Typography>
    );
  } else {
    body = (
      <>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          From the sync on {formatDateTime(lastRun?.finishedAt)} (a sample of up to 50 files).
        </Typography>
        <List dense disablePadding aria-label="Failed files">
          {sample.map((f, i) => (
            <ListItem key={`${f.relativePath ?? ''}/${f.name}/${i}`} divider disableGutters sx={{ display: 'block' }}>
              <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                {f.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: 'anywhere' }}>
                {[f.relativePath, formatBytes(String(Math.max(0, Math.trunc(f.sizeBytes)))), `${f.attempts} attempt${f.attempts === 1 ? '' : 's'}`]
                  .filter(Boolean)
                  .join(' · ')}
              </Typography>
              {f.lastError && (
                <Typography variant="caption" color="error" component="div" sx={{ overflowWrap: 'anywhere' }}>
                  {f.lastError}
                </Typography>
              )}
            </ListItem>
          ))}
        </List>
      </>
    );
  }

  return (
    <Box>
      {body}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
        {canRetry && (
          <Button variant="outlined" size="small" onClick={onRetry} disabled={retrying} sx={{ minHeight: 40 }}>
            Retry failed
          </Button>
        )}
        {inTwa && (
          <Button size="small" href={mediaSyncDeepLink('files')} startIcon={<PhoneAndroidIcon />} sx={{ minHeight: 40 }}>
            Open file list on this phone
          </Button>
        )}
      </Box>
    </Box>
  );
}

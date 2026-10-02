/**
 * Stop/Start syncing, Retry failed and Sync now for one phone (issue #515).
 *
 * Each button sends `POST /api/media-sync/devices/:id/commands`. A command
 * bumps the desired config, which the phone applies the next time it checks
 * in. Inside the app's own TWA the user is holding that very phone, so a row
 * of "on this phone" deep links (`memoriahub://media-sync?action=…`) makes it
 * act immediately instead. Presentation only: the deep link opens the phone's
 * own screen, which acts with the phone's own credential.
 */
import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ReplayIcon from '@mui/icons-material/Replay';
import SyncIcon from '@mui/icons-material/Sync';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import {
  mediaSyncErrorMessage,
  sendDeviceCommand,
  type MediaSyncCommand,
  type MediaSyncConfigResult,
  type MediaSyncDevice,
} from '../../../services/mediaSync';
import { mediaSyncDeepLink, type MediaSyncDeepLinkAction } from '../../../utils/androidIdentity';
import { useIsMounted } from '../../../hooks/useIsMounted';

export const COMMAND_APPLIES_LATER =
  'Commands reach the phone the next time it checks in.';

const COMMAND_DONE: Record<MediaSyncCommand, string> = {
  pause: 'Syncing stopped.',
  resume: 'Syncing started.',
  retry_failed: 'Failed files will be retried.',
  sync_now: 'A sync was requested.',
};

interface DeviceControlsProps {
  device: MediaSyncDevice;
  canWrite: boolean;
  inTwa: boolean;
  onChanged: (result: MediaSyncConfigResult) => void;
}

export function DeviceControls({ device, canWrite, inTwa, onChanged }: DeviceControlsProps) {
  const [busy, setBusy] = useState<MediaSyncCommand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const paused = device.config.paused;
  const disabled = !canWrite || device.status !== 'active' || busy !== null;

  const run = async (action: MediaSyncCommand) => {
    setBusy(action);
    setNotice(null);
    setError(null);
    try {
      const result = await sendDeviceCommand(device.id, action);
      if (!isMounted()) return;
      onChanged(result);
      setNotice(`${COMMAND_DONE[action]} ${inTwa ? '' : COMMAND_APPLIES_LATER}`.trim());
    } catch (err) {
      if (isMounted()) setError(mediaSyncErrorMessage(err, 'The command failed. Try again.'));
    } finally {
      if (isMounted()) setBusy(null);
    }
  };

  const icon = (action: MediaSyncCommand, fallback: ReactNode) =>
    busy === action ? <CircularProgress size={16} color="inherit" /> : fallback;

  const phoneLinks: Array<{ action: MediaSyncDeepLinkAction; label: string }> = [
    { action: 'apply', label: 'Apply now on this phone' },
    { action: 'sync', label: 'Sync now on this phone' },
    { action: 'retry', label: 'Retry failed on this phone' },
    paused
      ? { action: 'resume', label: 'Start syncing on this phone' }
      : { action: 'pause', label: 'Stop syncing on this phone' },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button
          variant="outlined"
          color={paused ? 'primary' : 'warning'}
          startIcon={icon(paused ? 'resume' : 'pause', paused ? <PlayArrowIcon /> : <PauseIcon />)}
          disabled={disabled}
          onClick={() => void run(paused ? 'resume' : 'pause')}
          sx={{ minHeight: 44 }}
        >
          {paused ? 'Start syncing' : 'Stop syncing'}
        </Button>
        <Button
          variant="outlined"
          startIcon={icon('retry_failed', <ReplayIcon />)}
          disabled={disabled}
          onClick={() => void run('retry_failed')}
          sx={{ minHeight: 44 }}
        >
          Retry failed
        </Button>
        <Button
          variant="outlined"
          startIcon={icon('sync_now', <SyncIcon />)}
          disabled={disabled || paused}
          onClick={() => void run('sync_now')}
          sx={{ minHeight: 44 }}
        >
          Sync now
        </Button>
      </Box>

      {!inTwa && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, mb: 0 }}>
          {COMMAND_APPLIES_LATER}
        </Typography>
      )}

      {inTwa && device.status === 'active' && (
        <Stack spacing={0.5} sx={{ mt: 1.5 }} data-testid="on-this-phone">
          <Typography variant="caption" color="text.secondary">
            On this phone (applies immediately):
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {phoneLinks.map(({ action, label }) => (
              <Button
                key={action}
                size="small"
                variant={action === 'apply' ? 'contained' : 'text'}
                href={mediaSyncDeepLink(undefined, action)}
                startIcon={<PhoneAndroidIcon />}
                sx={{ minHeight: 40 }}
              >
                {label}
              </Button>
            ))}
          </Box>
        </Stack>
      )}

      {notice && (
        <Alert severity="success" sx={{ mt: 1 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
    </Box>
  );
}

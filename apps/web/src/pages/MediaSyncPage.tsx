/**
 * Settings → Media sync (`/settings/media-sync`), issue #515, epic #498.
 *
 * Every phone paired to back up its photos and videos: what it has synced and
 * what is missing (as of its last check-in), why it is not syncing, its
 * desired configuration, Stop/Start, Retry failed, Sync now, the last run's
 * failures, its sync history and uploaded diagnostic reports, and Unpair.
 * No phone yet: how to get the Android app.
 *
 * Reachability is gated outside this file: the route wraps it in
 * `RequirePermission('media:read')`, the permission the media-sync
 * controller's reads enforce. Writes need `media:write` and are disabled
 * without it; the API enforces both either way. Refetches every 30 s while
 * the page is visible.
 *
 * Inside the app's own TWA the user is holding a phone, so the page also
 * offers deep links into the native Media sync screen. Presentation only.
 */
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Container,
  Link,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import { usePermissions } from '../hooks/usePermissions';
import { useCircle } from '../hooks/useCircle';
import { MEDIA_SYNC_POLL_MS, useLatestRelease, useMediaSyncDevices } from '../hooks/useMediaSync';
import { ANDROID_APP_SETTINGS_PATH } from '../services/androidApp';
import type { MediaSyncDevice } from '../services/mediaSync';
import { mediaSyncDeepLink } from '../utils/androidIdentity';
import { isRunningInTwa } from '../utils/twa';
import { DeviceCard } from '../components/settings/mediaSync/DeviceCard';
import { GetAndroidApp } from '../components/settings/mediaSync/GetAndroidApp';
import { UnpairDialog } from '../components/settings/mediaSync/UnpairDialog';
import type { TargetCircleOption } from '../components/settings/mediaSync/MediaSyncConfigEditor';

export const MEDIA_SYNC_TITLE = 'Media sync';
export const MEDIA_SYNC_DESCRIPTION =
  'Phones that back up their photos and videos to this server: what is synced, what is missing, and how each one syncs.';
export const OPEN_MEDIA_SYNC_LABEL = 'Open Media sync on this phone';

export default function MediaSyncPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('media:write');
  const canPickAnyCircle = hasPermission('circles:manage_any');
  const [inTwa] = useState(() => isRunningInTwa());
  const { devices, isLoading, error, refresh, reload } = useMediaSyncDevices({ pollMs: MEDIA_SYNC_POLL_MS });
  const { release } = useLatestRelease();
  const { circles } = useCircle();
  const [unpairing, setUnpairing] = useState<MediaSyncDevice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Circles the user may sync into: collaborator or admin there (or the
  // super-admin bypass). The API re-checks on save.
  const targetCircles = useMemo<TargetCircleOption[]>(
    () =>
      circles
        .filter((c) => canPickAnyCircle || c.memberRole === 'collaborator' || c.memberRole === 'circle_admin')
        .map((c) => ({ id: c.id, name: c.isPersonal ? `${c.name} (personal)` : c.name })),
    [circles, canPickAnyCircle],
  );

  // Active phones first, then unpaired ones.
  const ordered = useMemo(
    () => [...devices].sort((a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked')),
    [devices],
  );
  const activeCount = devices.filter((d) => d.status === 'active').length;

  let body;
  if (isLoading && devices.length === 0) {
    body = (
      <Box data-testid="media-sync-loading">
        <Skeleton variant="rounded" height={160} />
      </Box>
    );
  } else if (error && devices.length === 0) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  } else if (devices.length === 0) {
    body = (
      <Card variant="outlined">
        <CardContent>
          <GetAndroidApp release={release} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Then open the app, enter this server's address and tap Connect on its Media sync screen.
          </Typography>
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <Stack spacing={2}>
        {ordered.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            circles={targetCircles}
            canWrite={canWrite}
            inTwa={inTwa}
            defaultSettingsOpen={activeCount === 1 && device.status === 'active'}
            onChanged={() => void reload()}
            onUnpair={setUnpairing}
          />
        ))}
        <Typography variant="body2" color="text.secondary">
          Adding another phone?{' '}
          <Link component={RouterLink} to={ANDROID_APP_SETTINGS_PATH}>
            Get the Android app
          </Link>
        </Typography>
      </Stack>
    );
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {MEDIA_SYNC_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {MEDIA_SYNC_DESCRIPTION}
        </Typography>

        {!canWrite && devices.length > 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can see your phones but not change how they sync.
          </Alert>
        )}

        {inTwa && (
          <Button
            variant="contained"
            href={mediaSyncDeepLink()}
            startIcon={<PhoneAndroidIcon />}
            sx={{ mb: 2, minHeight: 44 }}
          >
            {OPEN_MEDIA_SYNC_LABEL}
          </Button>
        )}

        {body}
      </Box>

      <UnpairDialog
        device={unpairing}
        onClose={() => setUnpairing(null)}
        onUnpaired={(device) => {
          setUnpairing(null);
          setNotice(`${device.name} was unpaired.`);
          void reload();
        }}
      />

      <Snackbar open={notice !== null} autoHideDuration={4000} onClose={() => setNotice(null)} message={notice} />
    </Container>
  );
}

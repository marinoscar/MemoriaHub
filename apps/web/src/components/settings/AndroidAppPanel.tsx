/**
 * The "Android app" section of `/settings` (issue #515), `id="android-app"`
 * for hash deep links.
 *
 *   - No phone paired: "Get the MemoriaHub Android app" with the version and
 *     Download (to `/settings/android-app`).
 *   - Phones paired: a compact list (name, Synced N / Missing N, last seen,
 *     status chip) and Manage (to `/settings/media-sync`).
 *   - Inside the TWA: Open Media sync / Diagnostics on this phone.
 *
 * Devices are only fetched for `media:read` holders (the API would 403);
 * without it the panel still offers the download.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  List,
  ListItem,
  Skeleton,
  Typography,
} from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import { usePermissions } from '../../hooks/usePermissions';
import { useLatestRelease, useMediaSyncDevices } from '../../hooks/useMediaSync';
import { ANDROID_APP_SETTINGS_PATH, MEDIA_SYNC_SETTINGS_PATH } from '../../services/androidApp';
import { syncCounts } from '../../services/mediaSync';
import { mediaSyncDeepLink } from '../../utils/androidIdentity';
import { formatCount, formatRelativeTime } from '../../utils/runFormat';
import { isRunningInTwa } from '../../utils/twa';
import { RunStatusChip } from './mediaSync/RunStatusChip';
import { GetAndroidApp } from './mediaSync/GetAndroidApp';

export function AndroidAppPanel() {
  const { hasPermission } = usePermissions();
  const canReadDevices = hasPermission('media:read');
  const [inTwa] = useState(() => isRunningInTwa());
  const { devices, isLoading } = useMediaSyncDevices({ enabled: canReadDevices });
  const { release } = useLatestRelease();
  const active = devices.filter((d) => d.status === 'active');

  let body;
  if (canReadDevices && isLoading && devices.length === 0) {
    body = <Skeleton width="60%" data-testid="android-app-panel-loading" />;
  } else if (active.length === 0) {
    body = <GetAndroidApp release={release} />;
  } else {
    body = (
      <>
        <List dense disablePadding aria-label="Paired phones">
          {active.map((device) => {
            const counts = syncCounts(device.stats);
            return (
              <ListItem key={device.id} divider disableGutters sx={{ display: 'block' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="body1" sx={{ fontWeight: 500, overflowWrap: 'anywhere', minWidth: 0 }}>
                    {device.name}
                  </Typography>
                  {device.config.paused ? (
                    <Chip size="small" label="Paused" />
                  ) : device.lastSyncStatus ? (
                    <RunStatusChip status={device.lastSyncStatus} />
                  ) : (
                    <Chip size="small" variant="outlined" label="Never synced" />
                  )}
                </Box>
                <Typography variant="body2" color="text.secondary" data-testid={`panel-counts-${device.id}`}>
                  {counts
                    ? `Synced ${formatCount(counts.synced)} / Missing ${formatCount(counts.missing)}`
                    : 'No counts yet'}
                  {' · '}
                  {device.lastSeenAt ? `last seen ${formatRelativeTime(device.lastSeenAt)}` : 'not seen yet'}
                </Typography>
              </ListItem>
            );
          })}
        </List>
        <Button component={RouterLink} to={MEDIA_SYNC_SETTINGS_PATH} variant="contained" sx={{ mt: 2, minHeight: 44 }}>
          Manage
        </Button>
      </>
    );
  }

  return (
    <Card id="android-app">
      <CardContent>
        <Typography variant="h6" component="h2" gutterBottom>
          Android app
        </Typography>
        {body}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
          {active.length > 0 && (
            <Button component={RouterLink} to={ANDROID_APP_SETTINGS_PATH} size="small">
              Download the app
            </Button>
          )}
          {inTwa && (
            <>
              <Button size="small" href={mediaSyncDeepLink()} startIcon={<PhoneAndroidIcon />} sx={{ minHeight: 40 }}>
                Open Media sync on this phone
              </Button>
              <Button
                size="small"
                href={mediaSyncDeepLink('diagnostics')}
                startIcon={<PhoneAndroidIcon />}
                sx={{ minHeight: 40 }}
              >
                Diagnostics on this phone
              </Button>
            </>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

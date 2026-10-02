/**
 * One paired phone on the Media Sync page (issue #515, spec §15.2):
 *
 *   header        name and model, app version, last sync status, last seen,
 *                 "Update available", "Pairing expires in N days"
 *   counts        Synced / Missing / Failed / Blocked / bytes left + progress
 *   status lines  Paused, Waiting for Wi-Fi, photo access, battery, changes pending
 *   controls      Stop/Start, Retry failed, Sync now (+ "on this phone" in the TWA)
 *   sections      Sync settings, Failed files, Sync history, Diagnostics
 *   Unpair
 *
 * The sections are accordions inside ONE card (one destination), not tabs.
 * Writes are offered only to `media:write` holders; the API enforces it
 * either way.
 */
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import SystemUpdateIcon from '@mui/icons-material/SystemUpdate';
import {
  PAIRING_WARN_DAYS,
  daysUntil,
  deviceStatusLines,
  mediaSyncErrorMessage,
  sendDeviceCommand,
  type MediaSyncConfigResult,
  type MediaSyncDevice,
} from '../../../services/mediaSync';
import { ANDROID_APP_SETTINGS_PATH } from '../../../services/androidApp';
import { mediaSyncDeepLink } from '../../../utils/androidIdentity';
import { formatRelativeTime } from '../../../utils/runFormat';
import { useDeviceRuns } from '../../../hooks/useMediaSync';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { RunStatusChip } from './RunStatusChip';
import { SyncCountTiles } from './SyncCountTiles';
import { DeviceControls } from './DeviceControls';
import { MediaSyncConfigEditor, type TargetCircleOption } from './MediaSyncConfigEditor';
import { FailedFiles } from './FailedFiles';
import { SyncHistory } from './SyncHistory';
import { DiagnosticsSection } from './DiagnosticsSection';

type Section = 'settings' | 'failures' | 'history' | 'diagnostics';

interface DeviceCardProps {
  device: MediaSyncDevice;
  circles: TargetCircleOption[];
  canWrite: boolean;
  inTwa: boolean;
  /** Open the settings section initially (a single phone). */
  defaultSettingsOpen?: boolean;
  onChanged: (result?: MediaSyncConfigResult) => void;
  onUnpair: (device: MediaSyncDevice) => void;
}

function PairingExpiry({ device }: { device: MediaSyncDevice }) {
  const days = daysUntil(device.tokenExpiresAt);
  if (days === null || days >= PAIRING_WARN_DAYS) return null;
  if (days < 0) {
    return (
      <Alert severity="error" data-testid="pairing-expired">
        The pairing expired. Pair the phone again from the app.
      </Alert>
    );
  }
  return (
    <Alert severity="warning" data-testid="pairing-expiring">
      Pairing expires in {days === 1 ? '1 day' : `${days} days`}. The app asks you to pair again.
    </Alert>
  );
}

export function DeviceCard({
  device,
  circles,
  canWrite,
  inTwa,
  defaultSettingsOpen = false,
  onChanged,
  onUnpair,
}: DeviceCardProps) {
  const [open, setOpen] = useState<Record<Section, boolean>>({
    settings: defaultSettingsOpen,
    failures: false,
    history: false,
    diagnostics: false,
  });
  const runsWanted = open.failures || open.history;
  const { runs, isLoading: runsLoading, error: runsError, refresh: refreshRuns } = useDeviceRuns(device.id, runsWanted);
  const [retrying, setRetrying] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const revoked = device.status === 'revoked';
  const hardware = [device.manufacturer, device.model].filter(Boolean).join(' ');
  const statusLines = revoked ? [] : deviceStatusLines(device);
  const headingId = `device-${device.id}-name`;

  const toggle = (section: Section) => (_: unknown, expanded: boolean) =>
    setOpen((o) => ({ ...o, [section]: expanded }));

  const retryFailed = async () => {
    setRetrying(true);
    setRetryNotice(null);
    try {
      const result = await sendDeviceCommand(device.id, 'retry_failed');
      if (!isMounted()) return;
      setRetryNotice('Failed files will be retried the next time the phone checks in.');
      onChanged(result);
    } catch (err) {
      if (isMounted()) setRetryNotice(mediaSyncErrorMessage(err, 'The command failed. Try again.'));
    } finally {
      if (isMounted()) setRetrying(false);
    }
  };

  const section = (key: Section, title: string, content: ReactNode) => (
    <Accordion disableGutters elevation={0} expanded={open[key]} onChange={toggle(key)} sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls={`device-${device.id}-${key}`} id={`device-${device.id}-${key}-header`}>
        <Typography>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails id={`device-${device.id}-${key}`}>{open[key] && content}</AccordionDetails>
    </Accordion>
  );

  return (
    <Card variant="outlined" component="article" aria-labelledby={headingId} data-testid={`device-card-${device.id}`}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
          <PhoneAndroidIcon color="action" sx={{ mt: 0.5 }} />
          <Box sx={{ flex: '1 1 180px', minWidth: 0 }}>
            <Typography variant="h6" component="h2" id={headingId} sx={{ overflowWrap: 'anywhere' }}>
              {device.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {[hardware, device.androidVersion && `Android ${device.androidVersion}`, device.appVersion && `App ${device.appVersion}`]
                .filter(Boolean)
                .join(' · ') || 'Unknown phone'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {device.lastSeenAt ? `Last seen ${formatRelativeTime(device.lastSeenAt)}` : 'Not seen yet'}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            {!revoked && device.updateAvailable && (
              <Chip
                size="small"
                color="warning"
                icon={<SystemUpdateIcon />}
                clickable
                component={RouterLink}
                to={ANDROID_APP_SETTINGS_PATH}
                label="Update available"
                data-testid="device-update-available"
              />
            )}
            {revoked ? (
              <Chip size="small" label="Unpaired" />
            ) : device.lastSyncStatus ? (
              <RunStatusChip status={device.lastSyncStatus} />
            ) : (
              <Chip size="small" variant="outlined" label="Never synced" />
            )}
          </Box>
        </Box>

        <Stack spacing={1.5} sx={{ mt: 2 }}>
          {!revoked && <PairingExpiry device={device} />}
          {revoked && (
            <Alert severity="info">This phone was unpaired. It no longer syncs; its uploaded media stays.</Alert>
          )}
          <SyncCountTiles device={device} />
          {statusLines.map((line) => (
            <Alert
              key={line.key}
              severity={line.severity}
              data-testid={`status-${line.key}`}
              action={
                line.key === 'config_pending' && inTwa ? (
                  <Button color="inherit" size="small" href={mediaSyncDeepLink(undefined, 'apply')}>
                    Apply now on this phone
                  </Button>
                ) : undefined
              }
            >
              {line.message}
            </Alert>
          ))}
          {device.lastError && !revoked && (
            <Alert severity="error" data-testid="device-last-error" sx={{ overflowWrap: 'anywhere' }}>
              {device.lastError}
            </Alert>
          )}
          {!revoked && (
            <DeviceControls device={device} canWrite={canWrite} inTwa={inTwa} onChanged={onChanged} />
          )}
        </Stack>
      </CardContent>

      <Box sx={{ px: 1 }}>
        {!revoked &&
          section(
            'settings',
            'Sync settings',
            <MediaSyncConfigEditor device={device} circles={circles} canWrite={canWrite} onSaved={onChanged} />,
          )}
        {section(
          'failures',
          'Failed files',
          <>
            <FailedFiles
              device={device}
              runs={runs}
              isLoading={runsLoading}
              error={runsError}
              inTwa={inTwa}
              canRetry={canWrite && !revoked}
              retrying={retrying}
              onRetry={() => void retryFailed()}
            />
            {retryNotice && (
              <Alert severity="info" sx={{ mt: 1 }} onClose={() => setRetryNotice(null)}>
                {retryNotice}
              </Alert>
            )}
          </>,
        )}
        {section(
          'history',
          'Sync history',
          <SyncHistory runs={runs} isLoading={runsLoading} error={runsError} onRetry={() => void refreshRuns()} />,
        )}
        {section('diagnostics', 'Diagnostics', <DiagnosticsSection deviceId={device.id} inTwa={inTwa} />)}
      </Box>

      {canWrite && !revoked && (
        <CardActions sx={{ justifyContent: 'flex-end' }}>
          <Button color="error" onClick={() => onUnpair(device)} aria-label={`Unpair ${device.name}`} sx={{ minHeight: 44 }}>
            Unpair
          </Button>
        </CardActions>
      )}
    </Card>
  );
}

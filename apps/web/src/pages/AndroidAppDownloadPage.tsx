/**
 * Settings → Android app (`/settings/android-app`), issue #515, epic #498.
 *
 * The APK this server hosts: version, release date, size, notes, a Download
 * button, how to install it (including removing the legacy v1 app), and the
 * SHA-256 to check the file against. Inside the app's own TWA it also says
 * whether the installed build is current.
 *
 * Ungated on purpose: the latest-release and download-link routes are
 * `@Auth()` with no permission, so every signed-in user may install the app.
 * Whether an update exists is decided by comparing the API's versionCode
 * with the one the TWA launch URL reported; nothing here grants anything.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Container,
  IconButton,
  Link,
  Skeleton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useLatestRelease } from '../hooks/useMediaSync';
import { usePermissions } from '../hooks/usePermissions';
import {
  ANDROID_APP_ADMIN_PATH,
  formatMegabytes,
  type PublicRelease,
} from '../services/androidApp';
import { LEGACY_ANDROID_PACKAGE_NAME } from '../utils/androidIdentity';
import { getInstalledAppVersion, isRunningInTwa, type InstalledAppVersion } from '../utils/twa';
import { DownloadApkButton } from '../components/settings/androidApp/DownloadApkButton';
import { APP_NAME } from '../constants/app';

export const ANDROID_APP_PAGE_TITLE = 'Android app';
export const ANDROID_APP_PAGE_DESCRIPTION =
  'Download and install the Android app, which backs up photos and videos from your phone automatically.';
export const NO_RELEASE_MESSAGE = 'No Android release has been published yet.';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** Copy a value with a toast; the value stays selectable when the clipboard is blocked. */
function CopyableValue({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked: the value stays selectable on screen.
    }
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
      <Box
        component="code"
        data-testid={testId}
        sx={{ fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere', flex: 1, minWidth: 0, pt: 1 }}
      >
        {value}
      </Box>
      <Tooltip title={`Copy ${label}`}>
        <IconButton aria-label={`Copy ${label}`} onClick={() => void copy()}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message={`${label[0].toUpperCase()}${label.slice(1)} copied`}
      />
    </Box>
  );
}

function InstalledStatus({ installed, release }: { installed: InstalledAppVersion; release: PublicRelease }) {
  const label = installed.versionName ?? `build ${installed.versionCode}`;
  if (installed.versionCode >= release.versionCode) {
    return (
      <Alert severity="success" data-testid="installed-up-to-date">
        You're up to date ({label}).
      </Alert>
    );
  }
  return (
    <Alert severity="warning" data-testid="installed-update-available">
      Update available: {release.versionName}. You have {label}.
    </Alert>
  );
}

function InstallSteps() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Box component="ol" sx={{ m: 0, pl: 3 }} aria-label="Install steps">
      <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
        Tap Download APK. When Android asks, allow installing apps from your browser.
      </Typography>
      <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
        Open the downloaded file and tap Install (or Update).
      </Typography>
      <Typography component="li" variant="body2" sx={{ mb: 0.5 }} data-testid="legacy-app-step">
        If the older {APP_NAME} app (v1, package{' '}
        <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
          {LEGACY_ANDROID_PACKAGE_NAME}
        </Box>
        ) is installed, uninstall it. It is a separate app and keeps syncing on its own otherwise.
      </Typography>
      <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
        Open the app and enter this server's address:
        <CopyableValue label="server address" value={origin} testId="server-origin" />
      </Typography>
    </Box>
  );
}

function ReleaseCards({ release, installed }: { release: PublicRelease; installed: InstalledAppVersion | null }) {
  const updateAvailable = installed !== null && installed.versionCode < release.versionCode;
  const upToDate = installed !== null && !updateAvailable;

  return (
    <Stack spacing={2}>
      {installed && <InstalledStatus installed={installed} release={release} />}

      <Card variant="outlined" component="section" aria-labelledby="android-release-title">
        <CardContent>
          <Typography variant="h6" component="h2" id="android-release-title">
            Version {release.versionName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Released {formatDate(release.createdAt)} · {formatMegabytes(release.sizeBytes)} · build{' '}
            {release.versionCode}
          </Typography>
          {release.notes && (
            <Typography variant="body2" sx={{ mb: 2, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
              {release.notes}
            </Typography>
          )}
          <DownloadApkButton release={release} emphasized={updateAvailable} quiet={upToDate} />
        </CardContent>
      </Card>

      <Card variant="outlined" component="section" aria-labelledby="android-install-title">
        <CardContent>
          <Typography variant="h6" component="h2" id="android-install-title" gutterBottom>
            Install it
          </Typography>
          <InstallSteps />
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" component="h3">
              SHA-256 checksum
            </Typography>
            <CopyableValue label="checksum" value={release.fileSha256} testId="release-sha256" />
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default function AndroidAppDownloadPage() {
  const { release, isLoading, error, refresh } = useLatestRelease();
  const { hasPermission } = usePermissions();
  const [installed] = useState(() => (isRunningInTwa() ? getInstalledAppVersion() : null));

  let body;
  if (isLoading && !release) {
    body = <Skeleton variant="rounded" height={200} data-testid="android-app-loading" />;
  } else if (error && !release) {
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
  } else if (!release) {
    body = (
      <Alert severity="info" data-testid="no-release">
        {NO_RELEASE_MESSAGE}
        {hasPermission('system_settings:read') && (
          <>
            {' '}
            <Link component={RouterLink} to={ANDROID_APP_ADMIN_PATH}>
              Publish a release
            </Link>
          </>
        )}
      </Alert>
    );
  } else {
    body = <ReleaseCards release={release} installed={installed} />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {ANDROID_APP_PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {ANDROID_APP_PAGE_DESCRIPTION}
        </Typography>
        {body}
      </Box>
    </Container>
  );
}

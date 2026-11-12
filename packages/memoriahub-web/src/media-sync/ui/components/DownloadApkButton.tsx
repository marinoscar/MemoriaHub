/**
 * "Download APK" (issue #515). Asks the API for a short-lived download link,
 * then NAVIGATES to it: a real navigation, not a fetch or a blob, is what
 * lets Chrome and the TWA on Android download the file natively and hand it
 * to the package installer. The link is minted per click because it expires
 * after ten minutes. The link comes from the platform android-app client
 * (RETRO-D5, #586) over the platform host.
 */
import { useState } from 'react';
import { Alert, Box, Button, CircularProgress } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useIsMounted, useMemoriahubAndroid } from '../../../core/headless/index.js';
import { downloadNavigator, type PublicRelease } from '../../headless/services/androidApp.js';
import { mediaSyncErrorMessage } from '../../headless/services/mediaSync.js';

/**
 * The label of the download button.
 *
 * @stability experimental
 */
export const DOWNLOAD_APK_LABEL = 'Download APK';

/**
 * The props of {@link DownloadApkButton}.
 *
 * @stability experimental
 */
export interface DownloadApkButtonProps {
  release: Pick<PublicRelease, 'id' | 'versionName'>;
  /** Draw the button as the page's call to action (an update is waiting). */
  emphasized?: boolean;
  /** Draw it quietly (the installed build is already current). */
  quiet?: boolean;
}

/**
 * Mints a short-lived download link and navigates to it, so Android hands the APK to the installer.
 *
 * @stability experimental
 */
export function DownloadApkButton({ release, emphasized = false, quiet = false }: DownloadApkButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const client = useMemoriahubAndroid().useAndroidDownloadLink();

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await client.downloadLink(release.id);
      downloadNavigator.assign(link.url);
    } catch (err) {
      if (isMounted()) setError(mediaSyncErrorMessage(err, 'Could not start the download. Try again.'));
    } finally {
      if (isMounted()) setBusy(false);
    }
  };

  return (
    <Box>
      <Button
        variant={quiet ? 'outlined' : 'contained'}
        color={emphasized ? 'warning' : 'primary'}
        size={emphasized ? 'large' : 'medium'}
        startIcon={busy ? <CircularProgress size={18} color="inherit" /> : <DownloadIcon />}
        disabled={busy}
        onClick={() => void download()}
        aria-label={`${DOWNLOAD_APK_LABEL} ${release.versionName}`}
        sx={{ minHeight: 44 }}
      >
        {DOWNLOAD_APK_LABEL}
      </Button>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}

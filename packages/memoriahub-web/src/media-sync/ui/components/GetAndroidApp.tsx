/**
 * "Get the MemoriaHub Android app" (issue #515): the empty state of the
 * Media Sync page and of the `/settings` Android app panel. Links to the
 * Android app page, which serves the APK this server hosts.
 */
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import { useMemoriahubAndroid } from '../../../core/headless/index.js';
import { ANDROID_APP_SETTINGS_PATH, type PublicRelease } from '../../headless/services/androidApp.js';

/**
 * The empty-state title for an app name.
 *
 * @param appName - the product name
 * @returns `Get the <appName> Android app`
 * @stability experimental
 */
export const getAppTitle = (appName: string): string => `Get the ${appName} Android app`;
/**
 * The one-line pitch of the Android app.
 *
 * @stability experimental
 */
export const GET_APP_PITCH = 'Back up photos and videos from your phone automatically.';

/**
 * The empty state that points at the Android app download page.
 *
 * @stability experimental
 */
export function GetAndroidApp({ release }: { release: Pick<PublicRelease, 'versionName'> | null }) {
  const { appName } = useMemoriahubAndroid();
  return (
    <Box data-testid="get-android-app">
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
        {getAppTitle(appName)}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {GET_APP_PITCH}
        {release ? ` Version ${release.versionName}.` : ''}
      </Typography>
      <Button
        variant="contained"
        component={RouterLink}
        to={ANDROID_APP_SETTINGS_PATH}
        startIcon={<PhoneAndroidIcon />}
        sx={{ minHeight: 44 }}
      >
        Download
      </Button>
    </Box>
  );
}

/**
 * "Get the MemoriaHub Android app" (issue #515): the empty state of the
 * Media Sync page and of the `/settings` Android app panel. Links to the
 * Android app page, which serves the APK this server hosts.
 */
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import { ANDROID_APP_SETTINGS_PATH, type PublicRelease } from '../../../services/androidApp';
import { APP_NAME } from '../../../constants/app';

export const GET_APP_TITLE = `Get the ${APP_NAME} Android app`;
export const GET_APP_PITCH = 'Back up photos and videos from your phone automatically.';

export function GetAndroidApp({ release }: { release: Pick<PublicRelease, 'versionName'> | null }) {
  return (
    <Box data-testid="get-android-app">
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 500 }}>
        {GET_APP_TITLE}
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

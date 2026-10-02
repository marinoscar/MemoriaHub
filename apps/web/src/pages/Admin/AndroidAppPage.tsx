/**
 * Admin → Settings → Android app (`/admin/settings/android`). Issue #516,
 * epic #498; spec docs/specs/android-media-sync.md §15.2.
 *
 * Two stacked sections, not tabs: they are different jobs (publishing APKs,
 * trusting signers), and the Settings UI pattern reserves tabs for parallel
 * views of one question.
 *
 *   1. Releases (`AndroidReleasesSection`): current release, browser upload
 *      with the CLI's sidecar auto-fill and progress, make current / rollback,
 *      delete.
 *   2. Trusted signing keys (`TrustedSigningKeysSection`): the trusted list,
 *      phones' reported signers with one-click Trust, and the live
 *      `assetlinks.json` preview.
 *
 * Reachability: one card in `ADMIN_SECTIONS` gated on `system_settings:read`,
 * the exact permission `GET /api/admin/android-app` and the release list
 * enforce; a direct visit without it redirects home like its neighbours.
 * Writes are gated inside the page on `system_settings:write` (disabled
 * controls with a reason); the API enforces both regardless.
 *
 * No "N devices behind" count (spec §22 D19): no admin device aggregate exists.
 */
import { useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Box, Container, Skeleton, Stack } from '@mui/material';
import AndroidIcon from '@mui/icons-material/Android';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';
import { AndroidReleasesSection } from '../../components/admin/androidApp/AndroidReleasesSection';
import { TrustedSigningKeysSection } from '../../components/admin/androidApp/TrustedSigningKeysSection';
import { useAndroidAppConfig } from '../../hooks/useAndroidApp';
import { usePermissions } from '../../hooks/usePermissions';

/** Mirrors the `Android app` card in `config/adminSections.tsx`. */
export const ANDROID_APP_TITLE = 'Android app';
export const ANDROID_APP_DESCRIPTION =
  'Publish the Android app’s APK, roll back to an earlier release, and trust its signing keys so it opens full screen.';
export const READ_ONLY_MESSAGE =
  'You can view these settings. Uploading releases or changing trusted keys needs permission to change system settings.';

function AndroidAppContent({ canWrite }: { canWrite: boolean }) {
  const { config, isLoading, error, isSaving, save, refresh } = useAndroidAppConfig();
  // Upload-as-current and make-current trust the signer server-side.
  const onTrustMayHaveChanged = useCallback(() => void refresh(), [refresh]);

  let trustedSection;
  if (isLoading && !config) {
    trustedSection = <Skeleton variant="rounded" height={200} />;
  } else if (error && !config) {
    trustedSection = <Alert severity="error">{error}</Alert>;
  } else if (config) {
    trustedSection = (
      <TrustedSigningKeysSection canWrite={canWrite} config={config} isSaving={isSaving} save={save} />
    );
  }

  return (
    <Stack spacing={3}>
      <AndroidReleasesSection canWrite={canWrite} config={config} onTrustMayHaveChanged={onTrustMayHaveChanged} />
      {trustedSection}
    </Stack>
  );
}

export default function AndroidAppPage() {
  const { hasPermission } = usePermissions();

  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  return (
    <Container maxWidth="md">
      <Box sx={{ py: { xs: 2, sm: 4 }, minWidth: 0 }}>
        <AdminPageHeader
          title={ANDROID_APP_TITLE}
          icon={<AndroidIcon color="primary" />}
          description={ANDROID_APP_DESCRIPTION}
        />
        {!canWrite && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {READ_ONLY_MESSAGE}
          </Alert>
        )}
        <AndroidAppContent canWrite={canWrite} />
      </Box>
    </Container>
  );
}

/**
 * Admin → Settings → Android app (`/admin/settings/android`).
 *
 * The platform's page (RETRO-D5, #586): trusted signing keys with the apps paired
 * phones report (from MemoriaHub's Media Sync device source), the hosted APK releases
 * (upload, make current = rollback, delete), the `assetlinks.json` preview and the
 * Android test notification. Reads need `system_settings:read`, writes are gated
 * inside the page on `system_settings:write`, exactly what the API enforces. The
 * client is the package default over the platform host; the APK upload goes through
 * the host's `postFormData` port (`platform/platformHost.tsx`), which streams the
 * file from the browser and never buffers it here.
 *
 * Lazy-loaded by `App.tsx`; the registry card stays in `config/adminSections.tsx`.
 */
import { AndroidAppPage as PackagedAndroidAppPage } from '@marinoscar/platform-web/android-app/ui';

export default function AndroidAppPage() {
  return <PackagedAndroidAppPage />;
}

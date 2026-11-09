/**
 * Admin → Settings → Storage (`/admin/settings/storage`).
 *
 * The platform's page (RETRO-D1, #563): the active storage driver (Amazon S3, Cloudflare R2,
 * S3-compatible, or MemoriaHub's `local` disk driver) with its generated settings form and
 * write-only secrets, "Test connection", bucket provisioning, the switch confirmation, and the
 * copy-only provider migration panel with live progress and run history. It replaces MemoriaHub's
 * own Storage Providers page; `/admin/settings/storage/providers` redirects here.
 *
 * Gated on `storage_config:read` (the API's `GET /api/admin/storage-config`); writes are gated
 * inside the page on `storage_config:write`. The registry card is in `config/adminSections.tsx`,
 * the route in `App.tsx`.
 */
import { StorageConfigPage as PackagedStorageConfigPage } from '@marinoscar/platform-web/storage/ui';

export default function StorageConfigPage() {
  return <PackagedStorageConfigPage />;
}

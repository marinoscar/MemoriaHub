import { DataTable } from '@marinoscar/platform-web/datatable/ui';
import { createIdentityApi, type IdentityWebAdapters } from '@marinoscar/platform-web/identity/headless';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { APP_NAME } from '../constants/app';
import { appPlatformApi } from './platformHost';

/**
 * What the packaged identity pages take from MemoriaHub (RETRO-B2, #611).
 *
 * A module constant: the provider keys on its identity.
 *
 *   - `api`: the identity calls go through the app's own client (`appPlatformApi`:
 *     the one bearer token, the one refresh-and-retry), because the login and
 *     `/activate` pages render outside the platform host.
 *   - `DataTable`: the responsive `DataTable` of `@marinoscar/platform-web/datatable/ui`
 *     (RETRO-F1, #571, which moved every app table onto it), so the Users,
 *     Allowlist and Access Tokens lists get the same card layout, column picker
 *     and CSV export as every other table instead of the plain fallback.
 */
export const appIdentityAdapters: IdentityWebAdapters = {
  appName: APP_NAME,
  Spinner: LoadingSpinner,
  DataTable,
  api: createIdentityApi(appPlatformApi),
};

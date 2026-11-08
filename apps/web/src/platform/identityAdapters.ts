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
 *   - `DataTable`: not handed in; the packaged lists use the plain MUI table
 *     fallback. The app's own `DataTable` (epic #238) predates the packaged
 *     one and is not assignable to the adapter's props; RETRO-B5 moves the app
 *     onto `@marinoscar/platform-web/datatable` and binds it here.
 */
export const appIdentityAdapters: IdentityWebAdapters = {
  appName: APP_NAME,
  Spinner: LoadingSpinner,
  api: createIdentityApi(appPlatformApi),
};

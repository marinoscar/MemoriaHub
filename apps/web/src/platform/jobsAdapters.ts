import { createJobsApi, type JobsWebAdapters } from '@marinoscar/platform-web/jobs/headless';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { appPlatformApi } from './platformHost';

/**
 * What the packaged Jobs and Job Insights pages take from MemoriaHub (RETRO-C1, #575).
 *
 * A module constant: the provider keys on its identity.
 *
 *   - `api`: the jobs calls go through the app's own client (`appPlatformApi`: the one bearer token,
 *     the one refresh-and-retry), the same as the identity adapters.
 *   - `Spinner`: the app's spinner, shown on the insights page's first load.
 *   - `DataTable`: not handed in; the packaged lists use the plain MUI table fallback. The app's own
 *     `DataTable` (epic #238) predates the packaged one and is not assignable to the adapter's props;
 *     the move to `@marinoscar/platform-web/datatable` is a later step (see local-exceptions.md,
 *     "Plain MUI tables"). The fallback draws no filter menu (the filters still apply through the
 *     query) and keeps the destructive-action confirmations.
 */
export const appJobsAdapters: JobsWebAdapters = {
  Spinner: LoadingSpinner,
  api: createJobsApi(appPlatformApi),
};

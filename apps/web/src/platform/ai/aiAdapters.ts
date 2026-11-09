import type { AiWebAdapters } from '@marinoscar/platform-web/ai/headless';

import { LoadingSpinner } from '../../components/common/LoadingSpinner';

/**
 * What the packaged AI pages take from MemoriaHub (RETRO-E4, #607): the app's spinner, drawn on
 * each page's first load. A module constant: the provider keys on its identity. The pages call the
 * API through the platform host's transport (`AppPlatformHostProvider`), so no client is handed in.
 */
export const appAiAdapters: AiWebAdapters = {
  Spinner: LoadingSpinner,
};

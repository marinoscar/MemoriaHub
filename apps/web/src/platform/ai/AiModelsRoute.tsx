/**
 * Admin -> Settings -> AI Models (`/admin/settings/ai/models`), RETRO-E4 (#607): the platform's
 * model catalogue (`AiModelsPage`, `GET /api/admin/ai/models`, `ai_config:read`; refresh and
 * per-model edits with `ai_config:write`). Behind `RequireAiEnabled` in `App.tsx`, and its card
 * carries `feature: 'ai'`: hidden while AI is off.
 */
import AiModelsPage from '@marinoscar/platform-web/ai/ui/models-page';
import { AiWebAdaptersProvider } from '@marinoscar/platform-web/ai/headless';

import { appAiAdapters } from './aiAdapters';

export default function AiModelsRoute() {
  return (
    <AiWebAdaptersProvider adapters={appAiAdapters}>
      <AiModelsPage />
    </AiWebAdaptersProvider>
  );
}

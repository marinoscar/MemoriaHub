/**
 * Admin -> Settings -> AI Usage (`/admin/settings/ai/usage`), RETRO-E4 (#607): the platform's usage
 * report (`AiUsagePage`, `GET /api/admin/ai/usage`, `ai_config:read`), read from `ai_usage_events`.
 * It counts the platform AI routes' calls; MemoriaHub's own features are not metered there until
 * RETRO-E2 moves them onto the platform runtime. Behind `RequireAiEnabled` in `App.tsx`, and its
 * card carries `feature: 'ai'`.
 */
import AiUsagePage from '@marinoscar/platform-web/ai/ui/usage-page';
import { AiWebAdaptersProvider } from '@marinoscar/platform-web/ai/headless';

import { appAiAdapters } from './aiAdapters';

export default function AiUsageRoute() {
  return (
    <AiWebAdaptersProvider adapters={appAiAdapters}>
      <AiUsagePage />
    </AiWebAdaptersProvider>
  );
}

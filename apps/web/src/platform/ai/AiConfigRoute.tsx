/**
 * Admin -> Settings -> AI (`/admin/settings/ai`), RETRO-E4 (#607).
 *
 * A thin binding over the platform's `AiConfigPage` (`@marinoscar/platform-web/ai/ui`): the master
 * switch, the key policy, the providers and their deployment keys (`PUT|DELETE
 * /api/admin/ai/providers/:provider/key`), hosted tools and the limits, gated on `ai_config:read`
 * (controls enabled with `ai_config:write`). It replaced MemoriaHub's own `AiSettingsPage`.
 *
 * What the platform has no word for, which provider and model serve each MemoriaHub feature, rides
 * in the page's `Sections` slot at the bottom ({@link MemoriaHubAiFeaturesSection}): content inside
 * this one destination, never a tab and never a card of its own.
 *
 * `slots` is a module constant: the platform keys on its identity.
 *
 * THE CARD CARRIES NO `feature`: this is where AI is switched on, so it stays reachable while AI is
 * off (AI rule 5).
 */
import AiConfigPage from '@marinoscar/platform-web/ai/ui/config-page';
import type { AiConfigPageSlots } from '@marinoscar/platform-web/ai/ui';
import { AiWebAdaptersProvider } from '@marinoscar/platform-web/ai/headless';
import type { PageSectionsSlotProps } from '@marinoscar/platform-web/core';

import { appAiAdapters } from './aiAdapters';
import { MemoriaHubAiFeaturesSection } from './MemoriaHubAiFeaturesSection';

function MemoriaHubAiSections({ position }: PageSectionsSlotProps) {
  return position === 'bottom' ? <MemoriaHubAiFeaturesSection /> : null;
}

const slots: AiConfigPageSlots = { Sections: MemoriaHubAiSections };

export default function AiConfigRoute() {
  return (
    <AiWebAdaptersProvider adapters={appAiAdapters}>
      <AiConfigPage slots={slots} />
    </AiWebAdaptersProvider>
  );
}

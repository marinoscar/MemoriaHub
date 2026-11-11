// =============================================================================
// The system settings the workflows specs start from
// =============================================================================
//
// The specs that moved out of the web app seeded `DEFAULT_SYSTEM_SETTINGS` (the app's whole settings
// document). The slice reads two namespaces through the settings port, `features` and `workflows`; this is
// the shape of those two with the app's defaults, so a spec spreads and overrides them as before.
// =============================================================================

import { settingsPortFrom } from './settings-port.js';

/** The `features` and `workflows` defaults (the web app's registry values). */
export const DEFAULT_SYSTEM_SETTINGS = {
  features: { workflows: false } as Record<string, boolean>,
  workflows: {
    maxItemsPerRun: 10000,
    batchSize: 200,
    maxConcurrentRuns: 2,
    requirePreview: true,
    allowHardDelete: false,
    maxWorkflowsPerCircle: 20,
    previewTtlHours: 24,
    runHistoryRetentionDays: 30,
    triggers: { onEnrichment: true, scheduled: true },
    scheduleMinIntervalMinutes: 60,
  },
};

/**
 * A settings port that answers from the object a spec's `getSettings` mock returns, so a test keeps writing
 * `systemSettings.getSettings.mockResolvedValue(settings(...))`.
 *
 * @param getSettings - the mock (or function) returning the settings document.
 */
export function settingsPortOver(getSettings: () => unknown) {
  return settingsPortFrom(async () => (await getSettings()) as Record<string, unknown>);
}

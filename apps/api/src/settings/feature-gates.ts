// =============================================================================
// Feature gates (RETRO-B3, #614)
// =============================================================================
//
// A feature is on when its `features.<flag>` system setting is on AND its env kill-switch is not
// explicitly 'false'. Each gate is the single source of truth for the server-side check and the
// client-visible one (`GET /api/features`), so the UI never offers an action the API rejects.
// =============================================================================

import { FEATURE_KEYS } from './registry/namespaces/system/features';

export { FEATURE_KEYS };

type FlagHolder = { features?: Record<string, boolean> };

/** Media Workflow Automation: `features.workflows` and not `WORKFLOWS_ENABLED=false`. */
export function isWorkflowsEnabled(settings: FlagHolder): boolean {
  return settings.features?.[FEATURE_KEYS.WORKFLOWS] === true && process.env['WORKFLOWS_ENABLED'] !== 'false';
}

/** AI Picture Enhancer: `features.pictureEnhancement` and not `PICTURE_ENHANCEMENT_ENABLED=false`. */
export function isPictureEnhancementEnabled(settings: FlagHolder): boolean {
  return (
    settings.features?.[FEATURE_KEYS.PICTURE_ENHANCEMENT] === true &&
    process.env['PICTURE_ENHANCEMENT_ENABLED'] !== 'false'
  );
}

/** Memories: `features.memories` and not `MEMORIES_ENABLED=false`. */
export function isMemoriesEnabled(settings: FlagHolder): boolean {
  return settings.features?.[FEATURE_KEYS.MEMORIES] === true && process.env['MEMORIES_ENABLED'] !== 'false';
}

/**
 * Location Grouping: `features.locationGrouping` and not `LOCATION_GROUPING_ENABLED=false`. When
 * false the resolver is the IDENTITY function: canonical columns are still written, verbatim.
 */
export function isLocationGroupingEnabled(settings: FlagHolder): boolean {
  return (
    settings.features?.[FEATURE_KEYS.LOCATION_GROUPING] === true &&
    process.env['LOCATION_GROUPING_ENABLED'] !== 'false'
  );
}

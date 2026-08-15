import { api } from './api';

// ---------------------------------------------------------------------------
// Types — GET /api/features (see apps/api/src/settings/features.controller.ts)
//
// Least-privilege carrier for client-visible feature flags: readable by ANY
// authenticated user, unlike GET /api/system-settings which requires the
// Admin-only `system_settings:read` permission.
// ---------------------------------------------------------------------------

/**
 * Client-facing picture-enhancement configuration. `enabled` already folds in
 * the PICTURE_ENHANCEMENT_ENABLED env kill-switch server-side, so the UI can
 * gate on it directly without consulting the feature record.
 */
export interface PictureEnhancementPolicy {
  /** `features.pictureEnhancement` AND the env kill-switch, resolved server-side. */
  enabled: boolean;
  /** When false, only "keep both" is offered on apply. */
  allowReplace: boolean;
  /** When true, "replace" is blocked if the enhanced image is smaller. */
  blockReplaceOnDownscale: boolean;
  /** Configured enhancement model NAME (never a credential); null when unset. */
  model: string | null;
  /**
   * Server-enforced ceiling on how many distinct items one bulk-enhance request
   * may carry (`pictureEnhancement.maxBatchSize`, default 25). The UI disables
   * submission above it so an over-cap selection is explained before it costs a
   * round trip — POST /api/media/bulk/enhance rejects it with a 400 regardless.
   */
  maxBatchSize: number;
}

export interface FeatureFlags {
  /** Raw global feature-flag record, e.g. `{ pictureEnhancement: true }`. */
  features: Record<string, boolean>;
  pictureEnhancement: PictureEnhancementPolicy;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch client-visible feature flags for the current user. */
export async function getFeatures(): Promise<FeatureFlags> {
  return api.get<FeatureFlags>('/features');
}

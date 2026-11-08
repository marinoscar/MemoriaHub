// The least-privilege, client-visible slice of the system settings returned by GET /api/features:
// feature toggles only, never a secret, a provider credential or any other settings namespace.

import { isPictureEnhancementEnabled } from './feature-gates';

export interface PublicFeatures {
  /** Raw global feature-flag record (e.g. `pictureEnhancement`, `workflows`). */
  features: Record<string, boolean>;
  pictureEnhancement: {
    /** Feature toggle AND env kill-switch resolved together. */
    enabled: boolean;
    allowReplace: boolean;
    blockReplaceOnDownscale: boolean;
    /** Configured enhancement model NAME (never a credential); null when unset. */
    model: string | null;
    /** Max items one POST /api/media/bulk/enhance may queue (issue #421). */
    maxBatchSize: number;
  };
}

/** The settings this projection reads; a structural subset of the system settings document. */
export interface PublicFeaturesSource {
  features?: Record<string, boolean>;
  ai?: { features?: { enhance?: { model?: string | null } | null } };
  pictureEnhancement?: {
    allowReplace?: boolean;
    blockReplaceOnDownscale?: boolean;
    maxBatchSize?: number;
  };
}

/**
 * Only the boolean feature record plus the handful of picture-enhancement knobs the UI needs to
 * decide whether and how to render the AI Enhance affordance. Only the enhancement MODEL NAME is
 * surfaced, never a key.
 */
export function buildPublicFeatures(settings: PublicFeaturesSource): PublicFeatures {
  return {
    // Copy so callers can never mutate the cached settings object.
    features: { ...(settings.features ?? {}) },
    pictureEnhancement: {
      // Same helper the server-side enhance gate uses, so the client gate and the API gate never disagree.
      enabled: isPictureEnhancementEnabled(settings),
      allowReplace: settings.pictureEnhancement?.allowReplace ?? true,
      blockReplaceOnDownscale: settings.pictureEnhancement?.blockReplaceOnDownscale ?? false,
      model: settings.ai?.features?.enhance?.model ?? null,
      // The client needs the bulk cap without an Admin-only settings read.
      maxBatchSize: settings.pictureEnhancement?.maxBatchSize ?? 25,
    },
  };
}

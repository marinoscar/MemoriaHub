import { Injectable } from '@nestjs/common';

import { AppSystemSettingsService } from '../platform/settings/app-system-settings.service';
import type { AiFeatureSelectionKey, MemoriaHubAiFeatureId } from './ai-features';
import { AI_FEATURE_SELECTION } from './ai-features';

/** A feature's saved (provider, model). */
export interface AiSelection {
  provider: string;
  model: string;
}

// =============================================================================
// MemoriaHubAiSettings (RETRO-E2, #601)
// =============================================================================
//
// The typed reader of `ai.features.*`, the selections an administrator saved in the `ai` namespace
// extension (`platform/ai/ai-settings.extension.ts`, edited through
// `/api/admin/memoriahub-ai/features/*`). Both `MemoriaHubAiTargetResolver` (what the platform
// asks) and the call sites (which record the model on the job and decide the "not configured"
// path) read it, so there is one answer. Reads go through the 5 s settings cache.
//
// NO KEY IS HERE: whose key pays is the platform's `AiKeyResolver`.
// =============================================================================

@Injectable()
export class MemoriaHubAiSettings {
  constructor(private readonly systemSettings: AppSystemSettingsService) {}

  /** The saved selection under `ai.features.<key>`, or null when unset or half-filled. */
  async selection(key: AiFeatureSelectionKey): Promise<AiSelection | null> {
    const settings = await this.systemSettings.getSettings();
    const features = (settings.ai?.features ?? {}) as Record<string, { provider?: string | null; model?: string | null } | null>;
    const chosen = features[key];
    if (!chosen?.provider || !chosen?.model) return null;
    return { provider: chosen.provider, model: chosen.model };
  }

  /** The selection that routes `feature` (`AI_FEATURE_SELECTION`). */
  forFeature(feature: MemoriaHubAiFeatureId): Promise<AiSelection | null> {
    return this.selection(AI_FEATURE_SELECTION[feature]);
  }
}

import { Injectable } from '@nestjs/common';

import {
  DefaultAiTargetResolver,
  type AiTarget,
  type AiTargetContext,
  type AiTargetResolver,
} from '@marinoscar/platform-api/ai';

import { isMemoriaHubAiFeature } from './ai-features';
import { MemoriaHubAiSettings } from './memoriahub-ai-settings';

// =============================================================================
// MemoriaHubAiTargetResolver (RETRO-E2, #601)
// =============================================================================
//
// THE ONE PLACE A MEMORIAHUB AI CALL DECIDES WHICH (provider, model) IT RUNS ON. The platform
// asks `AI_TARGET_RESOLVER` when a caller names a registered feature:
//
//   - a MemoriaHub feature: the provider and model the call NAMED (both: the Doctor and the
//     "test" routes probe a model that is not saved yet), else the administrator's `ai.features.*`
//     selection for that feature, else `null` ("No model selected", `AI_INVALID_REQUEST`; the call
//     sites check the selection first and keep their own "not configured" path);
//   - anything else (a platform page such as the Playground, or no feature at all): the
//     platform's own order (`DefaultAiTargetResolver`).
//
// THE KEY IS NOT CHECKED HERE: whose key pays, whether the model is enabled in the catalogue and
// whether it fits the feature's `needs` are the platform's gates, in `AiService`.
// =============================================================================

@Injectable()
export class MemoriaHubAiTargetResolver implements AiTargetResolver {
  constructor(
    private readonly settings: MemoriaHubAiSettings,
    private readonly fallback: DefaultAiTargetResolver,
  ) {}

  async resolve(ctx: AiTargetContext): Promise<AiTarget | null> {
    if (!isMemoriaHubAiFeature(ctx.feature)) return this.fallback.resolve(ctx);

    const { provider, model } = ctx.requested;
    if (provider && model) return { provider, model };

    const chosen = await this.settings.forFeature(ctx.feature);
    if (!chosen) return null;
    // A model named alone keeps the selection's provider; the model named wins.
    return { provider: chosen.provider, model: model ?? chosen.model };
  }
}

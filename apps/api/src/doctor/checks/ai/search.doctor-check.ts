import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { AiSettingsService } from '../../../ai/ai-settings.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass, skip } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkAiSearch` (key `ai.search`).
//
// LIVE PROBE (documented exception to the platform's "never call a model"
// rule, see docs/platform-adoption/local-exceptions.md): this check asks the
// provider adapter to `testModel`, a minimal request that spends a few tokens.
// It writes nothing. The report is cached for 15 s by the platform Doctor.
// Retirement: replaced by the AI slice's checks (RETRO-E1/E2).

export const AI_SEARCH_REMEDY = 'Check the provider API key and model in Admin Settings → AI.';

export function decideAiSearch(
  cfg: { provider?: string | null; model?: string | null } | null | undefined,
  result: { ok: boolean; error?: string } | null,
): DoctorCheckOutcome {
  if (!cfg?.provider || !cfg?.model) return skip('AI search not configured.');
  if (!result?.ok) {
    return fail(result?.error ?? 'AI search provider test failed.', AI_SEARCH_REMEDY, { provider: cfg.provider });
  }
  return pass(`AI search provider "${cfg.provider}" (${cfg.model}) reachable.`, { provider: cfg.provider, model: cfg.model });
}

@Injectable()
export class AiSearchDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('ai', 'search');
  readonly category = 'ai';
  readonly label = 'AI search provider';
  readonly settingsPath = '/admin/settings/ai';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly aiSettings: AiSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.readKnownValue();
    const cfg = settings.ai?.features?.search;
    if (!cfg?.provider || !cfg?.model) return decideAiSearch(cfg, null);
    try {
      const result = await this.aiSettings.testProvider({ provider: cfg.provider, model: cfg.model });
      return decideAiSearch(cfg, result);
    } catch (err) {
      return decideAiSearch(cfg, { ok: false, error: errorMessage(err) });
    }
  }
}

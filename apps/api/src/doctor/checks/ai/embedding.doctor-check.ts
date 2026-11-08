import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { AiSettingsService } from '../../../ai/ai-settings.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass, skip, warn } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkAiEmbedding` (key `ai.embedding`).
//
// LIVE PROBE (documented exception to the platform's "never call a model" rule,
// see docs/platform-adoption/local-exceptions.md): `testEmbedding` embeds one
// short string. It writes nothing.
// Retirement: replaced by the AI slice's checks (RETRO-E1/E2).

export const AI_EMBEDDING_REMEDY = 'Check the provider API key and model in Admin Settings → AI.';

export interface EmbeddingTestResult {
  ok: boolean;
  error?: string;
  warning?: string;
  dimensions?: number;
}

export function decideAiEmbedding(
  cfg: { provider?: string | null; model?: string | null } | null | undefined,
  result: EmbeddingTestResult | null,
): DoctorCheckOutcome {
  if (!cfg?.provider || !cfg?.model) {
    return skip('Embeddings not configured; semantic search falls back to filter-only.');
  }
  if (!result?.ok) {
    return fail(result?.error ?? 'Embedding provider test failed.', AI_EMBEDDING_REMEDY);
  }
  if (result.warning) {
    return warn(result.warning, 'Select a 1536-dimension embedding model (text-embedding-3-small) in Admin Settings → AI.');
  }
  return pass(`Embeddings OK (${result.dimensions}-d).`, { dimensions: result.dimensions ?? null });
}

@Injectable()
export class AiEmbeddingDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('ai', 'embedding');
  readonly category = 'ai';
  readonly label = 'Text embedding provider';
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
    const cfg = settings.ai?.features?.embedding;
    if (!cfg?.provider || !cfg?.model) return decideAiEmbedding(cfg, null);
    try {
      return decideAiEmbedding(cfg, await this.aiSettings.testEmbedding({}));
    } catch (err) {
      return decideAiEmbedding(cfg, { ok: false, error: errorMessage(err) });
    }
  }
}

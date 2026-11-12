import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  errorMessage,
  fail, pass, skip, warn,
  readSystemNamespaces,
} from '../../core/index.js';
import {
  MEMORIAHUB_AI_ADMIN,
  MEMORIAHUB_DOCTOR,
  MEMORIAHUB_SETTINGS,
  type MemoriahubAiAdminPort,
  type MemoriahubDoctorCheck,
  type MemoriahubDoctorOutcome as DoctorCheckOutcome,
  type MemoriahubDoctorPort,
  type MemoriahubSettingsPort,
} from '../../ports/index.js';

/** The outcome when the host binds no AI administration port. */
const AI_ADMIN_UNAVAILABLE = 'AI administration probes are not available in this host (no AI administration port is bound).';

// Ported from `DoctorService.checkAiEmbedding` (key `ai.embedding`).
//
// LIVE PROBE: `testEmbedding` embeds one short string. It writes nothing.

/** The remedy of a failed embedding probe. @stability experimental */
export const AI_EMBEDDING_REMEDY = 'Check the provider API key and model in Admin Settings → AI.';

/** What the embedding probe answered. @stability experimental */
export interface EmbeddingTestResult {
  ok: boolean;
  error?: string;
  warning?: string;
  dimensions?: number;
}

/** The status ladder of the embedding check. @stability experimental */
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

/**
 * The text embedding provider check.
 *
 * @stability experimental
 */
@Injectable()
export class AiEmbeddingDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'embedding');
  readonly category = 'ai';
  readonly label = 'Text embedding provider';
  readonly settingsPath = '/admin/settings/ai';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    @Inject(MEMORIAHUB_DOCTOR) private readonly doctor: MemoriahubDoctorPort,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    @Optional() @Inject(MEMORIAHUB_AI_ADMIN) private readonly aiAdmin?: MemoriahubAiAdminPort,
  ) {}

  /** Registers the check with the diagnostics port. */
  onModuleInit(): void {
    this.doctor.registerCheck(this);
  }

  /** Runs the check. */
  async run(): Promise<DoctorCheckOutcome> {
    const settings = await readSystemNamespaces(this.settings, ['ai']);
    const cfg = settings.ai?.features?.embedding;
    if (!cfg?.provider || !cfg?.model) return decideAiEmbedding(cfg, null);
    if (!this.aiAdmin) return skip(AI_ADMIN_UNAVAILABLE);
    try {
      return decideAiEmbedding(cfg, await this.aiAdmin.testEmbedding());
    } catch (err) {
      return decideAiEmbedding(cfg, { ok: false, error: errorMessage(err) });
    }
  }
}

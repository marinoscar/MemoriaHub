import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
  errorMessage,
  fail, pass, skip,
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

// Ported from `DoctorService.checkAiSearch` (key `ai.search`).
//
// LIVE PROBE: this check asks the AI administration port to `testModel`, a minimal request that spends a few
// tokens. It writes nothing. The report is cached for 15 s by the host's diagnostics.

/** The remedy of a failed AI search probe. @stability experimental */
export const AI_SEARCH_REMEDY = 'Check the provider API key and model in Admin Settings → AI.';

/** The status ladder of the AI search check. @stability experimental */
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

/**
 * The AI search provider check.
 *
 * @stability experimental
 */
@Injectable()
export class AiSearchDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'search');
  readonly category = 'ai';
  readonly label = 'AI search provider';
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
    const cfg = settings.ai?.features?.search;
    if (!cfg?.provider || !cfg?.model) return decideAiSearch(cfg, null);
    if (!this.aiAdmin) return skip(AI_ADMIN_UNAVAILABLE);
    try {
      return decideAiSearch(cfg, await this.aiAdmin.testModel({ provider: cfg.provider, model: cfg.model }));
    } catch (err) {
      return decideAiSearch(cfg, { ok: false, error: errorMessage(err) });
    }
  }
}

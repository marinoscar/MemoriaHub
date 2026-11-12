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

// Ported from `DoctorService.checkAiTagging` (key `ai.tagging`).
//
// LIVE PROBE: this check asks the AI administration port to `testModel`, a minimal request that spends a few
// tokens. It writes nothing. The report is cached for 15 s by the host's diagnostics.

/** The remedy of a failed tagging probe. @stability experimental */
export const AI_TAGGING_REMEDY = 'Check the provider API key and model in Admin Settings → AI.';

/** The status ladder of the auto-tagging provider check. @stability experimental */
export function decideAiTagging(
  cfg: { provider?: string | null; model?: string | null } | null | undefined,
  result: { ok: boolean; error?: string } | null,
): DoctorCheckOutcome {
  if (!cfg?.provider || !cfg?.model) return skip('Auto-tagging provider not configured.');
  if (!result?.ok) {
    return fail(result?.error ?? 'Auto-tagging provider test failed.', AI_TAGGING_REMEDY, { provider: cfg.provider });
  }
  return pass(`Auto-tagging provider "${cfg.provider}" (${cfg.model}) reachable.`, { provider: cfg.provider, model: cfg.model });
}

/**
 * The auto-tagging provider check.
 *
 * @stability experimental
 */
@Injectable()
export class AiTaggingDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'tagging');
  readonly category = 'ai';
  readonly label = 'Auto-tagging provider';
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
    const cfg = settings.ai?.features?.tagging;
    if (!cfg?.provider || !cfg?.model) return decideAiTagging(cfg, null);
    if (!this.aiAdmin) return skip(AI_ADMIN_UNAVAILABLE);
    try {
      return decideAiTagging(cfg, await this.aiAdmin.testModel({ provider: cfg.provider, model: cfg.model }));
    } catch (err) {
      return decideAiTagging(cfg, { ok: false, error: errorMessage(err) });
    }
  }
}

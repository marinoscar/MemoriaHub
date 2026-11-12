import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';

import {
  DOCTOR_CHECK_TIMEOUT_MS,
  doctorCheckId,
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

// Ported from `DoctorService.checkPictureEnhancer` (key `ai.pictureEnhancer`).
// READ-ONLY: a settings read and one key status (presence only, never the key).

/** The facts the picture enhancer check decides on. @stability experimental */
export interface PictureEnhancerInput {
  featureEnabled: boolean;
  envDisabled: boolean;
  provider: string | null;
  model: string | null;
  /** Is there an enabled credential for `provider ?? 'openai'`? Resolved lazily. */
  credentialConfigured: boolean;
}

/** The status ladder of the picture enhancer check. @stability experimental */
export function decidePictureEnhancer(input: PictureEnhancerInput): DoctorCheckOutcome {
  if (!input.featureEnabled) return skip('AI picture enhancer is disabled.');
  if (input.envDisabled) {
    return warn(
      'Feature enabled in settings but PICTURE_ENHANCEMENT_ENABLED=false overrides it.',
      'Remove or set PICTURE_ENHANCEMENT_ENABLED=true.',
    );
  }
  const credProvider = input.provider ?? 'openai';
  if (!input.credentialConfigured) {
    return fail(
      `No enabled ${credProvider} credential configured for enhancement.`,
      'Enable an OpenAI credential in Admin Settings → AI.',
    );
  }
  if (!input.provider || !input.model) {
    return warn(
      'Enhancement feature is on but no enhancement model is selected.',
      'Select an enhancement model in Admin Settings → AI Picture Enhancer.',
    );
  }
  return pass(`AI picture enhancer ready (${input.provider}/${input.model}).`, {
    provider: input.provider,
    model: input.model,
  });
}

/**
 * The AI picture enhancer check.
 *
 * @stability experimental
 */
@Injectable()
export class PictureEnhancerDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'picture-enhancer');
  readonly category = 'ai';
  readonly label = 'AI picture enhancer';
  readonly settingsPath = '/admin/settings/enhancer';
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
    const settings = await readSystemNamespaces(this.settings, ['features', 'ai']);
    const enhance = settings.ai?.features?.enhance;
    const input: PictureEnhancerInput = {
      featureEnabled: settings.features?.['pictureEnhancement'] === true,
      envDisabled: process.env['PICTURE_ENHANCEMENT_ENABLED'] === 'false',
      provider: enhance?.provider ?? null,
      model: enhance?.model ?? null,
      credentialConfigured: false,
    };
    if (!input.featureEnabled || input.envDisabled) return decidePictureEnhancer(input);
    if (!this.aiAdmin) return skip(AI_ADMIN_UNAVAILABLE);

    // The host's own key first (the deployment key, then any older row); never decrypts.
    const cred = await this.aiAdmin.credentialStatus(input.provider ?? 'openai');
    return decidePictureEnhancer({ ...input, credentialConfigured: cred.configured && cred.enabled });
  }
}

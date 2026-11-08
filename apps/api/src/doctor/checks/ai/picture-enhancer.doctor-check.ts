import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { SystemSettingsService } from '../../../settings/system-settings/system-settings.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, skip, warn } from '../outcome';

// Ported from `DoctorService.checkPictureEnhancer` (key `ai.pictureEnhancer`).
// READ-ONLY: a settings read and one credential `findUnique` (presence only,
// never the key).

export interface PictureEnhancerInput {
  featureEnabled: boolean;
  envDisabled: boolean;
  provider: string | null;
  model: string | null;
  /** Is there an enabled credential for `provider ?? 'openai'`? Resolved lazily. */
  credentialConfigured: boolean;
}

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

@Injectable()
export class PictureEnhancerDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('ai', 'picture-enhancer');
  readonly category = 'ai';
  readonly label = 'AI picture enhancer';
  readonly settingsPath = '/admin/settings/enhancer';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.getSettings({ readOnly: true });
    const enhance = settings.ai?.features?.enhance;
    const input: PictureEnhancerInput = {
      featureEnabled: settings.features?.['pictureEnhancement'] === true,
      envDisabled: process.env['PICTURE_ENHANCEMENT_ENABLED'] === 'false',
      provider: enhance?.provider ?? null,
      model: enhance?.model ?? null,
      credentialConfigured: false,
    };
    if (!input.featureEnabled || input.envDisabled) return decidePictureEnhancer(input);

    const cred = await this.prisma.aiProviderCredential.findUnique({
      where: { provider: input.provider ?? 'openai' },
    });
    return decidePictureEnhancer({ ...input, credentialConfigured: !!cred && cred.enabled });
  }
}

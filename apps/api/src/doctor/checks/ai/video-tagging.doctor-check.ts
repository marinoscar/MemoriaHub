import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { AiSettingsService } from '../../../ai-port/ai-settings.service';
import { AiProviderRegistry } from '../../../ai-port/legacy-ai-provider.registry';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, skip, warn } from '../outcome';
import { AppSystemSettingsService } from '../../../platform/settings/app-system-settings.service';

// Ported from `DoctorService.checkVideoTagging` (key `ai.videoTagging`, epic
// #452, issue #457). READ-ONLY: a settings read, credential presence and a
// provider-registry capability lookup.
//
// The ladder encodes the two independent cost levers. The VISUAL pass is
// required (no tagging model or credential => FAIL: the job cannot run at all);
// TRANSCRIPTION is an optional enrichment (any gap => WARN: the job still runs
// visual-only). Reporting both as failures would send an admin chasing a
// transcription credential to fix a feature that already works.

export interface VideoTaggingInput {
  autoTaggingEnabled: boolean;
  videoEnabled: boolean;
  envDisabled: boolean;
  tagging: { provider?: string | null; model?: string | null } | null | undefined;
  taggingCredentialEnabled: boolean;
  maxFrames: number;
  transcriptionOn: boolean;
  leadSeconds: number;
  transcription: { provider?: string | null; model?: string | null } | null | undefined;
  transcriptionCredentialEnabled: boolean;
  /** `true` when the provider has no `transcribeAudio` (e.g. Anthropic). `false` when unknown. */
  transcriptionProviderLacksAudio: boolean;
}

export function decideVideoTagging(input: VideoTaggingInput): DoctorCheckOutcome {
  if (!input.autoTaggingEnabled) return skip('Auto-tagging is disabled.');
  if (!input.videoEnabled) return skip('Video AI tagging is disabled.');
  // Video tagging rides on AUTO_TAG_ENABLED; it has no kill-switch of its own.
  if (input.envDisabled) {
    return warn(
      'Video AI tagging is enabled in settings but AUTO_TAG_ENABLED=false overrides it.',
      'Remove or set AUTO_TAG_ENABLED=true.',
    );
  }

  const tagging = input.tagging;
  if (!tagging?.provider || !tagging?.model) {
    return fail(
      'Video AI tagging is enabled but no tagging provider/model is selected.',
      'Select a tagging provider and model in Admin Settings → AI.',
    );
  }
  if (!input.taggingCredentialEnabled) {
    return fail(
      `No enabled ${tagging.provider} credential configured for tagging.`,
      `Enable a ${tagging.provider} credential in Admin Settings → AI.`,
    );
  }

  if (input.transcriptionOn) {
    const t = input.transcription;
    if (!t?.provider || !t?.model) {
      return warn(
        'Transcription is enabled but no transcription provider/model is selected — videos will be tagged visual-only.',
        'Select a transcription model in Admin Settings → AI, or turn transcription off.',
      );
    }
    if (!input.transcriptionCredentialEnabled) {
      return warn(
        `No enabled ${t.provider} credential for transcription — videos will be tagged visual-only.`,
        `Enable a ${t.provider} credential in Admin Settings → AI.`,
      );
    }
    if (input.transcriptionProviderLacksAudio) {
      return warn(
        `Provider "${t.provider}" has no audio capability — videos will be tagged visual-only.`,
        'Select an OpenAI transcription model in Admin Settings → AI.',
      );
    }
    return pass(
      `Video AI tagging ready (${tagging.provider}/${tagging.model}, ${input.maxFrames} frames/video) ` +
        `with transcription (${t.provider}/${t.model}, first ${input.leadSeconds}s).`,
      { maxFrames: input.maxFrames, transcription: true },
    );
  }

  return pass(
    `Video AI tagging ready (${tagging.provider}/${tagging.model}, ${input.maxFrames} frames/video, visual-only).`,
    { maxFrames: input.maxFrames, transcription: false },
  );
}

@Injectable()
export class VideoTaggingDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('ai', 'video-tagging');
  readonly category = 'ai';
  readonly label = 'Video AI tagging';
  readonly settingsPath = '/admin/settings/tagging';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly aiSettings: AiSettingsService,
    private readonly systemSettings: AppSystemSettingsService,
    private readonly aiProviderRegistry: AiProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const settings = await this.systemSettings.readKnownValue();
    const video = settings.autoTagging?.video;
    const tagging = settings.ai?.features?.tagging;
    const transcription = (
      settings.ai?.features as { transcription?: { provider?: string; model?: string } | null } | undefined
    )?.transcription;

    const input: VideoTaggingInput = {
      autoTaggingEnabled: settings.features?.['autoTagging'] === true,
      videoEnabled: video?.enabled === true,
      envDisabled: process.env['AUTO_TAG_ENABLED'] === 'false',
      tagging,
      taggingCredentialEnabled: false,
      maxFrames: video?.maxFrames ?? 6,
      transcriptionOn: video?.transcription?.enabled === true,
      leadSeconds: video?.transcription?.leadSeconds ?? 30,
      transcription,
      transcriptionCredentialEnabled: false,
      transcriptionProviderLacksAudio: false,
    };

    // Resolve the credential facts only for the rungs that need them.
    if (!input.autoTaggingEnabled || !input.videoEnabled || input.envDisabled) return decideVideoTagging(input);
    if (!tagging?.provider || !tagging?.model) return decideVideoTagging(input);

    // Platform deployment key first, then the legacy row (RETRO-E3, #605); never decrypts.
    const taggingCred = await this.aiSettings.credentialStatus(tagging.provider);
    input.taggingCredentialEnabled = taggingCred.configured && taggingCred.enabled;

    if (input.taggingCredentialEnabled && input.transcriptionOn && transcription?.provider && transcription?.model) {
      const cred = await this.aiSettings.credentialStatus(transcription.provider);
      input.transcriptionCredentialEnabled = cred.configured && cred.enabled;
      const instance = this.safeGetAiProvider(transcription.provider);
      input.transcriptionProviderLacksAudio = !!instance && typeof instance.transcribeAudio !== 'function';
    }
    return decideVideoTagging(input);
  }

  /** The registry throws for an unknown key; a check reports a misconfiguration rather than becoming one. */
  private safeGetAiProvider(providerKey: string): { transcribeAudio?: unknown } | null {
    try {
      return this.aiProviderRegistry.get(providerKey) as { transcribeAudio?: unknown };
    } catch {
      return null;
    }
  }
}

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

// Ported from `DoctorService.checkVideoTagging` (key `ai.videoTagging`, epic #452, issue #457). READ-ONLY: a
// settings read, key presence and a provider capability lookup.
//
// The ladder encodes the two independent cost levers. The VISUAL pass is required (no tagging model or
// credential => FAIL: the job cannot run at all); TRANSCRIPTION is an optional enrichment (any gap => WARN:
// the job still runs visual-only). Reporting both as failures would send an admin chasing a transcription
// credential to fix a feature that already works.

/** The facts the video tagging check decides on. @stability experimental */
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
  /** `true` when the provider has no audio capability (e.g. Anthropic). `false` when unknown. */
  transcriptionProviderLacksAudio: boolean;
}

/** The status ladder of the video tagging check. @stability experimental */
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

/**
 * The video AI tagging check.
 *
 * @stability experimental
 */
@Injectable()
export class VideoTaggingDoctorCheck implements MemoriahubDoctorCheck, OnModuleInit {
  readonly id = doctorCheckId('ai', 'video-tagging');
  readonly category = 'ai';
  readonly label = 'Video AI tagging';
  readonly settingsPath = '/admin/settings/tagging';
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
    const settings = await readSystemNamespaces(this.settings, ['features', 'ai', 'autoTagging']);
    const video = settings.autoTagging?.video;
    const tagging = settings.ai?.features?.tagging;
    const transcription = settings.ai?.features?.transcription as { provider?: string; model?: string } | null | undefined;

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
    if (!this.aiAdmin) return skip(AI_ADMIN_UNAVAILABLE);

    // The host's own key first (the deployment key, then any older row); never decrypts.
    const taggingCred = await this.aiAdmin.credentialStatus(tagging.provider);
    input.taggingCredentialEnabled = taggingCred.configured && taggingCred.enabled;

    if (input.taggingCredentialEnabled && input.transcriptionOn && transcription?.provider && transcription?.model) {
      const cred = await this.aiAdmin.credentialStatus(transcription.provider);
      input.transcriptionCredentialEnabled = cred.configured && cred.enabled;
      // A provider the host does not know is not a missing capability: a check reports a misconfiguration,
      // it never becomes one.
      const capabilities = this.aiAdmin.providerCapabilities(transcription.provider);
      input.transcriptionProviderLacksAudio = capabilities !== null && !capabilities.transcribeAudio;
    }
    return decideVideoTagging(input);
  }
}

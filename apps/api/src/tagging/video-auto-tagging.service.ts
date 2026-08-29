// =============================================================================
// VideoAutoTaggingService
// =============================================================================
//
// AI tags, a written description, and a semantic embedding for VIDEOS, at
// parity with what photos already get (epic #452, issue #455).
//
// COMPUTE/PERSIST SPLIT, mirroring AutoTaggingService and
// VideoFaceDetectionService:
//
//   - processMediaItem: the in-process orchestration — gates, provider/creds
//     resolution, video download, and everything else that needs server-held
//     DB or storage credentials.
//
//   - computeVideoAutoTagging: the half a distributed worker node runs
//     locally with a transiently-fetched API key (issue #460) — extract
//     frames, prepare each one, optionally transcribe the audio lead, and make
//     ONE multi-image vision call. Returns raw, unparsed text.
//
//   - PERSIST is deliberately NOT reimplemented here. It delegates to
//     AutoTaggingService.persistAutoTagging, which already reloads the
//     MediaItem, the enabled TagLabel vocabulary, and the assigned people
//     names itself (it had to, for the node-result path). Vocabulary
//     validation therefore has exactly ONE implementation: a second copy that
//     drifted would let video tagging emit tags outside the admin's
//     vocabulary — precisely the failure that validation exists to prevent.
//
// THE RESOURCE CEILING is the load-bearing design constraint. Three costs,
// each independently bounded, NONE scaling with video duration:
//
//   - Frames: `autoTagging.video.maxFrames`. computeSeekTimestamps uses
//     interval = max(sampleIntervalSeconds, durationSec / maxFrames), so six
//     frames come out of a 30-second clip AND a 3-hour recital. Spreading the
//     same six frames across the full runtime costs identically to taking them
//     from the opening seconds, and describes the video far better.
//   - Transcription: `transcription.leadSeconds` of audio, via ffmpeg `-t`.
//   - One vision call per video, never one per frame.
//
// Consequently there is deliberately NO duration skip gate. The longest videos
// in a family library — a whole recital, a wedding — are often the most
// significant, and are exactly the ones a `maxDurationSeconds` cap would
// silently leave undescribed. Since cost is already duration-independent,
// skipping them buys nothing. Degrade, never skip on duration.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { EnrichmentJob, MediaTagStatusType, MediaType } from '@prisma/client';
import { extname } from 'path';
import type { VideoAutoTaggingResult } from '@memoriahub/enrichment-compute/dto';
import {
  extractAudioLead,
  extractFrames,
} from '@memoriahub/enrichment-compute/video';
// Prompt construction lives in the shared parity package so the server and a
// distributed worker node send BYTE-IDENTICAL vision requests (issue #460).
import {
  VIDEO_AUTO_TAGGING_SYSTEM_PROMPT,
  VIDEO_TAGGING_MAX_TOKENS,
  buildVideoTaggingPrompt,
} from '@memoriahub/enrichment-compute/ai';
import { PrismaService } from '../prisma/prisma.service';
import { VideoInputResolver } from '../media/enrichment/video-input.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiProviderRegistry } from '../ai/providers/ai-provider.registry';
import type {
  AiProvider,
  AiProviderCredentials,
  AnalyzeImageInputImage,
} from '../ai/providers/ai-provider.interface';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { RateLimitError, parseRetryAfterMs, classifyRateLimit } from '../enrichment/rate-limit.error';
import { AutoTaggingService } from './auto-tagging.service';

/** Long-edge cap per frame — same env var and default as the photo path. */
const TAG_MAX_DIM = (): number => parseInt(process.env['TAG_MAX_IMAGE_DIM'] ?? '1568', 10);

/**
 * Hard cap on the base64 payload across ALL frames in the single call.
 * Anthropic enforces ~5 MB per image and a request-wide budget; frames are
 * dropped from the END (keeping the earliest, which anchor the narrative)
 * rather than failing the job.
 */
const MAX_TOTAL_IMAGE_BYTES = 18_000_000;

/**
 * Optional hard cap (bytes) on videos processed by video enrichment; 0
 * disables. Shared with video face detection and social-media detection so an
 * operator sets one knob for all video work.
 */
const VIDEO_ENRICHMENT_MAX_BYTES = (): number =>
  parseInt(process.env['VIDEO_ENRICHMENT_MAX_BYTES'] ?? '0', 10);

/** Effective `autoTagging.video.*` values, after defaults. */
export interface VideoTaggingParams {
  maxFrames: number;
  sampleIntervalSeconds: number;
  transcriptionEnabled: boolean;
  leadSeconds: number;
  /**
   * Whether ffmpeg may read the video straight from a presigned URL via HTTP
   * range seeks instead of downloading it whole (issue #456). Off falls back
   * to the proven download path, which is also what every streaming failure
   * does — so this is a revert switch, not a correctness gate.
   */
  streamInput: boolean;
}

@Injectable()
export class VideoAutoTaggingService {
  private readonly logger = new Logger(VideoAutoTaggingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettingsService: AiSettingsService,
    private readonly aiProviderRegistry: AiProviderRegistry,
    private readonly videoInput: VideoInputResolver,
    private readonly enrichmentJobService: EnrichmentJobService,
    private readonly autoTaggingService: AutoTaggingService,
  ) {}

  // ---------------------------------------------------------------------------
  // processMediaItem — in-process orchestration
  // ---------------------------------------------------------------------------

  async processMediaItem(job: EnrichmentJob): Promise<void> {
    if (!job.mediaItemId) {
      throw new Error('video_auto_tagging job missing mediaItemId');
    }

    // --- Gates, cheapest first (mirrors SocialMediaDetectionHandler). Each
    // gate that fires must leave NO status row change beyond what it states,
    // and must never make an AI call. ---
    const settingsRow = await this.prisma.systemSettings.findUnique({ where: { key: 'global' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settingsValue = (settingsRow?.value as any) ?? {};

    if (settingsValue?.features?.autoTagging !== true) {
      this.logger.log(
        `VideoAutoTagJob ${job.id}: features.autoTagging is off; skipping without an AI call`,
      );
      return;
    }
    // Video tagging has no kill-switch of its own — it rides on
    // AUTO_TAG_ENABLED, exactly as video face detection rides on
    // FACE_AUTO_DETECT.
    if (process.env['AUTO_TAG_ENABLED'] === 'false') {
      this.logger.log(`VideoAutoTagJob ${job.id}: AUTO_TAG_ENABLED=false; skipping`);
      return;
    }
    const videoSettings = settingsValue?.autoTagging?.video ?? {};
    if (videoSettings?.enabled !== true) {
      this.logger.log(
        `VideoAutoTagJob ${job.id}: autoTagging.video.enabled is off; skipping without an AI call`,
      );
      return;
    }

    const params: VideoTaggingParams = {
      maxFrames: videoSettings?.maxFrames ?? 6,
      sampleIntervalSeconds: videoSettings?.sampleIntervalSeconds ?? 5,
      transcriptionEnabled: videoSettings?.transcription?.enabled === true,
      leadSeconds: videoSettings?.transcription?.leadSeconds ?? 30,
      streamInput: videoSettings?.streamInput !== false,
    };

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        deletedAt: true,
        durationMs: true,
        socialMediaSource: true,
        storageObject: {
          select: { storageKey: true, storageProvider: true, bucket: true, name: true, size: true },
        },
      },
    });

    if (
      !mediaItem ||
      mediaItem.deletedAt ||
      mediaItem.type !== MediaType.video ||
      !mediaItem.storageObject
    ) {
      const reason = !mediaItem
        ? `MediaItem ${job.mediaItemId} not found`
        : mediaItem.deletedAt
          ? `MediaItem ${job.mediaItemId} is soft-deleted`
          : !mediaItem.storageObject
            ? `MediaItem ${job.mediaItemId} has no storageObject`
            : `MediaItem ${job.mediaItemId} is type ${mediaItem.type}, not video`;
      this.logger.warn(`VideoAutoTagJob ${job.id}: ${reason}; skipping`);
      const circleId = mediaItem?.circleId ?? (job.circleId as string);
      await this.markFailed(job.mediaItemId, circleId, null, 'unknown', reason);
      return;
    }

    // Never burn an AI call on a TikTok/Instagram re-share. This is a skip,
    // not a failure — the item is correctly classified, there is just nothing
    // worth describing.
    if (mediaItem.socialMediaSource) {
      this.logger.log(
        `VideoAutoTagJob ${job.id}: skipping — flagged social media (${mediaItem.socialMediaSource})`,
      );
      return;
    }

    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId: job.mediaItemId },
      create: {
        mediaItemId: job.mediaItemId,
        circleId: mediaItem.circleId,
        status: MediaTagStatusType.processing,
        tagCount: 0,
      },
      update: { status: MediaTagStatusType.processing, lastError: null },
    });

    // --- Provider/model + credentials ---
    const taggingConfig = settingsValue?.ai?.features?.tagging as
      | { provider?: string; model?: string }
      | undefined;
    const provider = taggingConfig?.provider;
    const model = taggingConfig?.model;

    if (!provider || !model) {
      const errMsg = 'AI tagging provider or model not configured in system settings';
      this.logger.error(`VideoAutoTagJob ${job.id}: ${errMsg}`);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, null, 'unknown', errMsg);
      return;
    }

    await this.enrichmentJobService.recordModel(job.id, provider, model);
    // recordModel writes the DB row only; keep the in-memory job object in
    // sync since persistAutoTagging reads providerKey/modelVersion off this
    // same reference without a re-fetch (identical to the photo path).
    job.providerKey = provider;
    job.modelVersion = model;

    let creds: AiProviderCredentials;
    try {
      creds = await this.aiSettingsService.resolveCredentials(provider);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`VideoAutoTagJob ${job.id}: failed to resolve credentials: ${errMsg}`);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
      return;
    }

    const aiProvider = this.aiProviderRegistry.get(provider);

    const tagLabels = await this.prisma.tagLabel.findMany({
      where: { enabled: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    if (tagLabels.length === 0) {
      this.logger.warn(`VideoAutoTagJob ${job.id}: no enabled TagLabels found; skipping tagging`);
      await this.prisma.mediaTagStatus.upsert({
        where: { mediaItemId: job.mediaItemId },
        create: {
          mediaItemId: job.mediaItemId,
          circleId: mediaItem.circleId,
          status: MediaTagStatusType.processed,
          tagCount: 0,
          providerKey: provider,
          modelVersion: model,
          processedAt: new Date(),
        },
        update: {
          status: MediaTagStatusType.processed,
          tagCount: 0,
          providerKey: provider,
          modelVersion: model,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return;
    }

    // Optional hard size cap — checked BEFORE the download, so an over-cap
    // video costs nothing.
    const maxBytes = VIDEO_ENRICHMENT_MAX_BYTES();
    if (maxBytes > 0 && mediaItem.storageObject.size > BigInt(maxBytes)) {
      const reason =
        `object size ${mediaItem.storageObject.size} bytes exceeds VIDEO_ENRICHMENT_MAX_BYTES=${maxBytes}`;
      this.logger.warn(`VideoAutoTagJob ${job.id}: skipping — ${reason}`);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, reason);
      return;
    }

    try {
      const peopleNames = await this.loadPeopleNames(job.mediaItemId);
      const labelNames = tagLabels.map((t) => t.name);

      const fileExt = extname(mediaItem.storageObject.name || '') || '.mp4';

      // Streams from a presigned URL when the provider honors Range and the
      // container's index is at the front; otherwise downloads. Either way the
      // returned handle is just something ffmpeg can read (issue #456).
      const input = await this.videoInput.resolve({
        storageKey: mediaItem.storageObject.storageKey,
        storageProvider: mediaItem.storageObject.storageProvider,
        bucket: mediaItem.storageObject.bucket,
        sizeBytes: mediaItem.storageObject.size,
        extension: fileExt,
        tempPrefix: 'memoriaHub-vtag-dl-',
        streamingEnabled: params.streamInput,
        jobId: job.id,
      });

      let computed: VideoAutoTaggingResult;
      try {
        computed = await this.computeVideoAutoTagging(input.source, {
          durationMs: mediaItem.durationMs,
          fileExtension: fileExt,
          params,
          labelNames,
          peopleNames,
          model,
          creds,
          aiProvider,
          providerKey: provider,
          jobId: job.id,
        });
      } finally {
        await input.cleanup();
      }

      // The transcript is persisted BEFORE the shared persist runs, so
      // embedAndStore's transcript lookup (issue #454) picks it up on this
      // very pass rather than only on the next re-run.
      await this.persistTranscript(mediaItem.id, mediaItem.circleId, computed);

      this.logger.log(
        `VideoAutoTagJob ${job.id}: analyzed ${computed.frameCount} frame(s) at ` +
          `[${computed.sampledTimestampsMs.join(', ')}]ms` +
          `${computed.transcript ? ' with a transcript' : ' (visual-only)'}`,
      );

      // PERSIST half — the SAME implementation the photo path uses, so
      // vocabulary validation cannot drift between the two.
      await this.autoTaggingService.persistAutoTagging(job, { rawText: computed.rawText });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.markFailed(job.mediaItemId, mediaItem.circleId, provider, model, errMsg);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // computeVideoAutoTagging — COMPUTE half
  //
  // Everything here is pure compute against a local video file plus a
  // provider API key: exactly what a distributed worker node runs locally
  // (issue #460). No DB access, no storage credentials.
  // ---------------------------------------------------------------------------

  async computeVideoAutoTagging(
    videoPath: string,
    ctx: {
      durationMs: number | null;
      fileExtension?: string;
      params: VideoTaggingParams;
      labelNames: string[];
      peopleNames: string[];
      model: string;
      creds: AiProviderCredentials;
      aiProvider: AiProvider;
      providerKey: string;
      jobId: string;
    },
  ): Promise<VideoAutoTaggingResult> {
    // --- 1. Frames. Bounded by maxFrames and spread across the WHOLE
    // duration; see the resource-ceiling note in this file's header. ---
    const frames = await extractFrames(videoPath, {
      durationMs: ctx.durationMs,
      sampleIntervalSeconds: ctx.params.sampleIntervalSeconds,
      maxFrames: ctx.params.maxFrames,
      ...(ctx.fileExtension ? { fileExtension: ctx.fileExtension } : {}),
    });

    if (frames.length === 0) {
      throw new Error('No frames could be extracted from the video');
    }

    // --- 2. Prepare each frame, exactly as the photo path prepares its one
    // image (EXIF/orientation parity, same TAG_MAX_IMAGE_DIM budget). ---
    const maxDim = TAG_MAX_DIM();
    const images: AnalyzeImageInputImage[] = [];
    const sampledTimestampsMs: number[] = [];
    let totalBytes = 0;

    for (const frame of frames) {
      const prepared = await prepareImageForProcessing(frame.buffer, { maxDim });
      // A frame sharp could not decode is skipped rather than failing the
      // whole video — the remaining frames still describe it.
      const buffer = prepared.width > 0 ? prepared.buffer : null;
      if (!buffer) {
        this.logger.warn(
          `VideoAutoTagJob ${ctx.jobId}: frame at ${frame.timestampMs}ms failed preprocessing; skipping it`,
        );
        continue;
      }

      const base64 = buffer.toString('base64');
      if (totalBytes + base64.length > MAX_TOTAL_IMAGE_BYTES) {
        this.logger.warn(
          `VideoAutoTagJob ${ctx.jobId}: image budget reached after ${images.length} frame(s); ` +
            'dropping the remaining frames',
        );
        break;
      }
      totalBytes += base64.length;
      images.push({ base64, mimeType: 'image/jpeg' });
      sampledTimestampsMs.push(frame.timestampMs);
    }

    if (images.length === 0) {
      throw new Error('No video frames could be prepared for analysis');
    }

    // --- 3. Transcription — strictly BEST-EFFORT. ---
    const transcript = await this.transcribeLead(videoPath, ctx.params, ctx.jobId);

    // --- 4. ONE multi-image vision call. ---
    const { system, prompt } = this.buildVideoPrompt(
      ctx.labelNames,
      ctx.peopleNames,
      sampledTimestampsMs,
      transcript?.text ?? null,
    );

    let rawText: string;
    try {
      rawText = await ctx.aiProvider.analyzeImage(ctx.creds, {
        model: ctx.model,
        system,
        prompt,
        images,
        maxTokens: VIDEO_TAGGING_MAX_TOKENS,
      });
    } catch (providerErr) {
      throw this.asRateLimitIfThrottled(providerErr, ctx.providerKey);
    }

    return {
      rawText,
      frameCount: images.length,
      sampledTimestampsMs,
      transcript: transcript
        ? {
            text: transcript.text,
            ...(transcript.language ? { language: transcript.language } : {}),
            leadSeconds: ctx.params.leadSeconds,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // buildVideoPrompt — shared prompt construction.
  //
  // Used by BOTH the in-process compute path above and the node
  // transient-credentials endpoint (NodesService.getJobCredentials, issue
  // #460), so a worker node receives the EXACT prompt the server would have
  // sent. Mirrors AutoTaggingService.buildPrompt's role for photos.
  // ---------------------------------------------------------------------------

  buildVideoPrompt(
    labelNames: string[],
    peopleNames: string[],
    sampledTimestampsMs: number[],
    transcript: string | null,
  ): { system: string; prompt: string } {
    return {
      system: VIDEO_AUTO_TAGGING_SYSTEM_PROMPT,
      prompt: buildVideoTaggingPrompt(labelNames, peopleNames, sampledTimestampsMs, transcript),
    };
  }

  /**
   * Persist a NODE-computed result's transcript before the shared persist runs
   * (issue #460). Called only from VideoAutoTaggingHandler.persistNodeResult;
   * the in-process path persists its transcript inline in processMediaItem.
   *
   * Resolves the item's circleId itself, since a node-result call has no
   * preloaded context — the same self-contained posture persistAutoTagging
   * already takes.
   */
  async persistNodeTranscript(job: EnrichmentJob, result: VideoAutoTaggingResult): Promise<void> {
    if (!result.transcript || !job.mediaItemId) return;

    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: job.mediaItemId },
      select: { id: true, circleId: true },
    });
    if (!mediaItem) return;

    await this.persistTranscript(mediaItem.id, mediaItem.circleId, result);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Transcribe the opening seconds of the video's audio.
   *
   * BEST-EFFORT by contract: a video with no audio track, a provider with no
   * `transcribeAudio` capability, an unconfigured model, or an ffmpeg failure
   * all resolve to `null` and the video is tagged visual-only. The ONE
   * exception is a rate-limit error, which is rethrown so the queue's
   * deferral path handles it — matching how `embedAndStore` already treats
   * RateLimitError, and avoiding a silent quality drop on a throttled account.
   */
  private async transcribeLead(
    videoPath: string,
    params: VideoTaggingParams,
    jobId: string,
  ): Promise<{ text: string; language?: string } | null> {
    if (!params.transcriptionEnabled) return null;

    try {
      const config = await this.aiSettingsService.resolveTranscriptionConfig();
      if (!config) {
        this.logger.warn(
          `VideoAutoTagJob ${jobId}: transcription is enabled but ai.features.transcription is unset; tagging visual-only`,
        );
        return null;
      }

      const provider = this.aiProviderRegistry.get(config.provider);
      if (typeof provider.transcribeAudio !== 'function') {
        this.logger.warn(
          `VideoAutoTagJob ${jobId}: provider ${config.provider} has no audio capability; tagging visual-only`,
        );
        return null;
      }

      const creds = await this.aiSettingsService.resolveCredentials(config.provider);
      const audio = await extractAudioLead(videoPath, { leadSeconds: params.leadSeconds });
      const result = await provider.transcribeAudio(creds, {
        model: config.model,
        audio: audio.buffer,
        mimeType: audio.mimeType,
      });

      const text = result.text?.trim() ?? '';
      if (!text) return null;
      return { text, ...(result.language ? { language: result.language } : {}) };
    } catch (err) {
      // A throttled transcription provider is the queue's problem, not a
      // reason to silently produce a worse description.
      const rateLimited = err instanceof RateLimitError ? err : classifyRateLimit(err);
      if (rateLimited) throw rateLimited;

      this.logger.warn(
        `VideoAutoTagJob ${jobId}: transcription failed — ${err instanceof Error ? err.message : String(err)}; tagging visual-only`,
      );
      return null;
    }
  }

  /**
   * Upsert the transcript row (issue #454). Best-effort: a failure here costs
   * the stored transcript and its contribution to the embedding, never the
   * tags and description that were already paid for.
   */
  private async persistTranscript(
    mediaItemId: string,
    circleId: string,
    computed: VideoAutoTaggingResult,
  ): Promise<void> {
    if (!computed.transcript) return;

    const config = await this.aiSettingsService.resolveTranscriptionConfig().catch(() => null);
    const data = {
      text: computed.transcript.text,
      language: computed.transcript.language ?? null,
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      leadSeconds: computed.transcript.leadSeconds,
    };

    try {
      await this.prisma.mediaTranscript.upsert({
        where: { mediaItemId },
        create: { mediaItemId, circleId, ...data },
        update: data,
      });
    } catch (err) {
      this.logger.warn(
        `VideoAutoTagging: failed to persist transcript for MediaItem ${mediaItemId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Distinct names of people assigned to faces on this item. */
  private async loadPeopleNames(mediaItemId: string): Promise<string[]> {
    const faces = await this.prisma.face.findMany({
      where: {
        mediaItemId,
        personId: { not: null },
        person: { deletedAt: null, mergedIntoId: null },
      },
      select: { person: { select: { name: true } } },
    });
    return [...new Set(faces.map((f) => f.person?.name).filter((n): n is string => !!n))];
  }

  /**
   * Convert a provider 429/529 into the queue's RateLimitError so the job is
   * DEFERRED rather than counted as a normal failed attempt. Byte-for-byte
   * the same classification the photo path applies.
   */
  private asRateLimitIfThrottled(providerErr: unknown, providerKey: string): unknown {
    const e = providerErr as Record<string, unknown> | null;
    const httpStatus = typeof e?.['status'] === 'number' ? e['status'] : undefined;
    // 529 = Anthropic "Overloaded" — transient, treated the same as 429.
    if (httpStatus !== 429 && httpStatus !== 529) return providerErr;

    const headers = e?.['headers'] as Record<string, unknown> | undefined;
    const responseHeaders = (e?.['response'] as Record<string, unknown> | undefined)?.['headers'] as
      | Record<string, unknown>
      | undefined;
    const retryHeader =
      typeof headers?.['retry-after'] === 'string'
        ? (headers['retry-after'] as string)
        : typeof responseHeaders?.['retry-after'] === 'string'
          ? (responseHeaders['retry-after'] as string)
          : undefined;

    return new RateLimitError(
      typeof e?.['message'] === 'string' ? e['message'] : 'AI provider rate limit exceeded (429)',
      parseRetryAfterMs(retryHeader) ?? undefined,
      providerKey,
    );
  }

  private async markFailed(
    mediaItemId: string,
    circleId: string,
    providerKey: string | null,
    modelVersion: string,
    error: string,
  ): Promise<void> {
    await this.prisma.mediaTagStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        circleId,
        status: MediaTagStatusType.failed,
        tagCount: 0,
        lastError: error,
        ...(providerKey ? { providerKey, modelVersion } : {}),
      },
      update: {
        status: MediaTagStatusType.failed,
        lastError: error,
        ...(providerKey ? { providerKey, modelVersion } : {}),
      },
    });
  }
}

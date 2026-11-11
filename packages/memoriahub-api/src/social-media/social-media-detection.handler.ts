// =============================================================================
// SocialMediaDetectionHandler  (type = 'social_media_detection')
// =============================================================================
//
// Enrichment handler that classifies whether a VIDEO media item was downloaded/
// re-shared from a social-media platform (TikTok/Instagram/Facebook/other).
//
// Pipeline:
//   1. Load the MediaItem (+ storageObject metadata). Skip non-video/deleted/missing.
//   2. Feature gate: features.socialMediaDetection + SOCIAL_MEDIA_DETECTION_ENABLED.
//   3. Mark MediaSocialStatus → processing.
//   4. Build VideoDetectionInput from persisted ffprobe metadata; re-probe legacy
//      items (no formatTags) by downloading + ffprobe. Pre-flight caps run
//      first (duration/size → treat as clean, matchedRule 'skip-*-cap', no
//      download), then the orientation gate (landscape → no download, no OCR).
//   5. Tier-1 (metadata/filename) detection.
//   6. Tier-2 OCR fallback when Tier-1 is inconclusive but suspicious.
//   7a. Detected → apply tags ("Social Media" + platform), write status + source.
//   7b. Clean → status(isSocialMedia:false); if it was previously flagged, strip
//       the system tags + clear source; then fan out downstream video enrichment
//       (video_face_detection) that was withheld while classification was pending.
//   8. On error: mark failed + rethrow so the worker retries.
//
// A `MemoriahubJobHandler` registered through the jobs port (RETRO-J10, #624). The subject is the media item
// (`job.subjectType === 'media_item'`); a media item that no longer exists
// settles the job as a no-op on both paths.
//
// NODE-ELIGIBLE (derived from the pair `nodeResultSchema` + `persistNodeResult`):
// a node runs Tier 1 (its own ffprobe + filename) and Tier 2 OCR against the
// presigned original and submits the verdict; `persistNodeResult` writes
// `media_social_status`, the tags and the source column, and on a CLEAN verdict
// fans out the withheld video enrichment. A DETECTED verdict stops the chain.
//
// THE FAN-OUT. The host's `SOCIAL_MEDIA_POST_DETECTION` hook (its media
// enrichment service) enqueues `video_face_detection` (and `video_auto_tagging`
// when enabled) through the jobs port, with the job's organization. It runs
// AFTER the clean-status transaction commits,
// never inside it, and the queue's dedup (one pending/running job per type and
// subject) makes a retried or re-delivered CLEAN fan out once.
//
// THE PRE-FLIGHT (size cap, duration cap, landscape gate) lives in `process`,
// the server half: an over-cap video is decided CLEAN there without a byte
// downloaded. A node that claims the job does not run it (it computes only the
// verdict); keeping an over-cap video away from a node claim needs the item
// marked skipped at enqueue time, which belongs with the node executor
// (RETRO-C10). Until then the node plane is paused (RETRO-C2) and every job
// runs here.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { promises as fs } from 'fs';
import { extname } from 'path';
import { socialMediaDetectionResultSchema, type SocialMediaDetectionResult } from '@marinoscar/memoriahub-compute/dto';
import { probeVideoFile, extractContainerMetadata } from '@marinoscar/memoriahub-compute/metadata';

import { downloadToTempFile } from '../core/index.js';
import { resolveMediaItemJob } from '../media/index.js';
import {
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_PRISMA,
  MEMORIAHUB_SETTINGS,
  type MemoriahubJob,
  type MemoriahubJobHandler,
  type MemoriahubJobProfile,
  type MemoriahubJobsPort,
  type MemoriahubMetricsPort,
  type MemoriahubObjectStorePort,
  type MemoriahubSettingsPort,
} from '../ports/index.js';
import {
  SOCIAL_JOB_REASON,
  SOCIAL_MEDIA_JOB_TYPE,
  SOCIAL_MEDIA_TYPE,
  SOCIAL_STATUS,
  SOCIAL_TAG_SOURCE,
  type SocialJobReason,
  type SocialStatus,
} from './constants.js';
import type { SocialMediaDb, SocialMediaTx } from './data/social-media-db.js';
import {
  DEFAULT_SOCIAL_VIDEO_JOB_TIMEOUT_MS,
  SOCIAL_MEDIA_OPTIONS,
  SOCIAL_MEDIA_POST_DETECTION,
  type SocialMediaModuleOptions,
  type SocialMediaPostDetection,
} from './social-media-host-hooks.js';
import {
  SocialMediaDetectorService,
  VideoDetectionInput,
  DetectionResult,
  SocialPlatform,
} from './social-media-detector.service.js';
import { SocialMediaOcrService } from './social-media-ocr.service.js';

/** The canonical "umbrella" tag applied to every detected social-media item. */
const SOCIAL_TAG = 'Social Media';

/** Platform → display tag name. `other` gets no platform-specific tag. */
const PLATFORM_TAG: Record<SocialPlatform, string | null> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  other: null,
};

/** Every tag name this handler may apply — used to strip on a rerun-gone-clean. */
const ALL_SOCIAL_TAG_NAMES = [SOCIAL_TAG, 'TikTok', 'Instagram', 'Facebook'];

/**
 * Optional hard cap (bytes) on videos processed by video enrichment; 0
 * (default) disables the cap. Shared env var with video face detection so
 * operators set one knob for both.
 */
const VIDEO_ENRICHMENT_MAX_BYTES = (): number =>
  parseInt(process.env['VIDEO_ENRICHMENT_MAX_BYTES'] ?? '0', 10);

/**
 * What the persist half needs of a job: its id, its media item and why it was queued.
 *
 * @stability experimental
 */
export interface SocialMediaJobContext {
  readonly id: string;
  readonly mediaItemId: string;
  /** The enqueue reason, which sets the priority of the withheld video jobs. */
  readonly reason: SocialJobReason;
}

/** The queue's job reason as one of the three the fan-out takes (anything else reads as an upload). */
function toJobReason(reason: MemoriahubJob['reason']): SocialJobReason {
  const value = String(reason);
  return value === SOCIAL_JOB_REASON.rerun || value === SOCIAL_JOB_REASON.backfill ? value : SOCIAL_JOB_REASON.upload;
}

/**
 * The `social_media_detection` job handler (node-eligible: a node submits the verdict, the server persists it).
 *
 * @stability experimental
 */
@Injectable()
export class SocialMediaDetectionHandler implements MemoriahubJobHandler, OnModuleInit {
  readonly type = SOCIAL_MEDIA_JOB_TYPE;
  readonly label = 'Social media detection';
  /**
   * A video download (legacy re-probe or OCR), ffprobe and up to a few OCR
   * frames: 20 minutes by default, the same video bucket as video face
   * detection, still overridable for one release through
   * ENRICHMENT_VIDEO_JOB_TIMEOUT_MS (the host passes it as `videoJobTimeoutMs`).
   */
  readonly profile: MemoriahubJobProfile;

  /**
   * Node-eligibility (distributed workers): the payload a node submits via
   * POST /api/nodes/:id/jobs/:jobId/result for this job type — the shared
   * contract from @marinoscar/memoriahub-compute/dto. The pre-flight caps
   * (§4b), orientation gate (§4c), and tag/status persistence (§7) remain
   * server-authoritative — see persistSocialMedia below; a node only ever
   * computes the Tier-1/Tier-2 classification verdict (computeSocialMedia).
   */
  readonly nodeResultSchema = socialMediaDetectionResultSchema;

  private readonly logger = new Logger(SocialMediaDetectionHandler.name);

  constructor(
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: SocialMediaDb,
    @Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort,
    private readonly detector: SocialMediaDetectorService,
    private readonly ocr: SocialMediaOcrService,
    @Inject(MEMORIAHUB_OBJECT_STORE) private readonly objectStore: MemoriahubObjectStorePort,
    @Inject(SOCIAL_MEDIA_POST_DETECTION) private readonly postDetection: SocialMediaPostDetection,
    @Optional() @Inject(SOCIAL_MEDIA_OPTIONS) options?: SocialMediaModuleOptions,
    // Metrics: `app.media.social.classified`, system tags in `app.media.tags.applied`.
    @Optional() @Inject(MEMORIAHUB_METRICS) private readonly metrics?: MemoriahubMetricsPort,
  ) {
    this.profile = { maxRuntimeMs: options?.videoJobTimeoutMs ?? DEFAULT_SOCIAL_VIDEO_JOB_TIMEOUT_MS, maxAttempts: 3 };
  }

  /** Registers the handler with the queue. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------

  async process(platformJob: MemoriahubJob): Promise<void> {
    const context = await resolveMediaItemJob(this.prisma, platformJob, this.logger);
    if (!context) return;
    const job: SocialMediaJobContext = {
      id: platformJob.id,
      mediaItemId: context.mediaItemId,
      reason: toJobReason(platformJob.reason),
    };
    const mediaItemId = job.mediaItemId;

    // --- 1. Load MediaItem ---
    const mediaItem = await this.prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: {
        id: true,
        circleId: true,
        type: true,
        deletedAt: true,
        addedById: true,
        originalFilename: true,
        durationMs: true,
        width: true,
        height: true,
        socialMediaSource: true,
        storageObject: {
          select: {
            storageKey: true,
            storageProvider: true,
            bucket: true,
            name: true,
            size: true,
            metadata: true,
          },
        },
      },
    });

    if (
      !mediaItem ||
      mediaItem.deletedAt ||
      mediaItem.type !== SOCIAL_MEDIA_TYPE.video ||
      !mediaItem.storageObject
    ) {
      this.logger.debug(
        `social_media_detection job ${job.id}: MediaItem ${mediaItemId} not an active video (or missing storageObject); skipping`,
      );
      await this.upsertStatus(mediaItemId, {
        status: SOCIAL_STATUS.not_processed,
      });
      return;
    }

    // Lazily-downloaded video, streamed directly to a temp file (constant
    // memory) and shared between legacy re-probe and OCR. Memoized at this
    // outer scope (not inside the try below) so the finally block can clean
    // it up exactly once, after every use is done, regardless of outcome.
    let downloadedVideoPath: string | null = null;

    try {
      // --- 2. Feature gate ---
      const { value: features } = await this.settings.readSystem<Record<string, unknown>>('features');
      const featureOn = features?.['socialMediaDetection'] === true;
      const killed = process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false';

      if (!featureOn || killed) {
        this.logger.debug(
          `social_media_detection job ${job.id}: feature disabled; marking not_processed`,
        );
        await this.upsertStatus(mediaItemId, {
          status: SOCIAL_STATUS.not_processed,
        });
        return;
      }

      const { value: socialMedia } = await this.settings.readSystem<SocialMediaSettings | undefined>('socialMedia');
      const minConfidence = socialMedia?.minConfidence ?? 0.8;

      // --- 3. Status → processing ---
      await this.upsertStatus(mediaItemId, {
        status: SOCIAL_STATUS.processing,
      });

      // --- 4. Build VideoDetectionInput ---
      const filename = mediaItem.originalFilename || mediaItem.storageObject.name || null;
      const fileExt =
        extname(mediaItem.storageObject.name || mediaItem.originalFilename || '') || '.mp4';

      const probe = readPersistedProbe(mediaItem.storageObject.metadata);

      // --- 4b. Pre-flight caps (cheapest checks first — no download) ---
      // Operator domain fact: genuine social-media clips (TikTok/Instagram/
      // Facebook re-uploads) never exceed ~5 minutes — anything longer is
      // treated as CLEAN without downloading or OCR'ing a single byte. When
      // the duration is unknown (no persisted probe), the object size is the
      // fallback signal. The env hard cap (shared with video face detection)
      // is checked first and unconditionally.
      const knownDurationMs = probe?.durationMs ?? mediaItem.durationMs ?? undefined;
      const sizeBytes = mediaItem.storageObject.size;
      const maxDurationSeconds = socialMedia?.maxDurationSeconds ?? 300;
      const maxSizeBytes = socialMedia?.maxSizeBytes ?? 500_000_000;
      const hardCapBytes = VIDEO_ENRICHMENT_MAX_BYTES();

      let skipRule: string | null = null;
      if (hardCapBytes > 0 && sizeBytes > BigInt(hardCapBytes)) {
        skipRule = 'skip-size-cap';
      } else if (knownDurationMs !== undefined && knownDurationMs > maxDurationSeconds * 1000) {
        skipRule = 'skip-duration-cap';
      } else if (knownDurationMs === undefined && sizeBytes > BigInt(maxSizeBytes)) {
        skipRule = 'skip-size-cap';
      }

      if (skipRule) {
        // Route through the normal clean path so a previously-flagged item
        // still gets its stale system tags stripped + source cleared, and the
        // withheld downstream video enrichment still fans out.
        await this.applyClean(mediaItem.id, mediaItem.socialMediaSource, skipRule);
        this.logger.log(
          `social_media_detection job ${job.id}: MediaItem ${mediaItemId} skipped as clean (${skipRule}) — ` +
            `duration=${knownDurationMs !== undefined ? `${knownDurationMs}ms` : 'unknown'}, size=${sizeBytes} bytes`,
        );
        await this.postDetection.enqueueVideoPostDetectionEnrichment(
          {
            id: mediaItem.id,
            type: mediaItem.type,
            circleId: mediaItem.circleId,
            deletedAt: mediaItem.deletedAt,
          },
          job.reason,
        );
        return;
      }

      // --- 4c. Orientation gate ---
      // Operator domain fact: TikTok/Instagram videos are never landscape;
      // Facebook can be, but landscape FB re-shares are accepted as covered by
      // the filename/metadata rules alone. A strictly-landscape video is
      // therefore never downloaded for this job: the legacy re-probe is
      // skipped (Tier-1 runs on filename + whatever persisted metadata exists,
      // even if incomplete) and Tier-2 OCR is forced off. Deliberate
      // precision-over-compute tradeoff — a landscape video detectable only
      // via watermark OCR is missed.
      const knownWidth = probe?.width ?? mediaItem.width ?? undefined;
      const knownHeight = probe?.height ?? mediaItem.height ?? undefined;
      const isLandscape =
        knownWidth !== undefined && knownHeight !== undefined && knownWidth > knownHeight;

      // Memoizes the temp file PATH (not a buffer) so repeated calls reuse
      // the same download.
      const downloadVideo = async (): Promise<string> => {
        if (downloadedVideoPath) return downloadedVideoPath;
        const provider = await this.objectStore.forLocation(
          mediaItem.storageObject!.storageProvider,
          mediaItem.storageObject!.bucket,
        );
        // Shared helper (issue #456) — one implementation of the
        // disk-guard -> download -> partial-file-cleanup sequence, instead of
        // the byte-identical copy this and VideoFaceDetectionService each had.
        const { path: tmpPath } = await downloadToTempFile({
          getStream: () => provider.download(mediaItem.storageObject!.storageKey),
          sizeBytes,
          prefix: 'memoriahub-job-social-dl-',
          extension: fileExt,
        });
        downloadedVideoPath = tmpPath;
        return downloadedVideoPath;
      };

      let input: VideoDetectionInput;
      let durationMs: number | undefined;

      if (probe && probe.formatTags) {
        input = {
          kind: 'video',
          filename,
          formatTags: probe.formatTags,
          streamTags: probe.streamTags,
          formatName: probe.formatName,
          durationMs: probe.durationMs ?? mediaItem.durationMs ?? undefined,
          width: probe.width ?? mediaItem.width ?? undefined,
          height: probe.height ?? mediaItem.height ?? undefined,
        };
        durationMs = probe.durationMs ?? mediaItem.durationMs ?? undefined;
      } else if (isLandscape) {
        // Landscape + no persisted container tags: do NOT download for a
        // re-probe (see orientation gate above) — run Tier-1 with the filename
        // and whatever partial persisted metadata exists.
        input = {
          kind: 'video',
          filename,
          formatTags: probe?.formatTags,
          streamTags: probe?.streamTags,
          formatName: probe?.formatName,
          durationMs: knownDurationMs,
          width: knownWidth,
          height: knownHeight,
        };
        durationMs = knownDurationMs;
      } else {
        // Legacy item probed before this feature existed → re-probe on the fly.
        const videoPath = await downloadVideo();
        const container = await this.reprobe(videoPath);
        input = {
          kind: 'video',
          filename,
          formatTags: container.formatTags,
          streamTags: container.streamTags,
          formatName: container.formatName,
          durationMs: container.durationMs ?? mediaItem.durationMs ?? undefined,
          width: container.width ?? mediaItem.width ?? undefined,
          height: container.height ?? mediaItem.height ?? undefined,
        };
        durationMs = container.durationMs ?? mediaItem.durationMs ?? undefined;
      }

      // --- 5-6. Compute half: Tier-1 detection + Tier-2 OCR fallback ---
      const ocrEnabled = socialMedia?.ocrEnabled !== false;
      const computed = await this.computeSocialMedia(input, {
        minConfidence,
        isLandscape,
        ocrEnabled,
        downloadVideo,
        durationMs,
        fileExt,
        ocrMaxFrames: socialMedia?.ocrMaxFrames ?? 4,
        ocrLanguages: socialMedia?.ocrLanguages ?? ['eng'],
        ocrTimeoutMs: (socialMedia?.ocrTimeoutSeconds ?? 60) * 1000,
      });

      // --- 7. Persist half ---
      await this.persistSocialMedia(job, computed, mediaItem);

      if (computed.verdict === 'detected') {
        this.logger.log(
          `social_media_detection job ${job.id}: MediaItem ${mediaItemId} flagged ${computed.platform} ` +
            `(method=${computed.detectionMethod}, rule=${computed.matchedRule}, confidence=${computed.confidence})`,
        );
      } else {
        this.logger.log(
          `social_media_detection job ${job.id}: MediaItem ${mediaItemId} clean` +
            (mediaItem.socialMediaSource ? ' (was previously flagged — tags cleared)' : ''),
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`social_media_detection job ${job.id}: ${errMsg}`);
      await this.upsertStatus(mediaItemId, {
        status: SOCIAL_STATUS.failed,
        lastError: errMsg,
      }).catch(() => {});
      throw err;
    } finally {
      // Clean up the downloaded temp file exactly once, after every use
      // (legacy re-probe and/or OCR) is done — regardless of outcome.
      if (downloadedVideoPath) {
        await fs.unlink(downloadedVideoPath).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // computeSocialMedia — COMPUTE half of the split.
  //
  // Runs Tier-1 (metadata/filename) detection against the already-built
  // VideoDetectionInput, then falls back to Tier-2 OCR when Tier-1 is
  // inconclusive-but-suspicious and OCR is enabled. Returns the node-result
  // DTO — the SAME shape a distributed worker node submits via
  // POST /api/nodes/:id/jobs/:jobId/result for this job type.
  //
  // This is the SERVER-side compute half, used by the in-process path
  // (process(), above) via the memoized `downloadVideo` closure it is handed.
  // A distributed worker node runs the equivalent classification locally
  // (its own ffprobe + Tier-1 + Tier-2 OCR against the downloaded file) and
  // submits the resulting DTO directly, bypassing this method — the
  // pre-flight caps, orientation gate, and VideoDetectionInput construction
  // that precede this call in process() stay server-authoritative and are
  // NOT part of what a node computes.
  // ---------------------------------------------------------------------------

  /**
   * The compute half: Tier-1 detection over the built input, then the Tier-2 OCR fallback when Tier 1 is
   * inconclusive but suspicious. Returns the node-result DTO a worker node submits for the same job.
   *
   * @param input - the video's detection input.
   * @param opts - the thresholds, the OCR knobs and the memoized video download.
   */
  async computeSocialMedia(
    input: VideoDetectionInput,
    opts: {
      minConfidence: number;
      /** Landscape videos never get Tier-2 OCR — see the orientation gate in process(). */
      isLandscape: boolean;
      ocrEnabled: boolean;
      /** Memoized video-download closure — called at most once, only if Tier-2 OCR actually runs. */
      downloadVideo: () => Promise<string>;
      durationMs: number | undefined;
      fileExt: string;
      ocrMaxFrames: number;
      ocrLanguages: string[];
      ocrTimeoutMs: number;
    },
  ): Promise<SocialMediaDetectionResult> {
    const { result: tier1Result, recommendTier2: tier1RecommendsOcr } =
      this.detector.detectTier1(input, opts.minConfidence);
    const recommendTier2 = tier1RecommendsOcr && !opts.isLandscape;

    let result: DetectionResult | null = tier1Result;
    let ocrText: string | null = null;

    if (!result && recommendTier2 && opts.ocrEnabled) {
      const videoPath = await opts.downloadVideo();
      const { texts } = await this.ocr.recognizeVideo(videoPath, {
        durationMs: opts.durationMs,
        fileExtension: opts.fileExt,
        maxFrames: opts.ocrMaxFrames,
        languages: opts.ocrLanguages,
        timeoutMs: opts.ocrTimeoutMs,
      });
      ocrText = texts.length > 0 ? texts.join(' \n ') : null;
      const ocrResult = this.detector.detectFromOcr(texts, input, opts.minConfidence);
      if (ocrResult) {
        result = ocrResult;
      }
    }

    if (result) {
      return {
        verdict: 'detected',
        score: result.confidence,
        ocrText,
        platform: result.platform,
        detectionMethod: result.method,
        matchedRule: result.matchedRule,
        confidence: result.confidence,
      };
    }

    return {
      verdict: 'clean',
      score: 0,
      ocrText,
      platform: null,
      detectionMethod: null,
      matchedRule: null,
      confidence: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // persistSocialMedia — PERSIST half of the split.
  //
  // Shared by the in-process path (process(), above, which passes the
  // already-loaded mediaItem to avoid a redundant query) and the node
  // result-ingestion path (persistNodeResult, below — which has no
  // preloaded mediaItem and fetches it fresh). Applies tags/status/source
  // for a 'detected' verdict, or strips stale tags + fans out withheld video
  // enrichment for a 'clean' verdict — identical to the pre-split §7/§7b
  // logic.
  // ---------------------------------------------------------------------------

  /**
   * The persist half, shared by the in-process path and a node's submitted result: applies the tags, the
   * status and the source column for a DETECTED verdict, or strips stale tags and fans out the withheld
   * video enrichment for a CLEAN one.
   *
   * @param job - the job's id, media item and enqueue reason.
   * @param result - the verdict.
   * @param preloadedMediaItem - the already-loaded item, to skip a re-read.
   */
  async persistSocialMedia(
    job: SocialMediaJobContext,
    result: SocialMediaDetectionResult,
    preloadedMediaItem?: {
      id: string;
      circleId: string;
      type: string;
      deletedAt: Date | null;
      addedById: string;
      socialMediaSource: string | null;
    },
  ): Promise<void> {
    const mediaItem =
      preloadedMediaItem ??
      (await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: {
          id: true,
          circleId: true,
          type: true,
          deletedAt: true,
          addedById: true,
          socialMediaSource: true,
        },
      }));

    if (!mediaItem) {
      throw new Error(`MediaItem ${job.mediaItemId} not found`);
    }

    if (result.verdict === 'detected') {
      if (!result.platform || !result.detectionMethod) {
        throw new Error(
          'social_media_detection result: platform and detectionMethod are required for a detected verdict',
        );
      }
      const detectionResult: DetectionResult = {
        platform: result.platform,
        method: result.detectionMethod,
        confidence: result.confidence,
        matchedRule: result.matchedRule ?? 'unknown',
      };
      await this.applyDetected(mediaItem.id, mediaItem.circleId, mediaItem.addedById, detectionResult);
      // Detected items do NOT fan out to further video enrichment.
      return;
    }

    // Clean
    await this.applyClean(mediaItem.id, mediaItem.socialMediaSource, result.matchedRule, result.detectionMethod ?? null);

    // Fan out the downstream video enrichment that was withheld while
    // classification was pending.
    await this.postDetection.enqueueVideoPostDetectionEnrichment(
      {
        id: mediaItem.id,
        type: mediaItem.type,
        circleId: mediaItem.circleId,
        deletedAt: mediaItem.deletedAt,
      },
      job.reason,
    );
  }

  /**
   * Persist a node-computed social_media_detection result (already validated
   * against nodeResultSchema by the ingestion endpoint; re-parsed here for
   * type narrowing, mirroring DuplicateDetectionHandler's precedent). A media
   * item deleted since the job was claimed settles as a no-op.
   */
  async persistNodeResult(job: MemoriahubJob, result: unknown): Promise<void> {
    const parsed = socialMediaDetectionResultSchema.parse(result);
    const context = await resolveMediaItemJob(this.prisma, job, this.logger);
    if (!context) return;
    await this.persistSocialMedia(
      { id: job.id, mediaItemId: context.mediaItemId, reason: toJobReason(job.reason) },
      parsed,
    );
  }

  // ---------------------------------------------------------------------------
  // Result application
  // ---------------------------------------------------------------------------

  /** Detected: apply tags, write status + denormalized source column. */
  private async applyDetected(
    mediaItemId: string,
    circleId: string,
    addedById: string,
    result: DetectionResult,
  ): Promise<void> {
    const tagNames = [SOCIAL_TAG];
    const platformTag = PLATFORM_TAG[result.platform];
    if (platformTag) tagNames.push(platformTag);

    await this.prisma.$transaction(async (tx: SocialMediaTx) => {
      for (const name of tagNames) {
        const tag = await tx.tag.upsert({
          where: { circleId_name: { circleId, name } },
          create: { addedById, circleId, name },
          update: {},
        });
        // Create the join as a system tag; never downgrade an existing manual row.
        await tx.mediaTag.upsert({
          where: { tagId_mediaItemId: { tagId: tag.id, mediaItemId } },
          create: { tagId: tag.id, mediaItemId, source: SOCIAL_TAG_SOURCE.system },
          update: {},
        });
        // Promote an existing AI-applied row (but not manual) to system so the
        // system provenance wins for these labels.
        await tx.mediaTag.updateMany({
          where: { tagId: tag.id, mediaItemId, source: SOCIAL_TAG_SOURCE.ai },
          data: { source: SOCIAL_TAG_SOURCE.system },
        });
      }

      await tx.mediaSocialStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          status: SOCIAL_STATUS.processed,
          isSocialMedia: true,
          platform: result.platform,
          detectionMethod: result.method,
          confidence: result.confidence,
          matchedRule: result.matchedRule,
          processedAt: new Date(),
          lastError: null,
        },
        update: {
          status: SOCIAL_STATUS.processed,
          isSocialMedia: true,
          platform: result.platform,
          detectionMethod: result.method,
          confidence: result.confidence,
          matchedRule: result.matchedRule,
          processedAt: new Date(),
          lastError: null,
        },
      });

      await tx.mediaItem.update({
        where: { id: mediaItemId },
        data: { socialMediaSource: result.platform },
      });
    });
    this.metrics?.add('mediaSocialClassified', 1, { platform: result.platform, method: result.method });
    this.metrics?.add('mediaTagsApplied', tagNames.length, { media_type: 'video', source: 'system' });
  }

  /**
   * Clean: write status; if previously flagged, strip system tags + clear
   * source. `matchedRule` records WHY the item read as clean when it was
   * decided by a pre-flight cap (e.g. 'skip-duration-cap' / 'skip-size-cap')
   * rather than a full two-tier pass; null for a genuine no-match.
   */
  private async applyClean(
    mediaItemId: string,
    previousSource: string | null,
    matchedRule: string | null = null,
    method: string | null = null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: SocialMediaTx) => {
      await tx.mediaSocialStatus.upsert({
        where: { mediaItemId },
        create: {
          mediaItemId,
          status: SOCIAL_STATUS.processed,
          isSocialMedia: false,
          platform: null,
          detectionMethod: null,
          confidence: null,
          matchedRule,
          processedAt: new Date(),
          lastError: null,
        },
        update: {
          status: SOCIAL_STATUS.processed,
          isSocialMedia: false,
          platform: null,
          detectionMethod: null,
          confidence: null,
          matchedRule,
          processedAt: new Date(),
          lastError: null,
        },
      });

      if (previousSource) {
        // Remove the system-applied social tags left over from the prior flag.
        await tx.mediaTag.deleteMany({
          where: {
            mediaItemId,
            source: SOCIAL_TAG_SOURCE.system,
            tag: { name: { in: ALL_SOCIAL_TAG_NAMES } },
          },
        });
        await tx.mediaItem.update({
          where: { id: mediaItemId },
          data: { socialMediaSource: null },
        });
      }
    });
    // A pre-flight cap reads as `skip`; a full pass without a recorded method as Tier-1 `metadata`.
    this.metrics?.add('mediaSocialClassified', 1, {
      platform: 'clean',
      method: matchedRule?.startsWith('skip-') ? 'skip' : (method ?? 'metadata'),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async upsertStatus(
    mediaItemId: string,
    data: {
      status: SocialStatus;
      lastError?: string | null;
    },
  ): Promise<void> {
    await this.prisma.mediaSocialStatus.upsert({
      where: { mediaItemId },
      create: {
        mediaItemId,
        status: data.status,
        lastError: data.lastError ?? null,
      },
      update: {
        status: data.status,
        ...(data.lastError !== undefined ? { lastError: data.lastError } : {}),
      },
    });
  }

  /** Run ffprobe → ContainerMetadata against an already-downloaded temp file. */
  private async reprobe(videoPath: string) {
    const data = await probeVideoFile(videoPath);
    return extractContainerMetadata(data);
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** The `socialMedia` settings namespace as the handler reads it (every field optional; the defaults are the schema's). */
interface SocialMediaSettings {
  minConfidence?: number;
  ocrEnabled?: boolean;
  ocrMaxFrames?: number;
  ocrLanguages?: string[];
  ocrTimeoutSeconds?: number;
  maxDurationSeconds?: number;
  maxSizeBytes?: number;
}

interface PersistedProbe {
  formatTags?: Record<string, string>;
  streamTags?: Array<Record<string, string>>;
  formatName?: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

/**
 * Read the persisted `video-probe` block from StorageObject.metadata._processing.
 * Returns null when absent or malformed.
 */
function readPersistedProbe(metadata: unknown): PersistedProbe | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const processing = (metadata as Record<string, unknown>)['_processing'];
  if (!processing || typeof processing !== 'object') return null;
  const probe = (processing as Record<string, unknown>)['video-probe'];
  if (!probe || typeof probe !== 'object') return null;

  const p = probe as Record<string, unknown>;
  const formatTags =
    p['formatTags'] && typeof p['formatTags'] === 'object'
      ? (p['formatTags'] as Record<string, string>)
      : undefined;
  const streamTags = Array.isArray(p['streamTags'])
    ? (p['streamTags'] as Array<Record<string, string>>)
    : undefined;

  return {
    formatTags,
    streamTags,
    formatName: typeof p['formatName'] === 'string' ? (p['formatName'] as string) : undefined,
    durationMs: typeof p['durationMs'] === 'number' ? (p['durationMs'] as number) : undefined,
    width: typeof p['width'] === 'number' ? (p['width'] as number) : undefined,
    height: typeof p['height'] === 'number' ? (p['height'] as number) : undefined,
  };
}

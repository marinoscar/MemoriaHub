// =============================================================================
// VideoInputResolver
// =============================================================================
//
// Decides how a video-enrichment job gets its bytes to ffmpeg (epic #452,
// issue #456), and hands back a uniform handle either way.
//
// THE PROBLEM. Every video enrichment path downloads the ENTIRE file to a temp
// file before touching it. For video auto-tagging that means pulling a
// multi-gigabyte file across the network and onto disk in order to extract six
// frames and thirty seconds of audio. The bytes actually needed are a rounding
// error against the bytes moved, and on a memory- and disk-constrained VPS
// this is the single biggest driver of the disk pressure that
// `assertDiskSpaceForDownload` and `TempFileJanitorTask` exist to contain.
//
// THE FIX. ffmpeg speaks HTTP and issues Range requests, so `-ss` fast input
// seek against a presigned URL fetches only the ranges around each seek point.
// The storage layer already mints presigned GETs, so no new capability is
// needed.
//
// THE SAFETY PROPERTY, and it is the whole reason this is shippable: the
// fallback is the EXISTING, PROVEN download path, unchanged. Every failure
// mode of the streaming path — provider ignores Range, a non-faststart MP4
// whose index sits at the end of the file, an unrecognized container, a probe
// error, the setting turned off, no URL available — routes to it. The worst
// case of this feature is therefore exactly today's behavior plus one 64 KB
// probe read.
//
// SCOPE. Only `video_auto_tagging` consumes this today. Applying it to
// `video_face_detection` or `social_media_detection` is deliberately NOT in
// scope — those are shipped features, and this should be proven on the new,
// off-by-default job type first.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { probeRangeSeekSuitability } from '@memoriahub/enrichment-compute/video';
import { StorageProviderResolver } from '../../storage/providers/storage-provider.resolver';
import { downloadToTempFile } from '../../storage/processing/processors/stream-utils';

/**
 * Presigned-URL lifetime for a streamed read.
 *
 * A long ffmpeg session against an EXPIRING URL fails mid-run, so this must
 * comfortably exceed the job's expected runtime. `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS`
 * caps a video job at 20 minutes by default, so 2 hours leaves a wide margin —
 * and an expiry that somehow still bit would surface as an ffmpeg failure the
 * caller treats like any other, i.e. a failed job the queue retries.
 */
const STREAM_URL_TTL_SECONDS = 2 * 60 * 60;

export interface ResolvedVideoInput {
  /** Path or URL to hand ffmpeg. */
  source: string;
  /** Which path was taken — logged so the win is measurable, not assumed. */
  mode: 'stream' | 'download';
  /** Why this mode was chosen. */
  reason: string;
  /** Bytes this resolver itself moved (0 for a stream beyond the probe). */
  bytesMoved: number;
  /** Always call in a `finally`; a no-op for the streaming path. */
  cleanup: () => Promise<void>;
}

export interface VideoInputRequest {
  storageKey: string;
  storageProvider: string;
  bucket: string | null;
  /** Object size, for the download path's disk-space pre-flight. */
  sizeBytes: bigint | number;
  /** File extension including the dot, for ffmpeg container detection. */
  extension?: string;
  /** Temp filename prefix used by the download path. */
  tempPrefix: string;
  /** Whether the streaming path may be attempted at all (admin setting). */
  streamingEnabled: boolean;
  /** For log correlation. */
  jobId: string;
}

@Injectable()
export class VideoInputResolver {
  private readonly logger = new Logger(VideoInputResolver.name);

  constructor(private readonly resolver: StorageProviderResolver) {}

  async resolve(req: VideoInputRequest): Promise<ResolvedVideoInput> {
    const provider = await this.resolver.getProviderFor(req.storageProvider, req.bucket);

    if (req.streamingEnabled) {
      const streamed = await this.tryStream(req);
      if (streamed) return streamed;
    }

    const startedAt = Date.now();
    const { path, cleanup } = await downloadToTempFile({
      getStream: () => provider.download(req.storageKey),
      sizeBytes: req.sizeBytes,
      prefix: req.tempPrefix,
      ...(req.extension ? { extension: req.extension } : {}),
    });

    const bytesMoved = Number(req.sizeBytes);
    this.logger.log(
      `VideoInput ${req.jobId}: mode=download bytes=${bytesMoved} elapsedMs=${Date.now() - startedAt}` +
        `${req.streamingEnabled ? '' : ' (streaming disabled)'}`,
    );

    return {
      source: path,
      mode: 'download',
      reason: req.streamingEnabled ? 'streaming unavailable' : 'streaming disabled',
      bytesMoved,
      cleanup,
    };
  }

  /**
   * Attempt the streaming path. Returns `null` — never throws — when it is not
   * usable, so the caller falls through to the download.
   */
  private async tryStream(req: VideoInputRequest): Promise<ResolvedVideoInput | null> {
    const startedAt = Date.now();
    try {
      const provider = await this.resolver.getProviderFor(req.storageProvider, req.bucket);
      const url = await provider.getSignedDownloadUrl(req.storageKey, {
        expiresIn: STREAM_URL_TTL_SECONDS,
      });
      if (!url) return null;

      const probe = await probeRangeSeekSuitability(url);
      if (probe.verdict !== 'suitable') {
        this.logger.log(
          `VideoInput ${req.jobId}: falling back to download — ${probe.verdict} (${probe.detail})`,
        );
        return null;
      }

      this.logger.log(
        `VideoInput ${req.jobId}: mode=stream probeBytes=${probe.bytesRead} ` +
          `objectBytes=${req.sizeBytes} elapsedMs=${Date.now() - startedAt} — ${probe.detail}`,
      );

      return {
        source: url,
        mode: 'stream',
        reason: probe.detail,
        bytesMoved: probe.bytesRead,
        // Nothing was materialized, so there is nothing to clean up.
        cleanup: async () => {},
      };
    } catch (err) {
      this.logger.log(
        `VideoInput ${req.jobId}: falling back to download — streaming setup failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

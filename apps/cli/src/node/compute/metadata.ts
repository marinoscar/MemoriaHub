/**
 * node/compute/metadata.ts — Metadata-extraction compute.
 *
 * Runs the same EXIF / dimensions / video-probe extraction the server runs,
 * via the shared `@memoriahub/enrichment-compute` parity package, so a node's
 * result is numerically/structurally identical to the server's own compute
 * (distributed-nodes spec §7). This mirrors
 * apps/api/src/metadata/metadata.service.ts's `computeMetadata` — the pure
 * compute half of the metadata_extraction compute/persist split. Geocoding is
 * NOT part of this module: it requires the server's configured geo provider
 * credentials and always runs server-side in the persist half
 * (MetadataExtractionService.persistMetadata / buildProcessingEntries).
 *
 * The result payload matches the server's zod DTO for
 * `POST /api/nodes/:id/jobs/:jobId/result` with `type: 'metadata_extraction'`:
 * `{ exif: Record<string, unknown>, probe: Record<string, unknown> | null }` —
 * image-side width/height ride inside `exif` (folded in, exactly as the
 * server's DTO documents), `probe` is the video-probe entry (null for photos).
 *
 * mimeType resolution: the downloaded temp file has no extension (see
 * node-engine.ts's tmpPath naming), so this module cannot sniff the type from
 * the file name. Instead it reads `params.mimeType`, which the server now
 * includes in the metadata_extraction job's payload at enqueue time
 * (MetadataController.rerunMetadata / MetadataBackfillService — see the
 * comment there) specifically so a node can dispatch to the image vs. video
 * path without a second DB lookup. A job claimed without `params.mimeType`
 * (e.g. an older job row enqueued before this payload field existed) throws
 * CapabilityUnavailableError rather than guessing.
 */

import { readFile } from 'node:fs/promises';
import {
  extractExif,
  extractDimensions,
  probeVideo,
  extractContainerMetadata,
} from '@memoriahub/enrichment-compute/metadata';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';

/** Mirrors MetadataExtractionService.buildProbeEntry's shape exactly. */
async function buildProbeEntry(filePath: string): Promise<Record<string, unknown>> {
  const timeoutMs = Number(process.env['FFPROBE_TIMEOUT_MS']) || 30000;
  const probeData = await probeVideo(filePath, { ffprobeTimeoutMs: timeoutMs });
  const container = extractContainerMetadata(probeData);
  const { durationMs, width, height, codec, formatName, formatTags, streamTags } = container;

  const videoStream = probeData.streams?.find((s) => s.codec_type === 'video');
  const rawCreationTime: unknown =
    probeData.format?.tags?.['creation_time'] ?? videoStream?.tags?.['creation_time'];

  let capturedAt: string | undefined;
  if (typeof rawCreationTime === 'string' && rawCreationTime.length > 0) {
    const d = new Date(rawCreationTime);
    if (!isNaN(d.getTime())) {
      capturedAt = d.toISOString();
    }
  }

  const metadata: Record<string, unknown> = {};
  if (durationMs !== undefined) metadata['durationMs'] = durationMs;
  if (typeof width === 'number') metadata['width'] = width;
  if (typeof height === 'number') metadata['height'] = height;
  if (typeof codec === 'string') metadata['codec'] = codec;
  if (capturedAt !== undefined) metadata['capturedAt'] = capturedAt;
  if (formatName !== undefined) metadata['formatName'] = formatName;
  metadata['formatTags'] = formatTags;
  metadata['streamTags'] = streamTags;

  return metadata;
}

const computeMetadata: ComputeFn = async (inputPath, params) => {
  const mimeType = params['mimeType'];
  if (typeof mimeType !== 'string' || mimeType.length === 0) {
    throw new CapabilityUnavailableError(
      'metadata_extraction job payload is missing mimeType — cannot dispatch to image/video compute path (older job rows enqueued before this field existed are not node-eligible; re-enqueue via rerun or backfill)',
      'metadata_extraction',
    );
  }

  const exif: Record<string, unknown> = {};
  let probe: Record<string, unknown> | null = null;

  if (mimeType.startsWith('image/')) {
    const buffer = await readFile(inputPath);

    try {
      Object.assign(exif, await extractExif(buffer));
    } catch (err) {
      throw new Error(`metadata_extraction: exif extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const dims = await extractDimensions(buffer);
      if (dims) {
        exif['width'] = dims.width;
        exif['height'] = dims.height;
      }
    } catch (err) {
      throw new Error(`metadata_extraction: dimension extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (mimeType.startsWith('video/')) {
    try {
      probe = await buildProbeEntry(inputPath);
    } catch (err) {
      throw new Error(`metadata_extraction: video probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    throw new CapabilityUnavailableError(
      `metadata_extraction: unsupported mimeType "${mimeType}" (expected image/* or video/*)`,
      'metadata_extraction',
    );
  }

  return { exif, probe };
};

export default computeMetadata;

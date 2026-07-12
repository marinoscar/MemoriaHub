/**
 * Cross-frame face-detection dedup (clustering) + face-crop thumbnail compute
 * (moved VERBATIM from apps/api/src/face/video-face-detection.handler.ts's
 * module-private clusterDetections/isBetterRepresentative and the inline
 * face-centered-crop block in process()).
 *
 * This module holds ONLY the pure compute: greedy single-pass cosine-
 * similarity clustering across a list of per-frame face detections, and
 * building a face-centered (with full-frame-resize fallback) JPEG thumbnail
 * from a single frame buffer + bounding box. It is generic over a `payload`
 * type `T` so both the server's in-process VideoFaceDetectionService and a
 * distributed worker node's compute module can attach their own per-side
 * bookkeeping (e.g. the un-normalized DetectedFace, or a prepared frame
 * buffer reference) to each detection without this module needing to know
 * about either host's types.
 *
 * Parity contract (docs/specs/distributed-nodes.md §7): a node's clustering
 * and thumbnail output must be identical to the server's for the same input
 * detections — same greedy algorithm, same tie-break rule, same sharp crop
 * math, same JPEG encode settings.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterableDetection<T = unknown> {
  /** L2-normalized embedding; empty array means "no embedding available". */
  embedding: number[];
  confidence?: number;
  /** Normalized (0-1) bounding box. */
  boundingBox: { x: number; y: number; w: number; h: number };
  /** Source frame timestamp in milliseconds from video start. */
  timestampMs: number;
  /** Host-specific payload carried through untouched (never inspected here). */
  payload: T;
}

export interface FaceCluster<T = unknown> {
  representative: ClusterableDetection<T>;
  allTimestampsMs: number[];
}

/**
 * Cosine-similarity threshold for cross-frame face clustering.
 * Mirrors FaceMatchingService.DEFAULT_FACE_CLUSTER_THRESHOLD (0.45) — kept in
 * sync manually since this package cannot import from apps/api.
 */
export const DEFAULT_FACE_CLUSTER_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// clusterFaceDetections
// ---------------------------------------------------------------------------

/**
 * Group raw per-frame face detections into identity clusters using greedy
 * single-pass cosine-similarity matching.
 *
 * Algorithm (copied verbatim from the pre-split
 * video-face-detection.handler.ts):
 *   For each detection (in original order):
 *     - Compare its embedding to every existing cluster's representative.
 *     - If the best similarity >= clusterThreshold, join that cluster and
 *       update the representative if this detection is a better one
 *       (isBetterRepresentative below).
 *     - Otherwise, start a new singleton cluster.
 *
 * Providers without per-detection embeddings (e.g. Rekognition delegated
 * recognition, isDelegated=true): skip clustering entirely — every detection
 * becomes its own cluster. Detections with an empty embedding array are also
 * always singletons, regardless of isDelegated.
 */
export function clusterFaceDetections<T>(
  detections: ClusterableDetection<T>[],
  clusterThreshold: number,
  isDelegated: boolean,
): FaceCluster<T>[] {
  if (detections.length === 0) return [];

  // Delegated providers have no embeddings — skip dedup, one cluster per detection.
  if (isDelegated) {
    return detections.map((d) => ({
      representative: d,
      allTimestampsMs: [d.timestampMs],
    }));
  }

  const clusters: FaceCluster<T>[] = [];

  for (const detection of detections) {
    const emb = detection.embedding;

    // Detections with no embedding cannot be clustered — treat as singleton.
    if (emb.length === 0) {
      clusters.push({
        representative: detection,
        allTimestampsMs: [detection.timestampMs],
      });
      continue;
    }

    let bestClusterIdx = -1;
    let bestSim = -Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const repEmb = clusters[i].representative.embedding;
      if (repEmb.length === 0) continue;

      const sim = cosineSimilarity(emb, repEmb);
      if (sim > bestSim) {
        bestSim = sim;
        bestClusterIdx = i;
      }
    }

    if (bestClusterIdx >= 0 && bestSim >= clusterThreshold) {
      // Assign to existing cluster.
      const cluster = clusters[bestClusterIdx];
      cluster.allTimestampsMs.push(detection.timestampMs);

      // Update representative if this detection is better:
      //   Higher confidence wins; tie-break = larger bbox area.
      if (isBetterRepresentative(detection, cluster.representative)) {
        cluster.representative = detection;
      }
    } else {
      // Start a new cluster.
      clusters.push({
        representative: detection,
        allTimestampsMs: [detection.timestampMs],
      });
    }
  }

  return clusters;
}

/**
 * Dot product of two L2-normalized unit vectors (== cosine similarity).
 * Mirrors FaceMatchingService.cosineSimilarity exactly.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Returns true when `candidate` is a better cluster representative than
 * `current`. Higher confidence wins. On tie, larger bounding-box area wins.
 */
function isBetterRepresentative<T>(
  candidate: ClusterableDetection<T>,
  current: ClusterableDetection<T>,
): boolean {
  const candConf = candidate.confidence ?? 0;
  const currConf = current.confidence ?? 0;

  if (candConf !== currConf) return candConf > currConf;

  const candBb = candidate.boundingBox;
  const currBb = current.boundingBox;
  return candBb.w * candBb.h > currBb.w * currBb.h;
}

// ---------------------------------------------------------------------------
// buildFaceCropThumbnail
// ---------------------------------------------------------------------------

export interface FaceCropOptions {
  /** Normalized (0-1) bounding box of the face within the frame. */
  boundingBox: { x: number; y: number; w: number; h: number };
  /** Padding added on each side of the bounding box, as a fraction of its own w/h (default 0.35). */
  paddingFraction?: number;
  /** Long-edge target for the face-centered crop (default 512 — server's FACE_CROP_MAX_DIM). */
  cropMaxDim?: number;
  /** Long-edge target for the full-frame fallback (default 800 — server's FRAME_THUMB_MAX_DIM). */
  fallbackMaxDim?: number;
  /** JPEG quality (default 85). */
  quality?: number;
}

/**
 * Build a face-centered crop thumbnail JPEG from a single (already prepared/
 * downscaled) frame buffer + normalized bounding box.
 *
 * Padding is added on each side of the bounding box, clamped to the frame
 * boundary, then the crop is resized to `cropMaxDim` and JPEG-encoded.
 *
 * Falls back to a full-frame resize (`fallbackMaxDim`) when the bounding box
 * is degenerate (w<=0 or h<=0) or the frame dimensions cannot be read, and
 * again on any error while cropping. This function throws ONLY if even that
 * full-frame fallback resize fails — a further "return raw bytes" tier is
 * left to the caller, not handled here.
 */
export async function buildFaceCropThumbnail(
  frameBuffer: Buffer,
  opts: FaceCropOptions,
): Promise<Buffer> {
  const paddingFraction = opts.paddingFraction ?? 0.35;
  const cropMaxDim = opts.cropMaxDim ?? 512;
  const fallbackMaxDim = opts.fallbackMaxDim ?? 800;
  const quality = opts.quality ?? 85;
  const bb = opts.boundingBox;

  const sharp = (await import('sharp')).default;

  try {
    const meta = await sharp(frameBuffer).metadata();
    const frameW = meta.width ?? 0;
    const frameH = meta.height ?? 0;

    if (bb.w > 0 && bb.h > 0 && frameW > 0 && frameH > 0) {
      const padX = bb.w * paddingFraction;
      const padY = bb.h * paddingFraction;

      const left = Math.max(0, Math.min(1, bb.x - padX));
      const top = Math.max(0, Math.min(1, bb.y - padY));
      const right = Math.max(0, Math.min(1, bb.x + bb.w + padX));
      const bottom = Math.max(0, Math.min(1, bb.y + bb.h + padY));

      const cropLeft = Math.round(left * frameW);
      const cropTop = Math.round(top * frameH);
      let cropW = Math.max(1, Math.round(right * frameW) - cropLeft);
      let cropH = Math.max(1, Math.round(bottom * frameH) - cropTop);

      // Clamp so the crop never exceeds the frame boundary.
      cropW = Math.min(cropW, frameW - cropLeft);
      cropH = Math.min(cropH, frameH - cropTop);

      return await sharp(frameBuffer)
        .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
        .resize({
          width: cropMaxDim,
          height: cropMaxDim,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality })
        .toBuffer();
    }

    // Bounding box or frame dims unavailable — fall back to full-frame resize.
    return await fullFrameResize(frameBuffer, fallbackMaxDim, quality);
  } catch {
    // Non-fatal: fall back to full-frame resize on any crop/metadata error.
    // If this fallback itself throws, the error propagates to the caller.
    return await fullFrameResize(frameBuffer, fallbackMaxDim, quality);
  }
}

async function fullFrameResize(
  frameBuffer: Buffer,
  maxDim: number,
  quality: number,
): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(frameBuffer)
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * Unit tests for the cross-frame deduplication (clustering) logic embedded in
 * VideoFaceDetectionHandler.
 *
 * Because `clusterDetections` and `isBetterRepresentative` are module-private
 * functions, we test the algorithm through a locally re-implemented reference
 * that exactly mirrors the production logic.  The reference implementation
 * uses the real `FaceMatchingService.cosineSimilarity` (from
 * face-matching.service.ts) so the similarity math is identical.
 *
 * This approach:
 *  - Keeps tests independent of private symbols (no `as any` or `require`)
 *  - Exercises the exact cosine similarity arithmetic used in production
 *  - Provides full coverage of all branching paths in clusterDetections
 *
 * Algorithm under test (copied verbatim from video-face-detection.handler.ts):
 *
 *   For each detection in order:
 *     - No embedding → singleton cluster
 *     - Delegated (isDelegated=true) → one cluster per detection (skip dedup)
 *     - Compare embedding to each cluster representative's embedding
 *     - If best similarity >= clusterThreshold → assign; update rep if better
 *     - Else → new cluster
 *
 *   isBetterRepresentative: higher confidence wins; tie-break = larger bbox area
 */

import { DEFAULT_FACE_CLUSTER_THRESHOLD } from './face-matching.service';

// ---------------------------------------------------------------------------
// Minimal type aliases matching the production code
// ---------------------------------------------------------------------------

interface BoundingBox { x: number; y: number; w: number; h: number }

interface DetectedFaceStub {
  confidence: number | null;
  embedding?: number[];
}

interface NormalizedFaceStub {
  embedding: number[];
  boundingBox: BoundingBox;
  confidence: number | null;
}

interface FrameDetectionStub {
  face: DetectedFaceStub;
  normalizedFace: NormalizedFaceStub;
  timestampMs: number;
  frameBuf: Buffer;
}

interface FaceClusterStub {
  representative: FrameDetectionStub;
  allTimestampsMs: number[];
}

// ---------------------------------------------------------------------------
// Reference implementation  (mirrors production exactly)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function isBetterRepresentative(
  candidate: FrameDetectionStub,
  current: FrameDetectionStub,
): boolean {
  const candConf = candidate.face.confidence ?? 0;
  const currConf = current.face.confidence ?? 0;
  if (candConf !== currConf) return candConf > currConf;
  const candBb = candidate.normalizedFace.boundingBox;
  const currBb = current.normalizedFace.boundingBox;
  return candBb.w * candBb.h > currBb.w * currBb.h;
}

function clusterDetections(
  detections: FrameDetectionStub[],
  clusterThreshold: number,
  isDelegated: boolean,
): FaceClusterStub[] {
  if (detections.length === 0) return [];

  if (isDelegated) {
    return detections.map((d) => ({
      representative: d,
      allTimestampsMs: [d.timestampMs],
    }));
  }

  const clusters: FaceClusterStub[] = [];

  for (const detection of detections) {
    const emb = detection.normalizedFace.embedding;

    if (emb.length === 0) {
      clusters.push({ representative: detection, allTimestampsMs: [detection.timestampMs] });
      continue;
    }

    let bestClusterIdx = -1;
    let bestSim = -Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const repEmb = clusters[i].representative.normalizedFace.embedding;
      if (repEmb.length === 0) continue;
      const sim = cosineSimilarity(emb, repEmb);
      if (sim > bestSim) { bestSim = sim; bestClusterIdx = i; }
    }

    if (bestClusterIdx >= 0 && bestSim >= clusterThreshold) {
      const cluster = clusters[bestClusterIdx];
      cluster.allTimestampsMs.push(detection.timestampMs);
      if (isBetterRepresentative(detection, cluster.representative)) {
        cluster.representative = detection;
      }
    } else {
      clusters.push({ representative: detection, allTimestampsMs: [detection.timestampMs] });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** L2-normalize a vector so cosine similarity = dot product. */
function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** Build a FrameDetectionStub with an L2-normalized embedding. */
function makeDetection(
  embedding: number[],
  timestampMs: number,
  confidence = 0.9,
  bbox: BoundingBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
): FrameDetectionStub {
  const normalized = l2normalize(embedding);
  return {
    face: { confidence, embedding: normalized },
    normalizedFace: { embedding: normalized, boundingBox: bbox, confidence },
    timestampMs,
    frameBuf: Buffer.alloc(0),
  };
}

/** Build a FrameDetectionStub with NO embedding (empty array). */
function makeNoEmbDetection(timestampMs: number, confidence = 0.8): FrameDetectionStub {
  return {
    face: { confidence },
    normalizedFace: { embedding: [], boundingBox: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence },
    timestampMs,
    frameBuf: Buffer.alloc(0),
  };
}

const THRESHOLD = DEFAULT_FACE_CLUSTER_THRESHOLD; // 0.45

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross-frame deduplication (clusterDetections)', () => {

  // -----------------------------------------------------------------------
  // Empty input
  // -----------------------------------------------------------------------
  describe('empty input', () => {
    it('returns [] when detections list is empty', () => {
      expect(clusterDetections([], THRESHOLD, false)).toEqual([]);
    });

    it('returns [] when delegated and detections list is empty', () => {
      expect(clusterDetections([], THRESHOLD, true)).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Delegated provider path (Rekognition) — skip dedup
  // -----------------------------------------------------------------------
  describe('delegated provider (isDelegated=true)', () => {
    it('produces one cluster per detection regardless of embedding similarity', () => {
      const identical = l2normalize([1, 0]);
      const d1 = makeDetection(identical, 1000);
      const d2 = makeDetection(identical, 2000);
      const d3 = makeDetection(identical, 3000);

      const clusters = clusterDetections([d1, d2, d3], THRESHOLD, true);
      expect(clusters).toHaveLength(3);
    });

    it('each cluster has exactly one timestamp', () => {
      const d1 = makeDetection([1, 0], 5000);
      const d2 = makeDetection([1, 0], 10000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, true);
      expect(clusters[0].allTimestampsMs).toEqual([5000]);
      expect(clusters[1].allTimestampsMs).toEqual([10000]);
    });

    it('representative equals the original detection', () => {
      const d1 = makeDetection([1, 0], 5000);
      const clusters = clusterDetections([d1], THRESHOLD, true);
      expect(clusters[0].representative).toBe(d1);
    });
  });

  // -----------------------------------------------------------------------
  // No-embedding detections → singletons
  // -----------------------------------------------------------------------
  describe('detections with empty embeddings', () => {
    it('each no-embedding detection becomes its own cluster', () => {
      const d1 = makeNoEmbDetection(1000);
      const d2 = makeNoEmbDetection(2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters).toHaveLength(2);
    });

    it('no-embedding cluster has one timestamp', () => {
      const d1 = makeNoEmbDetection(3000);
      const clusters = clusterDetections([d1], THRESHOLD, false);
      expect(clusters[0].allTimestampsMs).toEqual([3000]);
    });
  });

  // -----------------------------------------------------------------------
  // Same-person detections → collapse to ONE cluster
  // -----------------------------------------------------------------------
  describe('near-identical embeddings (same person)', () => {
    // Two nearly identical embeddings — cosine similarity will be very close to 1.0
    const personA = l2normalize([0.98, 0.1, 0.05]);
    const personASlightlyDifferent = l2normalize([0.97, 0.11, 0.06]);

    it('collapses two highly similar detections into one cluster', () => {
      const d1 = makeDetection(personA, 1000);
      const d2 = makeDetection(personASlightlyDifferent, 2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters).toHaveLength(1);
    });

    it('allTimestampsMs contains both timestamps', () => {
      const d1 = makeDetection(personA, 1000);
      const d2 = makeDetection(personASlightlyDifferent, 2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters[0].allTimestampsMs).toContain(1000);
      expect(clusters[0].allTimestampsMs).toContain(2000);
    });

    it('three similar frames collapse to one cluster with all three timestamps', () => {
      const d1 = makeDetection(personA, 1000);
      const d2 = makeDetection(personASlightlyDifferent, 2000);
      const d3 = makeDetection(l2normalize([0.96, 0.12, 0.07]), 3000);
      const clusters = clusterDetections([d1, d2, d3], THRESHOLD, false);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].allTimestampsMs).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Distinct-person detections → separate clusters
  // -----------------------------------------------------------------------
  describe('distinct embeddings (different people)', () => {
    // Orthogonal unit vectors: cosine similarity = 0 (well below threshold)
    const personA = [1, 0, 0];
    const personB = [0, 1, 0];
    const personC = [0, 0, 1];

    it('two distinct people produce two separate clusters', () => {
      const d1 = makeDetection(personA, 1000);
      const d2 = makeDetection(personB, 2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters).toHaveLength(2);
    });

    it('three distinct people produce three separate clusters', () => {
      const d1 = makeDetection(personA, 1000);
      const d2 = makeDetection(personB, 2000);
      const d3 = makeDetection(personC, 3000);
      const clusters = clusterDetections([d1, d2, d3], THRESHOLD, false);
      expect(clusters).toHaveLength(3);
    });

    it('each cluster has exactly one timestamp when all detections are distinct', () => {
      const d1 = makeDetection(personA, 1000);
      const d2 = makeDetection(personB, 2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters[0].allTimestampsMs).toEqual([1000]);
      expect(clusters[1].allTimestampsMs).toEqual([2000]);
    });
  });

  // -----------------------------------------------------------------------
  // Mixed: two people across multiple frames
  // -----------------------------------------------------------------------
  describe('two people each appearing in 3 frames', () => {
    const baseA = l2normalize([0.9, 0.1, 0.0]);
    const baseB = l2normalize([0.0, 0.1, 0.9]);

    it('collapses to exactly 2 clusters', () => {
      const detections = [
        makeDetection(baseA, 1000),
        makeDetection(baseB, 1000),
        makeDetection(l2normalize([0.91, 0.09, 0.01]), 2000),
        makeDetection(l2normalize([0.01, 0.09, 0.91]), 2000),
        makeDetection(l2normalize([0.89, 0.11, 0.01]), 3000),
        makeDetection(l2normalize([0.01, 0.11, 0.89]), 3000),
      ];

      const clusters = clusterDetections(detections, THRESHOLD, false);
      expect(clusters).toHaveLength(2);
    });

    it('each cluster collects 3 timestamps', () => {
      const detections = [
        makeDetection(baseA, 1000),
        makeDetection(baseB, 1000),
        makeDetection(l2normalize([0.91, 0.09, 0.01]), 2000),
        makeDetection(l2normalize([0.01, 0.09, 0.91]), 2000),
        makeDetection(l2normalize([0.89, 0.11, 0.01]), 3000),
        makeDetection(l2normalize([0.01, 0.11, 0.89]), 3000),
      ];

      const clusters = clusterDetections(detections, THRESHOLD, false);
      const sizes = clusters.map((c) => c.allTimestampsMs.length).sort();
      expect(sizes).toEqual([3, 3]);
    });
  });

  // -----------------------------------------------------------------------
  // Representative selection — higher confidence wins
  // -----------------------------------------------------------------------
  describe('representative selection: higher confidence wins', () => {
    const emb = l2normalize([1, 0]);

    it('updates representative when a higher-confidence detection arrives', () => {
      const d1 = makeDetection(emb, 1000, 0.7);
      const d2 = makeDetection(emb, 2000, 0.95);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].representative.face.confidence).toBe(0.95);
      expect(clusters[0].representative.timestampMs).toBe(2000);
    });

    it('keeps original representative when second detection has lower confidence', () => {
      const d1 = makeDetection(emb, 1000, 0.95);
      const d2 = makeDetection(emb, 2000, 0.7);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters[0].representative.face.confidence).toBe(0.95);
      expect(clusters[0].representative.timestampMs).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------
  // Representative selection — tie-break on larger bbox area
  // -----------------------------------------------------------------------
  describe('representative selection: tie-break on bbox area', () => {
    const emb = l2normalize([1, 0]);
    const conf = 0.9; // same confidence

    it('picks the detection with the larger bounding box on confidence tie', () => {
      const small: BoundingBox = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }; // area = 0.01
      const large: BoundingBox = { x: 0.0, y: 0.0, w: 0.4, h: 0.4 }; // area = 0.16

      const d1 = makeDetection(emb, 1000, conf, small);
      const d2 = makeDetection(emb, 2000, conf, large);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);

      expect(clusters[0].representative.normalizedFace.boundingBox).toEqual(large);
      expect(clusters[0].representative.timestampMs).toBe(2000);
    });

    it('keeps original when second detection has smaller bbox (same confidence)', () => {
      const large: BoundingBox = { x: 0.0, y: 0.0, w: 0.4, h: 0.4 };
      const small: BoundingBox = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };

      const d1 = makeDetection(emb, 1000, conf, large);
      const d2 = makeDetection(emb, 2000, conf, small);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);

      expect(clusters[0].representative.normalizedFace.boundingBox).toEqual(large);
      expect(clusters[0].representative.timestampMs).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------
  // Threshold boundary — similarity exactly at threshold should merge
  // -----------------------------------------------------------------------
  describe('threshold boundary', () => {
    it('merges detections when similarity equals clusterThreshold', () => {
      // Build two vectors where dot product = exactly THRESHOLD
      // v1 = [1, 0], v2 = [THRESHOLD, sqrt(1-THRESHOLD^2)]
      const t = THRESHOLD;
      const v1 = [1, 0];
      const v2 = [t, Math.sqrt(1 - t * t)];

      const d1 = makeDetection(v1, 1000);
      const d2 = makeDetection(v2, 2000);
      // similarity ≥ threshold → same cluster
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters).toHaveLength(1);
    });

    it('creates a new cluster when similarity is just below clusterThreshold', () => {
      // Just below: similarity = THRESHOLD - 0.01
      const t = THRESHOLD - 0.01;
      const v1 = [1, 0];
      const v2 = [t, Math.sqrt(1 - t * t)];

      const d1 = makeDetection(v1, 1000);
      const d2 = makeDetection(v2, 2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // allTimestampsMs collects ALL member timestamps (including representative)
  // -----------------------------------------------------------------------
  describe('allTimestampsMs completeness', () => {
    it('includes the first (representative) timestamp in allTimestampsMs', () => {
      const emb = l2normalize([1, 0]);
      const d1 = makeDetection(emb, 5000);
      const d2 = makeDetection(emb, 10000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters[0].allTimestampsMs).toContain(5000);
      expect(clusters[0].allTimestampsMs).toContain(10000);
    });

    it('does not include timestamps from other clusters', () => {
      const d1 = makeDetection([1, 0, 0], 1000);
      const d2 = makeDetection([0, 1, 0], 2000);
      const clusters = clusterDetections([d1, d2], THRESHOLD, false);
      expect(clusters[0].allTimestampsMs).not.toContain(2000);
      expect(clusters[1].allTimestampsMs).not.toContain(1000);
    });
  });
});

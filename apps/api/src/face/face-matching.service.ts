// =============================================================================
// FaceMatchingService
// =============================================================================
//
// Provides in-app cosine similarity matching between a detected face embedding
// and existing Person centroids in a circle.
//
// Threshold conventions (ArcFace on LFW benchmark):
//   - Same-person pairs typically score > 0.40 cosine similarity.
//   - DEFAULT_FACE_MATCH_THRESHOLD = 0.38 is the recognition threshold: faces
//     scoring at or above this value are assigned to the best-matching Person.
//     At L2-unit-vector scale, 0.38 corresponds to ~67.6° angular distance.
//   - DEFAULT_FACE_CLUSTER_THRESHOLD = 0.45 is the clustering threshold used
//     when grouping unknown faces into provisional Person clusters. It is
//     intentionally stricter to reduce false merges during automated grouping.
//   - DEFAULT_FACE_CLUSTER_MIN_SIZE = 2 means singleton unknown faces remain
//     unassigned (personId = null). At least 2 faces must cluster together to
//     justify creating a new Person record.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_FACE_CLUSTER_THRESHOLD,
  DEFAULT_FACE_ARCHIVE_MATCH_THRESHOLD,
  bestMatchAgainstSet,
} from '@memoriahub/enrichment-compute/face-video';
import { PrismaService } from '../prisma/prisma.service';

/** Recognition threshold (match incoming face → existing Person centroid). */
export const DEFAULT_FACE_MATCH_THRESHOLD = 0.38;

/**
 * Clustering threshold for unknown faces.
 * Stricter than FACE_MATCH_THRESHOLD to reduce false merges when grouping
 * faces that have not yet been identified.
 *
 * Canonical definition now lives in @memoriahub/enrichment-compute/face-video
 * (imported above and re-exported here) so the shared clustering algorithm
 * and this server-side threshold can never drift apart; re-exported under
 * its original name so existing importers (e.g. video-face-dedup.spec.ts)
 * keep working unchanged.
 */
export { DEFAULT_FACE_CLUSTER_THRESHOLD };

/**
 * Recognition threshold for matching a face against the archived
 * (hidden, unassigned) face pool.
 *
 * Canonical definition lives in @memoriahub/enrichment-compute/face-video
 * (imported above and re-exported here) so the shared archive-matching helper
 * and this server-side threshold can never drift apart; re-exported under its
 * original name so importers can reference it without reaching into the
 * shared package directly, mirroring DEFAULT_FACE_CLUSTER_THRESHOLD above.
 */
export { DEFAULT_FACE_ARCHIVE_MATCH_THRESHOLD };

/**
 * Minimum cluster size to justify creating a provisional Person.
 * Singletons remain with personId = null.
 */
export const DEFAULT_FACE_CLUSTER_MIN_SIZE = 2;

@Injectable()
export class FaceMatchingService {
  private readonly logger = new Logger(FaceMatchingService.name);

  /** Cosine similarity threshold for assigning a face to an existing Person. */
  readonly matchThreshold: number;

  /** Cosine similarity threshold for clustering unknown faces. */
  readonly clusterThreshold: number;

  /** Minimum cluster size to create a provisional Person. */
  readonly clusterMinSize: number;

  /** Cosine similarity threshold for matching a face against the archived pool. */
  readonly archiveMatchThreshold: number;

  /** Max archived faces to load per archive-match query (bounds memory/scan). */
  readonly archiveMaxCandidates: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.matchThreshold = parseFloat(
      this.config.get<string>('FACE_MATCH_THRESHOLD') ??
        String(DEFAULT_FACE_MATCH_THRESHOLD),
    );
    this.clusterThreshold = parseFloat(
      this.config.get<string>('FACE_CLUSTER_THRESHOLD') ??
        String(DEFAULT_FACE_CLUSTER_THRESHOLD),
    );
    this.clusterMinSize = parseInt(
      this.config.get<string>('FACE_CLUSTER_MIN_SIZE') ??
        String(DEFAULT_FACE_CLUSTER_MIN_SIZE),
      10,
    );
    this.archiveMatchThreshold = parseFloat(
      this.config.get<string>('FACE_ARCHIVE_MATCH_THRESHOLD') ??
        String(DEFAULT_FACE_ARCHIVE_MATCH_THRESHOLD),
    );
    this.archiveMaxCandidates = parseInt(
      this.config.get<string>('FACE_ARCHIVE_MAX_CANDIDATES') ?? '5000',
      10,
    );
  }

  // ---------------------------------------------------------------------------
  // cosineSimilarity
  // ---------------------------------------------------------------------------

  /**
   * Dot product of two L2-normalized unit vectors.
   *
   * Because embeddings are L2-normalized at detection time this equals the
   * cosine similarity without re-normalizing. O(n) where n = embedding length.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  // ---------------------------------------------------------------------------
  // computePersonCentroid
  // ---------------------------------------------------------------------------

  /**
   * Compute the L2-normalized centroid of all face embeddings for a Person.
   *
   * Justification for on-demand computation (no cached DB column):
   *   At Phase 3 scale (hundreds of persons per circle, each with a few faces)
   *   loading centroids on-demand is cheap — each centroid reads a handful of
   *   embedding arrays. A cached column would require a migration and careful
   *   invalidation on every face assignment/unassignment. We defer the
   *   optimization to Phase 4 or when profiling identifies it as a bottleneck.
   *
   * Returns [] if the Person has no faces with non-empty embeddings.
   */
  async computePersonCentroid(personId: string): Promise<number[]> {
    const faces = await this.prisma.face.findMany({
      where: { personId },
      select: { embedding: true },
    });

    const embeddings = faces
      .map((f) => f.embedding)
      .filter((e) => e && e.length > 0);

    if (embeddings.length === 0) return [];

    const dim = embeddings[0].length;
    const sum = new Array<number>(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        sum[i] += emb[i];
      }
    }

    // Element-wise mean
    for (let i = 0; i < dim; i++) {
      sum[i] /= embeddings.length;
    }

    // L2-normalize the mean
    return l2NormalizeVec(sum);
  }

  // ---------------------------------------------------------------------------
  // matchFaceToPerson
  // ---------------------------------------------------------------------------

  /**
   * Compare an embedding against all active Person centroids in a circle and
   * return the best match if similarity >= matchThreshold.
   *
   * Active persons: deletedAt IS NULL AND mergedIntoId IS NULL.
   *
   * pgvector seam: when FACE_VECTOR_BACKEND=pgvector, a single SQL query using
   * the <=> operator would be more efficient. For now we fall through to the
   * in-app cosine path regardless of the setting.
   */
  async matchFaceToPerson(
    circleId: string,
    embedding: number[],
  ): Promise<{ personId: string; similarity: number } | null> {
    const vectorBackend = this.config.get<string>('FACE_VECTOR_BACKEND') ?? 'app';

    if (vectorBackend === 'pgvector') {
      // TODO(pgvector): Replace with a single SQL query using <=> operator when
      // FACE_VECTOR_BACKEND=pgvector. For now, fall through to in-app cosine.
      this.logger.debug('FACE_VECTOR_BACKEND=pgvector requested; falling through to in-app cosine');
    }

    // Load all active (non-deleted, non-merged-away) persons for the circle
    const persons = await this.prisma.person.findMany({
      where: {
        circleId,
        deletedAt: null,
        mergedIntoId: null,
      },
      select: { id: true },
    });

    if (persons.length === 0) return null;

    let bestPersonId: string | null = null;
    let bestSimilarity = -Infinity;

    for (const person of persons) {
      const centroid = await this.computePersonCentroid(person.id);
      if (centroid.length === 0) continue;

      const similarity = this.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestPersonId = person.id;
      }
    }

    if (bestPersonId !== null && bestSimilarity >= this.matchThreshold) {
      return { personId: bestPersonId, similarity: bestSimilarity };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // matchFaceByExternalId
  // ---------------------------------------------------------------------------

  /**
   * Delegated-recognition path (e.g. AWS Rekognition).
   *
   * Rekognition does not return embeddings; instead it assigns an externalFaceId
   * when a face is indexed into a collection. This method looks up whether any
   * existing face in the circle — belonging to an active (non-deleted,
   * non-merged-away) Person — has the same externalFaceId.
   *
   * Limitation: clustering of unknown faces is not possible on the delegated
   * path because no embedding vector is available.
   */
  async matchFaceByExternalId(
    circleId: string,
    externalFaceId: string,
  ): Promise<{ personId: string } | null> {
    const face = await this.prisma.face.findFirst({
      where: {
        circleId,
        externalFaceId,
        personId: { not: null },
        person: {
          deletedAt: null,
          mergedIntoId: null,
        },
      },
      select: { personId: true },
    });

    if (!face?.personId) return null;
    return { personId: face.personId };
  }

  // ---------------------------------------------------------------------------
  // matchFaceToArchived
  // ---------------------------------------------------------------------------

  /**
   * Compare an embedding against the circle's archived (hidden, unassigned)
   * face pool and return the best match if similarity >= threshold.
   *
   * Archived unassigned face: personId IS NULL AND hiddenAt IS NOT NULL.
   * These are faces a user deliberately hid from the unassigned-faces review
   * queue; a fresh detection that closely matches one is a signal the user
   * would likely want it archived too.
   *
   * Read-only — this method performs no writes. Candidates may be supplied by
   * the caller (opts.candidates) to avoid a redundant DB round-trip when a
   * reference set has already been loaded; otherwise the archived set is
   * queried here, capped at archiveMaxCandidates and ordered most-recently-
   * hidden first so the freshest archive decisions dominate a truncated scan.
   *
   * pgvector seam: when FACE_VECTOR_BACKEND=pgvector, a single KNN SQL query
   * using the <=> operator would be more efficient. For now we fall through to
   * the in-app cosine path (via bestMatchAgainstSet) regardless of the setting.
   */
  async matchFaceToArchived(
    circleId: string,
    embedding: number[],
    opts?: {
      threshold?: number;
      candidates?: Array<{ id: string; embedding: number[] }>;
    },
  ): Promise<{ faceId: string; similarity: number } | null> {
    if (!embedding || embedding.length === 0) return null;

    const vectorBackend = this.config.get<string>('FACE_VECTOR_BACKEND') ?? 'app';
    if (vectorBackend === 'pgvector') {
      // TODO(pgvector): Replace with a single KNN SQL query using <=> operator
      // when FACE_VECTOR_BACKEND=pgvector. For now, fall through to in-app cosine.
      this.logger.debug(
        'FACE_VECTOR_BACKEND=pgvector requested; falling through to in-app cosine',
      );
    }

    const candidates =
      opts?.candidates ??
      (await this.prisma.face.findMany({
        where: {
          circleId,
          personId: null,
          hiddenAt: { not: null },
          // isEmpty is a supported FloatNullableListFilter key in this Prisma
          // version (7.x), so we filter out empty-embedding rows in the query
          // rather than post-fetch in JS.
          embedding: { isEmpty: false },
        },
        select: { id: true, embedding: true },
        orderBy: { hiddenAt: 'desc' },
        take: this.archiveMaxCandidates,
      }));

    if (candidates.length === 0) return null;

    const threshold = opts?.threshold ?? this.archiveMatchThreshold;
    const best = bestMatchAgainstSet(embedding, candidates);
    if (best && best.similarity >= threshold) {
      return { faceId: best.id, similarity: best.similarity };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // findLiveMatchesAgainstArchived
  // ---------------------------------------------------------------------------

  /**
   * Given the circle's archived (hidden, unassigned) face pool as a reference
   * set, return the ids of LIVE unassigned faces that match any archived
   * reference at/above threshold.
   *
   * This is the inverse direction of matchFaceToArchived: instead of testing a
   * single incoming embedding against the archive, it scans the live unassigned
   * pool for faces resembling something the user already chose to archive —
   * candidates for auto-archiving. Read-only; performs no writes.
   *
   * Both sides may be supplied by the caller (opts.archivedCandidates /
   * opts.liveBatch) to reuse already-loaded sets and control batching; otherwise
   * each side is queried here. Only id + embedding are selected to keep memory
   * bounded, and empty-embedding rows are excluded via the same isEmpty filter.
   */
  async findLiveMatchesAgainstArchived(
    circleId: string,
    opts?: {
      threshold?: number;
      archivedCandidates?: Array<{ id: string; embedding: number[] }>;
      liveBatch?: Array<{ id: string; embedding: number[] }>;
      maxCandidates?: number;
    },
  ): Promise<string[]> {
    const archivedSet =
      opts?.archivedCandidates ??
      (await this.prisma.face.findMany({
        where: {
          circleId,
          personId: null,
          hiddenAt: { not: null },
          embedding: { isEmpty: false },
        },
        select: { id: true, embedding: true },
        orderBy: { hiddenAt: 'desc' },
        take: opts?.maxCandidates ?? this.archiveMaxCandidates,
      }));

    if (archivedSet.length === 0) return [];

    const liveTargets =
      opts?.liveBatch ??
      (await this.prisma.face.findMany({
        where: {
          circleId,
          personId: null,
          hiddenAt: null,
          embedding: { isEmpty: false },
        },
        select: { id: true, embedding: true },
      }));

    const threshold = opts?.threshold ?? this.archiveMatchThreshold;
    const matchedIds: string[] = [];

    for (const live of liveTargets) {
      if (!live.embedding || live.embedding.length === 0) continue;
      const best = bestMatchAgainstSet(live.embedding, archivedSet);
      if (best && best.similarity >= threshold) {
        matchedIds.push(live.id);
      }
    }

    return matchedIds;
  }
}

// ---------------------------------------------------------------------------
// Local helper (not exported — matching service uses normalized embeddings)
// ---------------------------------------------------------------------------

function l2NormalizeVec(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

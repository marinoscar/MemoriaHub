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
import { PrismaService } from '../prisma/prisma.service';

/** Recognition threshold (match incoming face → existing Person centroid). */
export const DEFAULT_FACE_MATCH_THRESHOLD = 0.38;

/**
 * Clustering threshold for unknown faces.
 * Stricter than FACE_MATCH_THRESHOLD to reduce false merges when grouping
 * faces that have not yet been identified.
 */
export const DEFAULT_FACE_CLUSTER_THRESHOLD = 0.45;

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
}

// ---------------------------------------------------------------------------
// Local helper (not exported — matching service uses normalized embeddings)
// ---------------------------------------------------------------------------

function l2NormalizeVec(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

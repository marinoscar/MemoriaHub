// =============================================================================
// FaceMatchingService
// =============================================================================
//
// Matches a detected face embedding against existing Person centroids and the
// archived-face pool in a circle.
//
// Two matching backends, selected by FACE_VECTOR_BACKEND (default
// DEFAULT_FACE_VECTOR_BACKEND, see below):
//   - 'pgvector': candidate selection is delegated to Postgres via a KNN query
//     on the `faces.embedding_vec` HNSW index (the `<=>` cosine-distance
//     operator). embedding_vec is a DERIVED column of dimension vector(128),
//     kept in sync with the float8 `embedding` array by the DB trigger
//     `faces_sync_embedding_vec` — application code (including this service and
//     Prisma) MUST NEVER write it directly; the trigger owns it. Because the
//     column is vector(128), the pgvector path is only ever taken when the
//     probe embedding is exactly 128-d (the `compreface` mobilenet provider);
//     see the dimension guard in each method below. A 1024-d ('human' WASM)
//     probe, or an empty embedding, would be dimensionally incompatible with
//     `$1::vector(128)` and is routed to the in-app cosine path instead.
//   - 'app': the original path — load candidates into the process and compute
//     cosine similarity in JS.
//
// KNN-candidate → centroid design (matchFaceToPerson): the pgvector KNN only
// SELECTS which persons are worth scoring (nearest float4 vectors); each
// candidate person's centroid is then computed SQL-side via
// `avg(embedding_vec)` (computePersonCentroidPgvector) — one aggregate row per
// person instead of loading every face row of the person into the process —
// and cached per-process for a short TTL. The accept/reject decision compares
// that centroid against matchThreshold with the exact same cosineSimilarity()
// used by the in-app path. Precision note: avg() over the float4 vector column
// differs from the float8 mean at ~1e-7/element — negligible vs
// FACE_MATCH_THRESHOLD 0.38; decision parity is preserved for practical
// purposes. Persons with no vector-eligible faces (legacy 'human'-only 1024-d
// embeddings) fall back to the float8 computePersonCentroid() path unchanged.
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

/**
 * Default vector matching backend when FACE_VECTOR_BACKEND is unset.
 * 'pgvector' delegates KNN candidate selection to the `faces.embedding_vec`
 * HNSW index; 'app' loads candidates and computes cosine similarity in-process.
 */
export const DEFAULT_FACE_VECTOR_BACKEND = 'pgvector';

/**
 * Number of nearest-neighbour rows fetched from the pgvector index before the
 * bounded centroid recompute (matchFaceToPerson) or nearest-archive pick
 * (matchFaceToArchived). Kept modest so the KNN LIMIT stays well under the
 * per-query hnsw.ef_search recall budget set in the same transaction.
 */
export const DEFAULT_FACE_MATCH_KNN_CANDIDATES = 40;

/**
 * hnsw.ef_search floor applied (via `SET LOCAL`) around every KNN query so
 * recall is not starved by pgvector's low default ef_search. Must be >= the
 * KNN LIMIT; when a caller configures a larger FACE_MATCH_KNN_CANDIDATES the
 * effective ef_search is raised to match (see the per-method Math.max).
 */
const HNSW_EF_SEARCH_FLOOR = 100;

/** The one embedding dimensionality mirrored into the vector(128) column. */
const PGVECTOR_EMBEDDING_DIM = 128;

/**
 * TTL for the per-process person-centroid cache used by the pgvector match
 * path. Cache invalidation: a 60s-stale centroid only marginally shifts a
 * fuzzy threshold decision; new-face assignments during a bulk run make
 * centroids MORE representative over time, not less — acceptable staleness.
 */
const CENTROID_CACHE_TTL_MS = 60_000;

/** Max centroid-cache entries before a wholesale clear (simple overflow guard). */
const CENTROID_CACHE_MAX_ENTRIES = 5000;

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

  /** KNN candidate count fetched from the pgvector index before centroid recompute. */
  readonly matchKnnCandidates: number;

  /**
   * Per-process TTL cache of person centroids, used ONLY by the pgvector match
   * path (matchFaceToPersonPgvector). See CENTROID_CACHE_TTL_MS for the
   * staleness rationale. Other computePersonCentroid callers (people merge,
   * clustering) keep the uncached method's exact semantics.
   */
  private readonly centroidCache = new Map<
    string,
    { centroid: number[]; expiresAt: number }
  >();

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
    this.matchKnnCandidates = parseInt(
      this.config.get<string>('FACE_MATCH_KNN_CANDIDATES') ??
        String(DEFAULT_FACE_MATCH_KNN_CANDIDATES),
      10,
    );
  }

  // ---------------------------------------------------------------------------
  // usesPgvectorFor
  // ---------------------------------------------------------------------------

  /**
   * True when a probe embedding would be routed through the pgvector KNN path:
   * the resolved backend is 'pgvector' AND the embedding is exactly 128-d
   * (the dimensionality mirrored into the vector(128) column). Exposed so
   * callers (face-detection-core's auto-archive branch) can decide whether a
   * per-probe indexed KNN beats preloading an in-app candidate set.
   */
  usesPgvectorFor(embedding: number[]): boolean {
    return (
      this.resolveVectorBackend() === 'pgvector' &&
      embedding.length === PGVECTOR_EMBEDDING_DIM
    );
  }

  /** Single source of truth for the FACE_VECTOR_BACKEND resolution. */
  private resolveVectorBackend(): string {
    return (
      this.config.get<string>('FACE_VECTOR_BACKEND') ?? DEFAULT_FACE_VECTOR_BACKEND
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
  // computePersonCentroidPgvector / centroid cache
  // ---------------------------------------------------------------------------

  /**
   * SQL-side centroid: `avg(embedding_vec)` over the person's vector-eligible
   * faces — one aggregate row instead of loading every embedding into the
   * process (computePersonCentroid is O(faces) rows per call and was the
   * dominant DB load of the pgvector match path during bulk imports).
   *
   * Precision note: avg() over the float4 vector column differs from the
   * float8 mean at ~1e-7/element — negligible vs FACE_MATCH_THRESHOLD 0.38;
   * decision parity is preserved for practical purposes.
   *
   * Falls back to the float8 computePersonCentroid() path when avg() returns
   * NULL (person has only non-128-d 'human' or empty embeddings, so no
   * embedding_vec rows exist) — behavior for legacy Human-only persons is
   * unchanged.
   */
  async computePersonCentroidPgvector(personId: string): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<
      { centroid: string | null; n: number }[]
    >`
      SELECT avg(embedding_vec)::text AS centroid, count(*)::int AS n
      FROM faces
      WHERE person_id = ${personId}::uuid
        AND embedding_vec IS NOT NULL
    `;

    const centroidText = rows?.[0]?.centroid;
    if (!centroidText) {
      // No vector-eligible faces: legacy float8 path.
      return this.computePersonCentroid(personId);
    }

    // pgvector text format: '[x,y,...]'
    const parsed = centroidText
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(Number);

    if (parsed.length === 0 || parsed.some((v) => !Number.isFinite(v))) {
      return this.computePersonCentroid(personId);
    }

    return l2NormalizeVec(parsed);
  }

  /**
   * TTL-cached centroid retrieval, used ONLY inside the pgvector match loop.
   * See CENTROID_CACHE_TTL_MS for the staleness rationale.
   */
  private async getPersonCentroidCached(personId: string): Promise<number[]> {
    const now = Date.now();
    const hit = this.centroidCache.get(personId);
    if (hit && hit.expiresAt > now) {
      return hit.centroid;
    }

    const centroid = await this.computePersonCentroidPgvector(personId);

    // Simple overflow guard: wholesale clear rather than LRU bookkeeping.
    if (this.centroidCache.size >= CENTROID_CACHE_MAX_ENTRIES) {
      this.centroidCache.clear();
    }
    this.centroidCache.set(personId, {
      centroid,
      expiresAt: now + CENTROID_CACHE_TTL_MS,
    });

    return centroid;
  }

  /**
   * Drop a person's cached centroid. Called by face-detection-core right after
   * it assigns a newly detected face to the person, so the next probe in the
   * same bulk run recomputes against the fresh face set.
   */
  invalidateCentroid(personId: string): void {
    this.centroidCache.delete(personId);
  }

  // ---------------------------------------------------------------------------
  // matchFaceToPerson
  // ---------------------------------------------------------------------------

  /**
   * Compare an embedding against active Person centroids in a circle and
   * return the best match if similarity >= matchThreshold.
   *
   * Active persons: deletedAt IS NULL AND mergedIntoId IS NULL.
   *
   * Backend selection (FACE_VECTOR_BACKEND, default DEFAULT_FACE_VECTOR_BACKEND):
   *   - 'pgvector' (128-d probes only): a KNN query on `faces.embedding_vec`
   *     (HNSW, `<=>` cosine distance), JOINed to active persons, selects the
   *     nearest candidate faces; their distinct person ids (nearest-first) are
   *     the only persons whose centroid is then recomputed. The accept/reject
   *     decision remains on the exact float8 centroid — cosineSimilarity() vs.
   *     matchThreshold — so the result is numerically identical to the in-app
   *     path; the vector column only accelerates candidate selection. See the
   *     KNN-candidate → centroid parity note in the class header.
   *   - 'app', OR any non-128-d probe (1024-d 'human', empty): the full in-app
   *     path below — score every active person's centroid in JS. The dimension
   *     guard is mandatory because a 1024-d probe against a vector(128) column
   *     would raise a dimensionality error.
   *
   * `embedding_vec` is a trigger-maintained (`faces_sync_embedding_vec`) derived
   * column; this method never writes it.
   */
  async matchFaceToPerson(
    circleId: string,
    embedding: number[],
  ): Promise<{ personId: string; similarity: number } | null> {
    if (this.usesPgvectorFor(embedding)) {
      return this.matchFaceToPersonPgvector(circleId, embedding);
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

  /**
   * pgvector implementation of matchFaceToPerson (KNN candidate selection →
   * bounded centroid recompute).
   *
   * Only invoked for 128-d probes (guarded by the caller). The KNN JOINs to
   * `people` so only active persons' faces are considered, and returns the
   * nearest candidate faces ordered by cosine distance; we collect the distinct
   * person ids in nearest-first order, then score each candidate against its
   * SQL-side avg(embedding_vec) centroid (TTL-cached — see
   * getPersonCentroidCached; precision/staleness rationale in the class
   * header) and keep the accept/reject decision on cosineSimilarity() vs.
   * matchThreshold, same comparison as the in-app path.
   *
   * `SET LOCAL hnsw.ef_search` only takes effect inside an explicit transaction,
   * so the SET and the SELECT are issued together via `$transaction([...])`
   * (they share one connection/transaction). The vector literal is numeric-only
   * (`[n,n,...]`) so there is no injection risk; ef_search is a computed integer.
   */
  private async matchFaceToPersonPgvector(
    circleId: string,
    embedding: number[],
  ): Promise<{ personId: string; similarity: number } | null> {
    const vectorLiteral = `[${embedding.join(',')}]`;
    const k = this.matchKnnCandidates;
    const efSearch = Math.max(HNSW_EF_SEARCH_FLOOR, k);

    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`),
      this.prisma.$queryRaw<{ person_id: string }[]>`
        SELECT f.person_id AS person_id
        FROM faces f
        JOIN people p
          ON p.id = f.person_id
         AND p.deleted_at IS NULL
         AND p.merged_into_id IS NULL
        WHERE f.circle_id = ${circleId}::uuid
          AND f.person_id IS NOT NULL
          AND f.embedding_vec IS NOT NULL
        ORDER BY f.embedding_vec <=> ${vectorLiteral}::vector
        LIMIT ${k}
      `,
    ]);

    // Distinct candidate person ids, preserving nearest-first ordering.
    const candidatePersonIds: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.person_id && !seen.has(row.person_id)) {
        seen.add(row.person_id);
        candidatePersonIds.push(row.person_id);
      }
    }

    if (candidatePersonIds.length === 0) return null;

    let bestPersonId: string | null = null;
    let bestSimilarity = -Infinity;

    for (const personId of candidatePersonIds) {
      const centroid = await this.getPersonCentroidCached(personId);
      if (centroid.length === 0) continue;

      const similarity = this.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestPersonId = personId;
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
   * Read-only — this method performs no writes.
   *
   * Backend selection (FACE_VECTOR_BACKEND, default DEFAULT_FACE_VECTOR_BACKEND):
   *   - opts.candidates supplied: ALWAYS the in-app path, regardless of backend.
   *     This is the in-loop reuse case (face-detection-core, on the app backend
   *     or for non-128-d probes, loads the archived reference set once and
   *     probes many faces against it), so a per-probe KNN round-trip would be
   *     strictly worse there. On the pgvector backend face-detection-core calls
   *     this method WITHOUT candidates so each probe is one indexed KNN.
   *   - 'pgvector' (128-d probes only): a KNN query on the PARTIAL archive HNSW
   *     index (`faces_embedding_vec_archive_hnsw_idx`, scoped to
   *     person_id IS NULL AND hidden_at IS NOT NULL) returns the nearest archived
   *     faces; the single nearest is accepted if its cosine similarity meets the
   *     threshold. The dimension guard is mandatory (vector(128) column).
   *   - 'app', OR a non-128-d probe: the in-app path below — load the archived
   *     pool (capped at archiveMaxCandidates, most-recently-hidden first) and
   *     scan in JS via bestMatchAgainstSet.
   *
   * `embedding_vec` is a trigger-maintained (`faces_sync_embedding_vec`) derived
   * column; this method never writes it.
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

    const threshold = opts?.threshold ?? this.archiveMatchThreshold;

    // Caller supplied a pre-loaded reference set: use it directly (in-loop reuse
    // in face-detection-core) — no KNN, regardless of backend.
    if (opts?.candidates) {
      if (opts.candidates.length === 0) return null;
      const best = bestMatchAgainstSet(embedding, opts.candidates);
      return best && best.similarity >= threshold
        ? { faceId: best.id, similarity: best.similarity }
        : null;
    }

    if (this.usesPgvectorFor(embedding)) {
      return this.matchFaceToArchivedPgvector(circleId, embedding, threshold);
    }

    // In-app fallback: query the archived pool and scan in JS.
    const candidates = await this.prisma.face.findMany({
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
    });

    if (candidates.length === 0) return null;

    const best = bestMatchAgainstSet(embedding, candidates);
    if (best && best.similarity >= threshold) {
      return { faceId: best.id, similarity: best.similarity };
    }

    return null;
  }

  /**
   * pgvector implementation of matchFaceToArchived. Only invoked for 128-d
   * probes (guarded by the caller). Runs a KNN against the partial archive HNSW
   * index and returns the single nearest archived face if it meets the
   * threshold. `SET LOCAL hnsw.ef_search` is transaction-scoped, so the SET and
   * the SELECT are issued together via `$transaction([...])`. The vector literal
   * is numeric-only and ef_search is a computed integer — no injection risk.
   */
  private async matchFaceToArchivedPgvector(
    circleId: string,
    embedding: number[],
    threshold: number,
  ): Promise<{ faceId: string; similarity: number } | null> {
    const vectorLiteral = `[${embedding.join(',')}]`;
    const k = this.matchKnnCandidates;
    const efSearch = Math.max(HNSW_EF_SEARCH_FLOOR, k);

    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`),
      this.prisma.$queryRaw<{ id: string; similarity: number }[]>`
        SELECT f.id AS id, 1 - (f.embedding_vec <=> ${vectorLiteral}::vector) AS similarity
        FROM faces f
        WHERE f.circle_id = ${circleId}::uuid
          AND f.person_id IS NULL
          AND f.hidden_at IS NOT NULL
          AND f.embedding_vec IS NOT NULL
        ORDER BY f.embedding_vec <=> ${vectorLiteral}::vector
        LIMIT ${k}
      `,
    ]);

    const nearest = rows[0];
    if (nearest && Number(nearest.similarity) >= threshold) {
      return { faceId: nearest.id, similarity: Number(nearest.similarity) };
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
   *
   * Backend note: this method deliberately stays on the in-app cosine path even
   * when FACE_VECTOR_BACKEND='pgvector'. It is used by the face-auto-archive
   * backfill/sweep (not the hot per-upload detection path), its archived
   * reference set is already bounded (archiveMaxCandidates) and loaded once, and
   * a pgvector rewrite would require either one KNN round-trip per live face or
   * a long-held interactive transaction wrapping `SET LOCAL hnsw.ef_search` — a
   * poor trade for a bounded, non-latency-critical sweep. The hot single-probe
   * paths (matchFaceToPerson / matchFaceToArchived) are where the index pays
   * off. (`embedding_vec` remains a trigger-maintained derived column either way;
   * nothing here writes it.)
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

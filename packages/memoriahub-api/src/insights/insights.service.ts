// =============================================================================
// Insights Service
// =============================================================================
//
// Computes and caches a global storage-metrics snapshot across all circles.
// Computation is driven by the platform job queue (StorageInsightsHandler, native since RETRO-C8) to
// provide retries, restart-survival, and visibility in the jobs dashboard.
// =============================================================================

import { Inject, Injectable, Logger } from '@nestjs/common';

import { MEMORIAHUB_JOBS, MEMORIAHUB_PRISMA, type MemoriahubJobsPort } from '../ports/index.js';
import type { InsightsDb } from './data/insights-db.js';

/**
 * The storage-metrics snapshot. Byte fields are strings (a BigInt never reaches JSON).
 *
 * @stability experimental
 */
export interface InsightsMetrics {
  totalBytes: string;   // BigInt serialised as string for JSON safety
  photoBytes: string;
  videoBytes: string;
  totalItems: number;
  photoCount: number;
  videoCount: number;
  totalFaces: number;
  taggedItems: number;
  /**
   * Stored bytes by provider and kind (RETRO-T3, #628): the source of the
   * `app.storage.bytes` gauge, which reads this snapshot rather than summing live.
   * `kind` is `thumbnail` for a `thumbnails/` object, else the owning item's type,
   * else `other`. Trashed items count here too (they still occupy storage).
   * Absent on a snapshot computed before this field existed.
   */
  storageBreakdown?: Array<{ provider: string; kind: string; bytes: string }>;
  /** Bytes of trashed (soft-deleted) media items' originals (`app.storage.trash.bytes`). */
  trashBytes?: string;
}

// Raw row shape of the storage breakdown query.
interface StorageBreakdownRow {
  provider: string;
  kind: string;
  trashed: boolean;
  bytes: bigint;
}

/**
 * The in-flight or last-known state of the global `storage_insights` job.
 *
 * @stability experimental
 */
export interface RefreshState {
  state: 'idle' | 'pending' | 'running' | 'failed';
  jobId: string | null;
  lastError: string | null;
}

// Raw row shape returned by $queryRaw for the media type query
interface MediaTypeRow {
  type: string;
  cnt: bigint;
  bytes: bigint;
}

/**
 * A snapshot row as the slice reads it.
 *
 * @stability experimental
 */
export interface InsightsSnapshotRow {
  /** The row id. */
  id: string;
  /** `ready` once computed. */
  status: string;
  /** The metrics document ({@link InsightsMetrics}). */
  metrics: unknown;
  /** When it was computed. */
  computedAt: Date | null;
  /** How long the computation took. */
  durationMs: number | null;
}

/**
 * Computes and caches the global storage-metrics snapshot, and enqueues its refresh.
 *
 * @stability experimental
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(
    @Inject(MEMORIAHUB_PRISMA) private readonly prisma: InsightsDb,
    @Inject(MEMORIAHUB_JOBS) private readonly jobs: MemoriahubJobsPort,
  ) {}

  // ---------------------------------------------------------------------------
  // computeMetrics
  // ---------------------------------------------------------------------------

  /** Aggregates the whole library: items and bytes by type, faces, tagged items, stored bytes by provider and kind. */
  async computeMetrics(): Promise<InsightsMetrics> {
    const [rows, totalFaces, taggedItems, breakdownRows] = await Promise.all([
      this.prisma.$queryRaw<MediaTypeRow[]>`
        SELECT mi.type AS type,
               COUNT(*)::bigint AS cnt,
               COALESCE(SUM(so.size), 0)::bigint AS bytes
        FROM media_items mi
        JOIN storage_objects so ON so.id = mi.storage_object_id
        WHERE mi.deleted_at IS NULL
        GROUP BY mi.type
      `,
      this.prisma.face.count(),
      this.prisma.mediaTagStatus.count({
        where: {
          tagCount: { gt: 0 },
          mediaItem: { deletedAt: null },
        },
      }),
      this.prisma.$queryRaw<StorageBreakdownRow[]>`
        SELECT so.storage_provider AS provider,
               CASE WHEN so.storage_key LIKE 'thumbnails/%' THEN 'thumbnail'
                    WHEN mi.type IS NOT NULL THEN mi.type::text
                    ELSE 'other' END AS kind,
               (mi.deleted_at IS NOT NULL) AS trashed,
               COALESCE(SUM(so.size), 0)::bigint AS bytes
        FROM storage_objects so
        LEFT JOIN media_items mi ON mi.storage_object_id = so.id
        GROUP BY 1, 2, 3
      `,
    ]);

    let photoCnt = BigInt(0);
    let photoBytesBig = BigInt(0);
    let videoCnt = BigInt(0);
    let videoBytesBig = BigInt(0);

    for (const row of rows) {
      if (row.type === 'photo') {
        photoCnt = row.cnt;
        photoBytesBig = row.bytes;
      } else if (row.type === 'video') {
        videoCnt = row.cnt;
        videoBytesBig = row.bytes;
      }
    }

    const totalBytesBig = photoBytesBig + videoBytesBig;

    return {
      totalBytes: totalBytesBig.toString(),
      photoBytes: photoBytesBig.toString(),
      videoBytes: videoBytesBig.toString(),
      totalItems: Number(photoCnt) + Number(videoCnt),
      photoCount: Number(photoCnt),
      videoCount: Number(videoCnt),
      totalFaces,
      taggedItems,
      ...summariseStorage(breakdownRows),
    };
  }

  // ---------------------------------------------------------------------------
  // getLatest
  // ---------------------------------------------------------------------------

  /** The latest ready snapshot, or null when none was computed. */
  async getLatest(): Promise<InsightsSnapshotRow | null> {
    return this.prisma.insightsSnapshot.findFirst({
      where: { status: 'ready' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // runComputation
  // ---------------------------------------------------------------------------
  //
  // The actual computation step called by StorageInsightsHandler.process().
  // Writes a ready snapshot row and prunes older snapshot rows.
  // Throws on error so the worker can record lastError and retry.
  // The in-process concurrency lock has been removed — the enrichment queue
  // guarantees a single in-flight job per (type, mediaItemId IS NULL) via
  // enqueue idempotency and atomic job claim.
  // ---------------------------------------------------------------------------

  /** Computes and stores a ready snapshot and prunes the older ones. Throws so the queue records the error and retries. */
  async runComputation(): Promise<InsightsSnapshotRow> {
    const start = Date.now();
    const metrics = await this.computeMetrics();
    const durationMs = Date.now() - start;

    const snapshot = await this.prisma.insightsSnapshot.create({
      data: {
        status: 'ready',
        metrics: metrics as unknown as Record<string, unknown>,
        computedAt: new Date(),
        durationMs,
      },
    });

    // Prune older snapshots — keep only the latest ready one
    await this.prisma.insightsSnapshot.deleteMany({
      where: { id: { not: snapshot.id } },
    });

    this.logger.log(`Insights snapshot computed in ${durationMs}ms`);
    return snapshot;
  }

  // ---------------------------------------------------------------------------
  // enqueueRefresh
  // ---------------------------------------------------------------------------
  //
  // Enqueues a storage_insights enrichment job. Uses null mediaItemId/circleId
  // so the queue idempotency deduplicates by (type, mediaItemId IS NULL).
  // ---------------------------------------------------------------------------

  /**
   * Enqueues the global `storage_insights` job and answers its id and status (`pending`, or
   * `running` when a job was already in flight).
   *
   * @param reason - why (`rerun` for a manual refresh).
   * @param priority - the queue priority (0 pre-empts the scheduled 100).
   */
  async enqueueRefresh(reason: string, priority: number): Promise<{ id: string; status: string }> {
    const { id } = await this.jobs.enqueue({ type: 'storage_insights', reason, payload: {}, priority });
    const row = await this.prisma.job.findUnique({ where: { id }, select: { status: true } });
    return { id, status: (row?.status as string | undefined) ?? 'pending' };
  }

  // ---------------------------------------------------------------------------
  // getRefreshState
  // ---------------------------------------------------------------------------
  //
  // Returns the in-flight/last-known state of the storage_insights job by
  // querying the most recent platform `jobs` row of this type (RETRO-C8, #608:
  // a global job, so the type alone identifies it).
  // ---------------------------------------------------------------------------

  /** The state of the newest `storage_insights` job row. */
  async getRefreshState(): Promise<RefreshState> {
    const job = await this.prisma.job.findFirst({
      where: { type: 'storage_insights' },
      orderBy: { createdAt: 'desc' },
    });

    if (!job) {
      return { state: 'idle', jobId: null, lastError: null };
    }

    switch (job.status) {
      case 'pending':
        return { state: 'pending', jobId: job.id, lastError: null };
      case 'running':
        return { state: 'running', jobId: job.id, lastError: null };
      case 'failed':
        return { state: 'failed', jobId: job.id, lastError: job.lastError as string | null };
      case 'succeeded':
      default:
        return { state: 'idle', jobId: null, lastError: null };
    }
  }
}

/**
 * Fold the breakdown rows (provider x kind x trashed) into the snapshot's two
 * storage fields. Tolerates rows of another shape (returns nothing for them).
 */
function summariseStorage(rows: unknown): Pick<InsightsMetrics, 'storageBreakdown' | 'trashBytes'> {
  if (!Array.isArray(rows)) return {};
  const byKey = new Map<string, { provider: string; kind: string; bytes: bigint }>();
  let trash = BigInt(0);
  for (const row of rows as StorageBreakdownRow[]) {
    if (typeof row?.provider !== 'string' || typeof row?.kind !== 'string') continue;
    const bytes = BigInt(row.bytes ?? 0);
    const key = `${row.provider}|${row.kind}`;
    const entry = byKey.get(key) ?? { provider: row.provider, kind: row.kind, bytes: BigInt(0) };
    entry.bytes += bytes;
    byKey.set(key, entry);
    if (row.trashed === true && row.kind !== 'thumbnail') trash += bytes;
  }
  if (byKey.size === 0) return {};
  return {
    storageBreakdown: [...byKey.values()].map((e) => ({ provider: e.provider, kind: e.kind, bytes: e.bytes.toString() })),
    trashBytes: trash.toString(),
  };
}

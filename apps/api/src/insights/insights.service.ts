// =============================================================================
// Insights Service
// =============================================================================
//
// Computes and caches a global storage-metrics snapshot across all circles.
// Uses an in-process lock to prevent concurrent recomputes.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, InsightsSnapshot } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface InsightsMetrics {
  totalBytes: string;   // BigInt serialised as string for JSON safety
  photoBytes: string;
  videoBytes: string;
  totalItems: number;
  photoCount: number;
  videoCount: number;
  totalFaces: number;
  taggedItems: number;
}

// Raw row shape returned by $queryRaw for the media type query
interface MediaTypeRow {
  type: string;
  cnt: bigint;
  bytes: bigint;
}

@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  private computing = false;

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // computeMetrics
  // ---------------------------------------------------------------------------

  async computeMetrics(): Promise<InsightsMetrics> {
    const [rows, totalFaces, taggedItems] = await Promise.all([
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
    };
  }

  // ---------------------------------------------------------------------------
  // getLatest
  // ---------------------------------------------------------------------------

  async getLatest(): Promise<InsightsSnapshot | null> {
    return this.prisma.insightsSnapshot.findFirst({
      where: { status: 'ready' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // recompute
  // ---------------------------------------------------------------------------

  async recompute(): Promise<InsightsSnapshot> {
    if (this.computing) {
      this.logger.warn('Insights recompute already in progress; returning existing snapshot');
      const existing = await this.getLatest();
      if (existing) return existing;
      throw new Error('Insights recompute already in progress and no existing snapshot available');
    }

    this.computing = true;
    const snapshot = await this.prisma.insightsSnapshot.create({
      data: { status: 'computing' },
    });

    const start = Date.now();
    try {
      const metrics = await this.computeMetrics();
      const durationMs = Date.now() - start;

      const updated = await this.prisma.insightsSnapshot.update({
        where: { id: snapshot.id },
        data: {
          status: 'ready',
          metrics: metrics as unknown as Prisma.JsonObject,
          computedAt: new Date(),
          durationMs,
        },
      });

      // Prune old snapshots — keep only this one
      await this.prisma.insightsSnapshot.deleteMany({
        where: { id: { not: updated.id } },
      });

      this.logger.log(`Insights snapshot computed in ${durationMs}ms`);
      return updated;
    } catch (err) {
      await this.prisma.insightsSnapshot.update({
        where: { id: snapshot.id },
        data: {
          status: 'failed',
          error: String(err),
        },
      });
      throw err;
    } finally {
      this.computing = false;
    }
  }
}

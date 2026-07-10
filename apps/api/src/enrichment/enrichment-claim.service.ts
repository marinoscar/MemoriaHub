// =============================================================================
// Enrichment Claim Service
// =============================================================================
//
// A single, DB-atomic job claim shared by BOTH the in-process server worker and
// (later) the distributed node data-plane. The claim is performed with one raw
// SQL statement using `FOR UPDATE SKIP LOCKED`, which is multi-process safe:
// two processes (or a server + a remote CLI worker node) can call claim()
// concurrently and Postgres guarantees they never select the same pending row.
//
// This replaces the old in-process promise-chain mutex in EnrichmentJobWorker,
// which only serialized claims WITHIN a single process and therefore
// double-claimed across processes.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { EnrichmentJob, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface EnrichmentClaimOptions {
  /** Owning worker node id, or null for the server in-process worker. */
  nodeId: string | null;
  /** Which plane is claiming: 'server' (in-process) or 'node' (remote CLI). */
  executor: 'server' | 'node';
  /** Job types this claimer is able to run. */
  eligibleTypes: string[];
  /** Maximum number of jobs to claim in this call. */
  limit: number;
  /** Lease duration (ms). A running job whose lease expires is reaped. */
  leaseMs: number;
}

@Injectable()
export class EnrichmentClaimService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically claim up to `limit` eligible pending jobs and mark them running.
   *
   * The claim is a single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
   * LOCKED) statement, so concurrent claimers (multiple processes / remote
   * nodes) never contend for the same row.
   *
   * `attempts` is charged at CLAIM time (attempts + 1), preserving the existing
   * queue semantic: `attempts` means "attempts STARTED", not "attempts failed",
   * so a job that takes the whole process down (OOM SIGKILL) before reaching the
   * in-process failure path still consumes its attempt and can be permanently
   * failed by the stuck/lease reaper once the budget is exhausted.
   *
   * RETURNING aliases every column to the Prisma camelCase field name so the
   * returned rows match the `EnrichmentJob` shape directly (mirrors the
   * $queryRaw row-mapping convention used elsewhere, e.g. dedup/duplicate
   * services), with no post-query JS remapping needed.
   */
  async claim(opts: EnrichmentClaimOptions): Promise<EnrichmentJob[]> {
    const { nodeId, executor, eligibleTypes, limit, leaseMs } = opts;

    // Guard against an empty eligible-types set: `type = ANY('{}'::text[])`
    // matches nothing, but skip the round-trip entirely for clarity.
    if (eligibleTypes.length === 0 || limit <= 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<EnrichmentJob[]>(Prisma.sql`
      UPDATE enrichment_jobs SET
        status = 'running',
        started_at = now(),
        scheduled_for = NULL,
        attempts = attempts + 1,
        claimed_by_node_id = ${nodeId}::uuid,
        executor = ${executor},
        lease_expires_at = now() + (${leaseMs} * interval '1 millisecond')
      WHERE id IN (
        SELECT id FROM enrichment_jobs
        WHERE status = 'pending'
          AND (scheduled_for IS NULL OR scheduled_for <= now())
          AND type = ANY(${eligibleTypes}::text[])
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING
        id,
        type,
        media_item_id   AS "mediaItemId",
        circle_id       AS "circleId",
        status,
        reason,
        priority,
        provider_key    AS "providerKey",
        model_version   AS "modelVersion",
        payload,
        attempts,
        last_error      AS "lastError",
        created_at      AS "createdAt",
        started_at      AS "startedAt",
        finished_at     AS "finishedAt",
        scheduled_for   AS "scheduledFor",
        rate_limited_at AS "rateLimitedAt",
        rate_limit_hits AS "rateLimitHits",
        claimed_by_node_id AS "claimedByNodeId",
        lease_expires_at   AS "leaseExpiresAt",
        executor
    `);

    return rows;
  }
}

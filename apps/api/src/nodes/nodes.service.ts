// =============================================================================
// Nodes Service
// =============================================================================
//
// Control-plane service for the distributed worker-node data plane. Handles node
// registration/lifecycle, heartbeats, atomic job claiming (delegated to the
// shared EnrichmentClaimService), lease renewal, admin listing with health, and
// the static parity model manifest that nodes download to match server output.
// =============================================================================

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { EnrichmentJob, JobStatus, NodeStatus, WorkerNode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentClaimService } from '../enrichment/enrichment-claim.service';
import { ObjectsService } from '../storage/objects/objects.service';

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface RegisterNodeInput {
  name: string;
  hostname: string;
  platform: string;
  cliVersion: string;
  eligibleTypes: string[];
  concurrency?: number;
}

export interface HeartbeatInput {
  status?: NodeStatus;
  capabilities?: unknown;
}

// ---------------------------------------------------------------------------
// Defaults resolved from env
// ---------------------------------------------------------------------------

/** Default lease duration (ms) for claimed jobs. */
function defaultLeaseMs(): number {
  return Number(process.env.ENRICHMENT_LEASE_MS) || 1_800_000;
}

/** Freshness window (ms) beyond which a heartbeat is considered stale. */
function staleWindowMs(): number {
  return (Number(process.env.NODE_HEARTBEAT_STALE_SECONDS) || 60) * 1000;
}

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentClaimService: EnrichmentClaimService,
    private readonly objectsService: ObjectsService,
  ) {}

  // -------------------------------------------------------------------------
  // Ownership helper
  // -------------------------------------------------------------------------

  /**
   * Load a node and assert the caller owns it. Throws NotFoundException if the
   * node does not exist, ForbiddenException if it belongs to another user.
   * Every owner-scoped data-plane call funnels through this.
   */
  private async assertOwnership(userId: string, nodeId: string): Promise<WorkerNode> {
    const node = await this.prisma.workerNode.findUnique({ where: { id: nodeId } });
    if (!node) {
      throw new NotFoundException(`WorkerNode ${nodeId} not found`);
    }
    if (node.createdById !== userId) {
      throw new ForbiddenException('You do not own this worker node');
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  async register(userId: string, dto: RegisterNodeInput): Promise<{ nodeId: string }> {
    const now = new Date();
    const node = await this.prisma.workerNode.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        platform: dto.platform,
        cliVersion: dto.cliVersion,
        eligibleTypes: dto.eligibleTypes,
        concurrency: dto.concurrency ?? 1,
        status: NodeStatus.online,
        registeredAt: now,
        lastHeartbeatAt: now,
        createdById: userId,
      },
    });
    return { nodeId: node.id };
  }

  // -------------------------------------------------------------------------
  // deregister
  // -------------------------------------------------------------------------

  async deregister(userId: string, nodeId: string): Promise<{ status: NodeStatus }> {
    await this.assertOwnership(userId, nodeId);
    const updated = await this.prisma.workerNode.update({
      where: { id: nodeId },
      data: { status: NodeStatus.offline },
    });
    return { status: updated.status };
  }

  // -------------------------------------------------------------------------
  // heartbeat
  // -------------------------------------------------------------------------

  async heartbeat(
    userId: string,
    nodeId: string,
    dto: HeartbeatInput,
  ): Promise<{ ok: true }> {
    await this.assertOwnership(userId, nodeId);
    await this.prisma.workerNode.update({
      where: { id: nodeId },
      data: {
        lastHeartbeatAt: new Date(),
        // Only overwrite status/capabilities when the node actually reported them.
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.capabilities !== undefined
          ? { capabilities: dto.capabilities as never }
          : {}),
      },
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // claim
  // -------------------------------------------------------------------------

  async claim(
    userId: string,
    nodeId: string,
    max?: number,
    types?: string[],
  ): Promise<{ jobs: Array<{ job: EnrichmentJob; inputUrl: string | null; params: unknown }> }> {
    const node = await this.assertOwnership(userId, nodeId);

    if (node.status === NodeStatus.disabled) {
      throw new ForbiddenException('This worker node is disabled and cannot claim jobs');
    }

    // Intersect requested types with the node's eligible types when the caller
    // narrows the set; otherwise use the node's full eligible-types list.
    const eligibleTypes =
      types && types.length > 0
        ? node.eligibleTypes.filter((t) => types.includes(t))
        : node.eligibleTypes;

    // Never exceed the node's declared concurrency.
    const limit = Math.min(max ?? node.concurrency, node.concurrency);
    const leaseMs = defaultLeaseMs();

    const claimed = await this.enrichmentClaimService.claim({
      nodeId,
      executor: 'node',
      eligibleTypes,
      limit,
      leaseMs,
    });

    const jobs = await Promise.all(
      claimed.map(async (job) => ({
        job,
        inputUrl: await this.resolveInputUrl(job, userId, /* userPermissions */ []),
        params: job.payload ?? null,
      })),
    );

    return { jobs };
  }

  /**
   * Best-effort presigned download URL for a claimed job's source object.
   *
   * KNOWN LIMITATION: ObjectsService.getDownloadUrl performs a per-user
   * ownership/circle-membership auth check keyed to the node owner. A node
   * owner's PAT may not have access to every job's media (e.g. system/global
   * jobs, or media in circles the owner isn't a member of), in which case the
   * presign throws. We swallow any error and return null so a single
   * inaccessible object never fails the whole claim. A trusted node executor
   * should ideally bypass per-user auth here — deferred.
   */
  private async resolveInputUrl(
    job: EnrichmentJob,
    userId: string,
    userPermissions: string[],
  ): Promise<string | null> {
    // Global/system jobs have no media item — nothing to presign.
    if (!job.mediaItemId) {
      return null;
    }

    try {
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: job.mediaItemId },
        select: { storageObjectId: true },
      });
      if (!mediaItem?.storageObjectId) {
        return null;
      }
      const result = await this.objectsService.getDownloadUrl(
        mediaItem.storageObjectId,
        userId,
        undefined,
        userPermissions,
      );
      return result.url;
    } catch {
      // Inaccessible / not-ready object — continue without an input URL.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // renewLease
  // -------------------------------------------------------------------------

  async renewLease(
    userId: string,
    nodeId: string,
    jobId: string,
    leaseMs?: number,
  ): Promise<{ leaseExpiresAt: Date }> {
    await this.assertOwnership(userId, nodeId);

    const leaseExpiresAt = new Date(Date.now() + (leaseMs ?? defaultLeaseMs()));

    // Conditional update: only extend the lease when this node still holds the
    // running job. count === 0 means the job was reassigned, finished, or the
    // lease was reaped — the node should stop working it.
    const result = await this.prisma.enrichmentJob.updateMany({
      where: {
        id: jobId,
        status: JobStatus.running,
        claimedByNodeId: nodeId,
      },
      data: { leaseExpiresAt },
    });

    if (result.count === 0) {
      throw new BadRequestException('job not owned by this node or not running');
    }

    return { leaseExpiresAt };
  }

  // -------------------------------------------------------------------------
  // listNodes
  // -------------------------------------------------------------------------

  async listNodes(userId?: string) {
    const nodes = await this.prisma.workerNode.findMany({
      where: userId ? { createdById: userId } : undefined,
      orderBy: { registeredAt: 'desc' },
    });

    if (nodes.length === 0) {
      return [];
    }

    // Fold per-node claimed-job counts by status in a single grouped query.
    const nodeIds = nodes.map((n) => n.id);
    const grouped = await this.prisma.enrichmentJob.groupBy({
      by: ['claimedByNodeId', 'status'],
      where: { claimedByNodeId: { in: nodeIds } },
      _count: { _all: true },
    });

    const countsByNode = new Map<
      string,
      { running: number; succeeded: number; failed: number }
    >();
    for (const row of grouped) {
      if (!row.claimedByNodeId) {
        continue;
      }
      const bucket =
        countsByNode.get(row.claimedByNodeId) ??
        { running: 0, succeeded: 0, failed: 0 };
      if (row.status === JobStatus.running) {
        bucket.running += row._count._all;
      } else if (row.status === JobStatus.succeeded) {
        bucket.succeeded += row._count._all;
      } else if (row.status === JobStatus.failed) {
        bucket.failed += row._count._all;
      }
      countsByNode.set(row.claimedByNodeId, bucket);
    }

    const now = Date.now();
    const staleMs = staleWindowMs();

    return nodes.map((node) => {
      let health: 'healthy' | 'stale' | 'offline';
      if (node.status === NodeStatus.offline || node.status === NodeStatus.disabled) {
        health = 'offline';
      } else if (
        node.lastHeartbeatAt &&
        now - node.lastHeartbeatAt.getTime() <= staleMs
      ) {
        health = 'healthy';
      } else {
        health = 'stale';
      }

      const jobCounts =
        countsByNode.get(node.id) ?? { running: 0, succeeded: 0, failed: 0 };

      return { ...node, health, jobCounts };
    });
  }

  // -------------------------------------------------------------------------
  // deleteNode (admin)
  // -------------------------------------------------------------------------

  async deleteNode(nodeId: string): Promise<{ deleted: true }> {
    // claimedJobs FK is SetNull, so deleting a node is safe and orphans nothing.
    await this.prisma.workerNode.delete({ where: { id: nodeId } });
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // getModelManifest
  // -------------------------------------------------------------------------

  /**
   * Static manifest of the parity models a worker node must download so its
   * enrichment output matches the server. Structure matters more than exact
   * values here.
   *
   * TODO: fill real sha256/bytes hashes
   */
  getModelManifest() {
    return {
      models: [
        {
          name: 'clip-vit-b32-vision-quantized.onnx',
          url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
          sha256: null,
          bytes: null,
          targetSubdir: 'models',
        },
        {
          name: 'blazeface-back.json',
          url: 'https://github.com/vladmandic/human-models/raw/main/models/blazeface-back.json',
          sha256: null,
          bytes: null,
          targetSubdir: 'human',
        },
        {
          name: 'faceres.json',
          url: 'https://github.com/vladmandic/human-models/raw/main/models/faceres.json',
          sha256: null,
          bytes: null,
          targetSubdir: 'human',
        },
        {
          name: 'faceres.bin',
          url: 'https://github.com/vladmandic/human-models/raw/main/models/faceres.bin',
          sha256: null,
          bytes: null,
          targetSubdir: 'human',
        },
      ],
    };
  }
}

// =============================================================================
// Offline Worker-Node Retention Pruner
// =============================================================================
//
// Daily cron that deletes dead worker_nodes rows: nodes at status='offline'
// whose last heartbeat (or registration time, when they never heartbeated) is
// older than NODE_OFFLINE_RETENTION_DAYS (default 14). Without this, the
// idempotent register-or-reattach flow still leaves permanently-dead rows
// behind (e.g. a replica renamed by the pre-dedupe migration, or a machine
// that was deregistered and never came back) accumulating forever.
//
// Deleting a node is safe for job rows — enrichment_jobs.claimed_by_node_id
// is ON DELETE SET NULL — but nodes with a job currently RUNNING under their
// claim are excluded anyway so live queue state never points at a node that
// vanished mid-run.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobStatus, NodeStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Retention window (days) for offline node rows before they are pruned. */
function retentionDays(): number {
  return Number(process.env.NODE_OFFLINE_RETENTION_DAYS) || 14;
}

@Injectable()
export class NodeOfflinePruneTask {
  private readonly logger = new Logger(NodeOfflinePruneTask.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    try {
      await this.prune();
    } catch (err) {
      this.logger.error('Failed to prune offline worker nodes', err as Error);
    }
  }

  /**
   * Delete offline nodes past the retention window that have no running
   * claimed jobs. Returns the number of rows pruned.
   */
  async prune(): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays() * 86_400_000);

    const candidates = await this.prisma.workerNode.findMany({
      where: {
        status: NodeStatus.offline,
        OR: [
          { lastHeartbeatAt: { lt: cutoff } },
          // Never heartbeated at all — age by registration time instead.
          { lastHeartbeatAt: null, registeredAt: { lt: cutoff } },
        ],
      },
      select: { id: true },
    });
    if (candidates.length === 0) {
      return 0;
    }

    const candidateIds = candidates.map((n) => n.id);

    // Exclude nodes that still have a job RUNNING under their claim — the FK
    // is SetNull so deletion wouldn't break the row, but live queue state
    // should never reference a node that was pruned mid-run.
    const busy = await this.prisma.enrichmentJob.findMany({
      where: {
        claimedByNodeId: { in: candidateIds },
        status: JobStatus.running,
      },
      select: { claimedByNodeId: true },
      distinct: ['claimedByNodeId'],
    });
    const busyIds = new Set(busy.map((j) => j.claimedByNodeId));

    const prunableIds = candidateIds.filter((id) => !busyIds.has(id));
    if (prunableIds.length === 0) {
      return 0;
    }

    const { count } = await this.prisma.workerNode.deleteMany({
      where: { id: { in: prunableIds } },
    });

    if (count > 0) {
      this.logger.log(
        `Pruned ${count} offline worker node(s) past the ${retentionDays()}-day retention window`,
      );
    }
    return count;
  }
}

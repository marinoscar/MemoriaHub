// =============================================================================
// Worker-Node Staleness Sweep (issue #438, defect 6)
// =============================================================================
//
// Every 10 minutes, transitions worker_nodes rows whose heartbeat has been
// silent past NODE_HEARTBEAT_STALE_SECONDS x NODE_OFFLINE_STALE_MULTIPLIER to
// status='offline'.
//
// Before this task, `deregister` was the ONLY writer of status='offline', so a
// node that was killed, crashed, OOM'd or lost the network sat at
// status='online' forever — the admin fleet view showed a green "online" chip
// above an amber "Stale - 20d ago" pill, and NodeOfflinePruneTask (which
// selects ONLY status='offline') could never prune it, making
// NODE_OFFLINE_RETENTION_DAYS a no-op for exactly the failure mode it exists
// to clean up. This sweep fixes both at the source; the prune task's own
// predicate is unchanged.
//
// The actual set-based updateMany lives in NodesService.markStaleNodesOffline
// so it reuses the SAME staleWindowMs() the admin health derivation uses,
// rather than introducing a second, independently-drifting notion of "stale".
// Mirrors the delegating, never-throws shape of node-backup-stale.task.ts, and
// takes its env kill-switch from the THUMBNAIL_REPAIR_ENABLED precedent.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NodesService } from './nodes.service';

/** Kill-switch: set NODE_STALE_OFFLINE_ENABLED=false to disable the sweep. */
function sweepEnabled(): boolean {
  return process.env.NODE_STALE_OFFLINE_ENABLED !== 'false';
}

@Injectable()
export class NodeStaleOfflineTask {
  private readonly logger = new Logger(NodeStaleOfflineTask.name);

  constructor(private readonly nodesService: NodesService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleStaleSweep(): Promise<void> {
    if (!sweepEnabled()) {
      return;
    }
    try {
      const transitioned = await this.nodesService.markStaleNodesOffline();
      if (transitioned > 0) {
        this.logger.log(
          `Marked ${transitioned} stale worker node(s) offline (no heartbeat within the offline threshold)`,
        );
      }
    } catch (err) {
      this.logger.error('worker node staleness sweep failed', err as Error);
    }
  }
}

// =============================================================================
// node_backup.stale_sweep (issue #312, epic #308; a job since RETRO-C9, #612)
// =============================================================================
//
// Marks `running` NodeBackupRun rows whose lastAckAt has fallen outside the
// backup.runStaleMinutes window as `stale` (+ finishedAt), releasing the
// single-active-run guard a crashed node would otherwise hold forever
// (`NodeBackupService.markStaleRuns`). The 10-minute `NodeBackupStaleTask`
// only enqueues it.
//
// A GLOBAL system job (single-flight by the queue's dedup). SERVER-ONLY (no
// node-result pair): it writes `node_backup_runs`.
//
// THE TYPE STRING IS PERMANENT once jobs of it exist
// (`test/jobs/job-type-snapshot.spec.ts` pins it).
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type JobExecutionProfile, type JobHandler } from '@marinoscar/platform-api/jobs';

import { NodeBackupService } from './node-backup.service';

/** `NodeBackupStaleHandler`'s permanent job type. */
export const NODE_BACKUP_STALE_SWEEP_TYPE = 'node_backup.stale_sweep';

@Injectable()
export class NodeBackupStaleHandler implements JobHandler, OnModuleInit {
  readonly type = NODE_BACKUP_STALE_SWEEP_TYPE;

  readonly label = 'Node backup staleness sweep';

  /** One set-based update: five minutes, three attempts. */
  readonly profile: JobExecutionProfile = { maxRuntimeMs: 300_000, maxAttempts: 3 };

  private readonly logger = new Logger(NodeBackupStaleHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly backupService: NodeBackupService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const released = await this.backupService.markStaleRuns();
    if (released > 0) {
      this.logger.log(`Marked ${released} stale node backup run(s)`);
    }
  }
}

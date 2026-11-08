import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { EnrichmentAdminService } from '../../../enrichment/enrichment-admin.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, warn } from '../outcome';

// Ported from `DoctorService.checkQueueHealth` (key `jobs.queueHealth`).
// READ-ONLY: the admin queue statistics (cached aggregate SELECTs).
// Retirement: replaced by the jobs slice's checks (RETRO-C1).

export interface QueueStats {
  stuckRunning: number;
  byStatus: { pending: number; running: number; failed: number };
}

export function decideQueueHealth(stats: QueueStats): DoctorCheckOutcome {
  if (stats.stuckRunning > 0) {
    return warn(
      `${stats.stuckRunning} job(s) stuck running.`,
      'Reset stuck jobs from the Job Queue page.',
      { stuckRunning: stats.stuckRunning },
    );
  }
  if (stats.byStatus.failed > 0) {
    return warn(
      `${stats.byStatus.failed} failed job(s) in the queue.`,
      'Review and retry failed jobs from the Job Queue page.',
      { failed: stats.byStatus.failed },
    );
  }
  return pass(`Queue healthy (pending ${stats.byStatus.pending}, running ${stats.byStatus.running}).`, {
    pending: stats.byStatus.pending,
    running: stats.byStatus.running,
  });
}

@Injectable()
export class QueueHealthDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('jobs', 'queue-health');
  readonly category = 'jobs';
  readonly label = 'Queue health';
  readonly settingsPath = '/admin/settings/jobs';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly enrichmentAdmin: EnrichmentAdminService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideQueueHealth(await this.enrichmentAdmin.getStats());
  }
}

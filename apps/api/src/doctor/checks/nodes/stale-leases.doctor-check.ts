import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, warn } from '../outcome';

// Ported from `DoctorService.checkNodesStaleLeases` (key `nodes.staleLeases`).
// READ-ONLY: one `count`.
// Retirement: replaced by the nodes slice's checks (RETRO-C2).

export function decideStaleLeases(expired: number): DoctorCheckOutcome {
  if (expired > 0) {
    return warn(
      `${expired} running job(s) have an expired lease (claiming node likely died).`,
      'Reset stuck jobs from the Job Queue page (reset-stuck) so they are requeued for another worker or node.',
      { expired },
    );
  }
  return pass('No running jobs with an expired lease.', { expired: 0 });
}

@Injectable()
export class NodesStaleLeasesDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('nodes', 'stale-leases');
  readonly category = 'nodes';
  readonly label = 'Expired leases';
  readonly settingsPath = '/admin/settings/jobs';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const expired = await this.prisma.enrichmentJob.count({
      where: { status: 'running', leaseExpiresAt: { lt: new Date() } },
    });
    return decideStaleLeases(expired);
  }
}

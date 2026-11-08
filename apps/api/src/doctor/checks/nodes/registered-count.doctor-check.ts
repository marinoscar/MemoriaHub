import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, skip } from '../outcome';

// Ported from `DoctorService.checkNodesRegistered` (key `nodes.registeredCount`).
// READ-ONLY: two counts. Nodes are optional, so none registered is a skip.
// Retirement: replaced by the nodes slice's checks (RETRO-C2).

export function decideNodesRegistered(total: number, online: number): DoctorCheckOutcome {
  if (total === 0) return skip('No worker nodes registered (distributed compute is optional).');
  return pass(`${total} worker node(s) registered, ${online} online.`, { total, online });
}

@Injectable()
export class NodesRegisteredDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('nodes', 'registered-count');
  readonly category = 'nodes';
  readonly label = 'Registered nodes';
  readonly settingsPath = '/admin/settings/nodes';
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
    const [total, online] = await Promise.all([
      this.prisma.mhLegacyWorkerNode.count(),
      this.prisma.mhLegacyWorkerNode.count({ where: { status: 'online' } }),
    ]);
    return decideNodesRegistered(total, online);
  }
}

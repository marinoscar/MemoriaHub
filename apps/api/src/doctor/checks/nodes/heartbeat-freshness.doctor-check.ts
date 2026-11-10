import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, skip, warn } from '../outcome';
import { nodeStaleWindowMs } from './node-heartbeat-window';

// Ported from `DoctorService.checkNodesHeartbeat` (key `nodes.heartbeatFreshness`).
// READ-ONLY: one `findMany`. Node names are operator-chosen labels.
// Retirement: replaced by the nodes slice's checks (RETRO-C2).

export function decideNodesHeartbeat(
  onlineNodes: Array<{ name: string; lastHeartbeatAt: Date | null }>,
  staleMs: number,
  now: number,
): DoctorCheckOutcome {
  if (onlineNodes.length === 0) return skip('No online worker nodes to check.');

  const stale = onlineNodes.filter((n) => !n.lastHeartbeatAt || now - n.lastHeartbeatAt.getTime() > staleMs);
  if (stale.length === 0) {
    return pass(`All ${onlineNodes.length} online node(s) have reported a fresh heartbeat.`, { online: onlineNodes.length });
  }

  const staleNames = stale.map((n) => n.name).join(', ');
  const windowSeconds = Math.round(staleMs / 1000);

  if (stale.length === onlineNodes.length) {
    return fail(
      `All ${onlineNodes.length} online node(s) are stale (no heartbeat within ${windowSeconds}s): ${staleNames}.`,
      'Check that the node machines are awake and networked; they will be marked offline if they stay unreachable.',
      { online: onlineNodes.length, stale: stale.length },
    );
  }

  return warn(
    `${stale.length} of ${onlineNodes.length} online node(s) are stale (no heartbeat within ${windowSeconds}s): ${staleNames}.`,
    'Check that the affected node machine(s) are awake and networked.',
    { online: onlineNodes.length, stale: stale.length },
  );
}

@Injectable()
export class NodesHeartbeatDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('nodes', 'heartbeat-freshness');
  readonly category = 'nodes';
  readonly label = 'Heartbeat freshness';
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
    const onlineNodes = await this.prisma.workerNode.findMany({
      where: { status: 'online' },
      select: { name: true, lastHeartbeatAt: true },
    });
    return decideNodesHeartbeat(onlineNodes, nodeStaleWindowMs(), Date.now());
  }
}

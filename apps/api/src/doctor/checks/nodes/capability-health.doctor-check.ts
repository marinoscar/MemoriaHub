import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, pass, skip, warn } from '../outcome';
import { extractDegradedCapabilities } from './capabilities';

// Ported from `DoctorService.checkNodesCapabilityHealth` (key
// `nodes.capabilityHealth`). READ-ONLY: one `findMany`. The node-reported
// `capabilities` JSON is untrusted and parsed defensively
// (`./capabilities.ts`); only capability NAMES reach the report.
// Retirement: replaced by the nodes slice's checks (RETRO-C2).

export interface NodeCapabilityRow {
  name: string;
  eligibleTypes: string[];
  capabilities: unknown;
}

export function decideNodesCapabilityHealth(onlineNodes: NodeCapabilityRow[]): DoctorCheckOutcome {
  const reporting = onlineNodes.filter((n) => n.capabilities != null);
  if (reporting.length === 0) return skip('No online node has reported a capability summary yet.');

  const degradedNodes: string[] = [];
  for (const node of reporting) {
    const degraded = extractDegradedCapabilities(node.capabilities, node.eligibleTypes);
    if (degraded.length > 0) degradedNodes.push(`${node.name} (${degraded.join(', ')})`);
  }

  if (degradedNodes.length > 0) {
    return warn(
      `Node(s) reporting a degraded capability among their eligible job types: ${degradedNodes.join('; ')}.`,
      'Run `memoriahub node doctor` on the affected machine(s) to resolve the failing capability (e.g. missing model files, ffmpeg, or OCR data).',
      { reporting: reporting.length, degraded: degradedNodes.length },
    );
  }
  return pass(`All ${reporting.length} reporting node(s) advertise healthy capabilities.`, { reporting: reporting.length });
}

@Injectable()
export class NodesCapabilityHealthDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('nodes', 'capability-health');
  readonly category = 'nodes';
  readonly label = 'Node capability health';
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
    const onlineNodes = await this.prisma.mhLegacyWorkerNode.findMany({
      where: { status: 'online' },
      select: { name: true, eligibleTypes: true, capabilities: true },
    });
    return decideNodesCapabilityHealth(onlineNodes);
  }
}

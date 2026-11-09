// =============================================================================
// Worker fleet capability gauge (RETRO-T3, #628)
// =============================================================================
//
//   app.nodes.capability{capability,state}  online worker nodes whose last
//   reported `capabilities` (the node's `node doctor` summary) shows each of the
//   five compute capabilities as `ok` or `missing`.
//
// One `findMany` over `worker_nodes` by `@@index([status])` (a small table). The
// JSON is node-reported and untrusted: it is parsed by the same tolerant reader
// the Doctor's `memoriahub.nodes.capability-health` check uses, and only the
// five capability NAMES below ever become label values (never a node id or name).
// =============================================================================

import { collectCapabilityEntries, isDegradedStatus } from '../../../doctor/checks/nodes/capabilities';
import type { PrismaService } from '../../../prisma/prisma.service';
import { NODE_CAPABILITIES } from '../memoriahub-metrics.manifest';

export type Capability = (typeof NODE_CAPABILITIES)[number];
export type CapabilityCounts = Record<Capability, { ok: number; missing: number }>;

/** Report names that stand for each capability (`ocr` is the tesseract pipeline). */
const ALIASES: Record<Capability, readonly string[]> = {
  ffmpeg: ['ffmpeg'],
  ffprobe: ['ffprobe'],
  tesseract: ['tesseract', 'ocr'],
  clip: ['clip', 'onnxruntime'],
  compreface: ['compreface', 'face'],
};

const ABSENT = new Set(['missing', 'unavailable', 'absent', 'not_installed', 'not-installed', 'none']);

/** Whether one node's capability summary shows `capability` as usable. */
export function capabilityOk(capabilities: unknown, capability: Capability): boolean {
  const entries = collectCapabilityEntries(capabilities).filter(({ name }) => {
    const lower = name.toLowerCase();
    return ALIASES[capability].some((alias) => lower.includes(alias));
  });
  if (entries.length === 0) return false;
  return entries.every(({ status }) => !isDegradedStatus(status) && !ABSENT.has(status.toLowerCase()));
}

/** Per capability, how many online nodes have it and how many lack it. */
export function countCapabilities(nodes: ReadonlyArray<{ capabilities: unknown }>): CapabilityCounts {
  const counts = Object.fromEntries(NODE_CAPABILITIES.map((c) => [c, { ok: 0, missing: 0 }])) as CapabilityCounts;
  for (const node of nodes) {
    for (const capability of NODE_CAPABILITIES) {
      counts[capability][capabilityOk(node.capabilities, capability) ? 'ok' : 'missing'] += 1;
    }
  }
  return counts;
}

export async function readNodeCapabilities(prisma: PrismaService): Promise<CapabilityCounts> {
  const nodes = await prisma.workerNode.findMany({ where: { status: 'online' }, select: { capabilities: true } });
  return countCapabilities(nodes);
}

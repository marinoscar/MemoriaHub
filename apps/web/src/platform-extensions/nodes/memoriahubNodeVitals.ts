// =============================================================================
// How the MemoriaHub executors' node vitals read on the Worker Nodes page (RETRO-T4, #629)
// =============================================================================
//
// The node CLI's executors report these through `vitals()` (apps/cli/src/executors); the platform
// merges them into the heartbeat's `vitals.extra`, and the vitals dialog words each through
// `formatNodeVital`. Keys match `^[a-z][a-z0-9_.]{1,47}$`. Units: the platform's `count`,
// `milliseconds`, or a free word.
// =============================================================================

import { registerNodeVital, type NodeVitalDef } from '@marinoscar/platform-web/nodes/headless';

export const MEMORIAHUB_NODE_VITALS: readonly NodeVitalDef[] = [
  { key: 'clip.embeds', label: 'CLIP embeddings (lifetime)', unit: 'count' },
  { key: 'clip.session.embeds', label: 'CLIP embeddings (current session)', unit: 'count' },
  { key: 'clip.session.recycles', label: 'CLIP session recycles', unit: 'count' },
  { key: 'compreface.latency_ms', label: 'CompreFace call latency (average)', unit: 'milliseconds' },
  { key: 'ocr.frames_total', label: 'OCR frames read', unit: 'count' },
  { key: 'sharp.concurrency', label: 'Image decode threads', unit: 'count' },
];

let registered = false;

/** Registers the vitals once; called at module scope of the nodes extension, before the page renders. */
export function registerMemoriahubNodeVitals(): void {
  if (registered) return;
  registered = true;
  MEMORIAHUB_NODE_VITALS.forEach((def) => registerNodeVital({ ...def }));
}

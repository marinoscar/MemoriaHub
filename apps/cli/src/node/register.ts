/**
 * node/register.ts — Shared worker-node registration flow.
 *
 * Extracted from `commands/node.ts`'s registerCmd so `node start` can
 * self-register in headless/container mode (no stored nodeId, config supplied
 * entirely via MEMORIAHUB_* env vars) without duplicating the capability
 * detection → registerNode → persist-config sequence.
 *
 * UI-free and dependency-injected (capability probe, config persistence) so
 * it is unit-testable without network or filesystem access; callers own all
 * ui.* output and process.exit error handling.
 */

import * as os from 'node:os';
import { saveConfig, type CliConfig, type NodeConfig } from '../config.js';
import type { ApiClient } from '../api.js';
import {
  detectCapabilities,
  missingRequirements,
  NODE_JOB_TYPES,
  type CapabilityStatus,
  type NodeJobType,
} from './capabilities.js';

/** Default poll interval when neither flag nor config supplies one. */
export const DEFAULT_NODE_POLL_MS = 5000;

/**
 * True when `node start` should run in headless (container) mode: either the
 * --headless flag was passed or the environment sets MEMORIAHUB_HEADLESS=1
 * (the worker container image sets the latter).
 */
export function resolveHeadless(
  opts: { headless?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(opts.headless) || env['MEMORIAHUB_HEADLESS'] === '1';
}

/**
 * Node name used by headless auto-registration when none is configured.
 * Precedence: persisted/env-overlaid config name (Phase 1 already overlays
 * MEMORIAHUB_NODE_NAME into cfg.node.name) → raw MEMORIAHUB_NODE_NAME env
 * (belt-and-braces for callers holding a stale config object) →
 * `worker-<hostname>`.
 */
export function defaultHeadlessNodeName(
  cfg: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
  hostname: () => string = os.hostname,
): string {
  const envName = env['MEMORIAHUB_NODE_NAME']?.trim();
  return cfg.node?.name ?? (envName || `worker-${hostname()}`);
}

/** Job types whose required capabilities are all satisfied by `caps`. */
export function supportedTypes(
  caps: Record<string, CapabilityStatus>,
  faceProvider: 'human' | 'compreface' = 'human',
): NodeJobType[] {
  return NODE_JOB_TYPES.filter((t) => missingRequirements(t, caps, faceProvider).length === 0);
}

export interface RegisterWorkerNodeInput {
  cfg: CliConfig;
  api: ApiClient;
  name: string;
  concurrency: number;
  /** Explicitly requested job types (already validated); empty = auto-detect. */
  requestedTypes: string[];
  faceProvider: 'human' | 'compreface';
  comprefaceUrl?: string;
  cliVersion: string;
}

export interface RegisterWorkerNodeDeps {
  /** Injectable for tests — defaults to the real capability probe. */
  detectFn?: typeof detectCapabilities;
  /** Injectable for tests — defaults to the real (best-effort) saveConfig. */
  saveConfigFn?: typeof saveConfig;
  /** Injectable for tests — defaults to os.hostname. */
  hostnameFn?: () => string;
}

export interface RegisterWorkerNodeResult {
  nodeId: string;
  /** True when the server re-attached to an existing (owner, name) node row. */
  reattached: boolean;
  eligibleTypes: string[];
  /** The NodeConfig persisted alongside the nodeId. */
  node: NodeConfig;
}

/**
 * Register (or re-attach) this machine as a worker node and persist the
 * assigned nodeId + node settings to config. Persistence goes through
 * `saveConfig`, which is already best-effort (warn, not crash) under an
 * env-complete headless config. API errors propagate to the caller.
 */
export async function registerWorkerNode(
  input: RegisterWorkerNodeInput,
  deps: RegisterWorkerNodeDeps = {},
): Promise<RegisterWorkerNodeResult> {
  const detectFn = deps.detectFn ?? detectCapabilities;
  const saveConfigFn = deps.saveConfigFn ?? saveConfig;
  const hostname = (deps.hostnameFn ?? os.hostname)();

  const caps = await detectFn({ comprefaceUrl: input.comprefaceUrl });
  const eligibleTypes =
    input.requestedTypes.length > 0
      ? input.requestedTypes
      : supportedTypes(caps, input.faceProvider);

  const res = await input.api.registerNode({
    name: input.name,
    hostname,
    platform: os.platform(),
    cliVersion: input.cliVersion,
    eligibleTypes,
    concurrency: input.concurrency,
  });

  const node: NodeConfig = {
    name: input.name,
    concurrency: input.concurrency,
    eligibleTypes,
    pollIntervalMs: input.cfg.node?.pollIntervalMs ?? DEFAULT_NODE_POLL_MS,
    faceProvider: input.faceProvider,
    comprefaceUrl: input.comprefaceUrl,
  };
  saveConfigFn({ ...input.cfg, nodeId: res.nodeId, node });

  return {
    nodeId: res.nodeId,
    reattached: res.reattached === true,
    eligibleTypes,
    node,
  };
}

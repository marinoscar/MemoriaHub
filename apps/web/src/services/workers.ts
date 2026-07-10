import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a worker node (mirrors the API's NodeStatus enum). */
export type NodeStatus = 'online' | 'draining' | 'offline' | 'disabled';

/** Derived heartbeat health computed server-side in NodesService.listNodes(). */
export type NodeHealth = 'healthy' | 'stale' | 'offline';

/** Per-node claimed-job counts folded server-side. */
export interface NodeJobCounts {
  running: number;
  succeeded: number;
  failed: number;
}

/**
 * A worker node row as returned by `GET /admin/nodes`.
 *
 * Shape matches NodesService.listNodes(): the full WorkerNode record plus a
 * derived `health` field and a folded `jobCounts` object.
 */
export interface WorkerNodeDto {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  cliVersion: string;
  eligibleTypes: string[];
  concurrency: number;
  status: NodeStatus;
  capabilities: unknown | null;
  registeredAt: string;
  lastHeartbeatAt: string | null;
  createdById: string;
  /** Derived heartbeat freshness/status: healthy | stale | offline. */
  health: NodeHealth;
  /** Per-node claimed-job counts by status. */
  jobCounts: NodeJobCounts;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** List all registered worker nodes with derived health and per-node job counts. */
export async function getWorkers(): Promise<WorkerNodeDto[]> {
  return api.get<WorkerNodeDto[]>('/admin/nodes');
}

/** Delete (deregister) a worker node row by id. */
export async function deleteWorker(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/admin/nodes/${id}`);
}

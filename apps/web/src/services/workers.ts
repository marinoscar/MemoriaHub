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

// ---------------------------------------------------------------------------
// Node credentials
// ---------------------------------------------------------------------------

/**
 * A node credential row as returned by `GET /admin/nodes/credentials`.
 *
 * Flat shape (not nested under `owner`) matching the admin list endpoint.
 */
export interface AdminNodeCredentialDto {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  userId: string;
  ownerEmail: string;
  ownerDisplayName: string | null;
}

/** Response from `POST /node-credentials` — includes the RAW token, shown once. */
export interface CreatedNodeCredentialDto {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
}

/** List all node credentials across all users (admin view). */
export async function getNodeCredentials(): Promise<AdminNodeCredentialDto[]> {
  return api.get<AdminNodeCredentialDto[]>('/admin/nodes/credentials');
}

/** Create a new node credential (owned by the calling admin). */
export async function createNodeCredential(body: {
  name: string;
  expiresAt: string | null;
}): Promise<CreatedNodeCredentialDto> {
  return api.post<CreatedNodeCredentialDto>('/node-credentials', body);
}

/** Revoke a node credential by id. */
export async function revokeNodeCredential(id: string): Promise<void> {
  await api.delete<void>(`/admin/nodes/credentials/${id}`);
}

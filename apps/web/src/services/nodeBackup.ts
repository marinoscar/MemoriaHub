import { api } from './api';

// ---------------------------------------------------------------------------
// Types — mirror the API's node backup control plane exactly (issue #312/#319).
//
// Every byte counter (`bytesAcked`, `pending.bytes`, `bytesDownloaded`,
// `itemsAcked`) is a Prisma BigInt serialized as a decimal STRING at the DTO
// boundary. Never `Number()` these raw — humanize via BigInt parsing
// (`formatBytes` in utils/formatBytes.ts).
// ---------------------------------------------------------------------------

/** Backup run kind (mirrors the API's NodeBackupRunKind enum). */
export type NodeBackupRunKind = 'incremental' | 'reconcile';

/** Backup run lifecycle status (mirrors NodeBackupRunStatus). */
export type NodeBackupRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'stale';

/** How a run was started. */
export type NodeBackupRunTrigger = 'manual' | 'scheduled';

/** The config's monotonic change-feed checkpoint. */
export interface NodeBackupCheckpointDto {
  updatedAt: string;
  id: string;
}

/** Live pending-lag computation: items/bytes not yet acked past the checkpoint. */
export interface NodeBackupPendingDto {
  items: number;
  /** BigInt-safe decimal string. */
  bytes: string;
}

/**
 * A node's backup configuration as returned by
 * `GET /api/nodes/:id/backup/config` (and by the PUT, whose response matches
 * the GET shape).
 */
export interface NodeBackupConfigDto {
  nodeId: string;
  enabled: boolean;
  /** 5-field cron expression; null = manual-trigger only. */
  scheduleCron: string | null;
  /** IANA timezone the cron is evaluated in; null = UTC. */
  timezone: string | null;
  nextRunAt: string | null;
  /** Circle scope; empty array = ALL circles the node owner belongs to. */
  circleIds: string[];
  checkpoint: NodeBackupCheckpointDto | null;
  /** BigInt-safe decimal string. */
  itemsAcked: string;
  /** BigInt-safe decimal string. */
  bytesAcked: string;
  lastRunAt: string | null;
  lastCompletedRunAt: string | null;
  lastReconcileAt: string | null;
  pending: NodeBackupPendingDto;
  activeRunId: string | null;
}

/** Envelope of `GET /api/nodes/:id/backup/config` — null when never configured. */
export interface NodeBackupConfigResponse {
  config: NodeBackupConfigDto | null;
}

/** Partial body for `PUT /api/nodes/:id/backup/config` — only provided keys change. */
export interface UpdateNodeBackupConfigDto {
  enabled?: boolean;
  /** null clears the schedule (and nextRunAt). */
  scheduleCron?: string | null;
  /** null clears the timezone (falls back to UTC). */
  timezone?: string | null;
  /** Empty array = all owner circles. */
  circleIds?: string[];
}

/** One backup run row from `GET /api/nodes/:id/backup/runs`. */
export interface NodeBackupRunDto {
  id: string;
  kind: NodeBackupRunKind;
  status: NodeBackupRunStatus;
  trigger: NodeBackupRunTrigger;
  startedAt: string;
  finishedAt: string | null;
  lastAckAt: string | null;
  itemsDownloaded: number;
  itemsSkipped: number;
  sidecarsWritten: number;
  /** BigInt-safe decimal string. */
  bytesDownloaded: string;
  errorCount: number;
  lastError: string | null;
  cliVersion: string | null;
}

/** Envelope of `GET /api/nodes/:id/backup/runs`. */
export interface NodeBackupRunsResponse {
  runs: NodeBackupRunDto[];
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Get a node's backup config with live pending lag; `{ config: null }` when unset. */
export async function getNodeBackupConfig(
  nodeId: string,
): Promise<NodeBackupConfigResponse> {
  return api.get<NodeBackupConfigResponse>(`/nodes/${nodeId}/backup/config`);
}

/** Create or update a node's backup config (partial upsert). Response matches GET. */
export async function updateNodeBackupConfig(
  nodeId: string,
  dto: UpdateNodeBackupConfigDto,
): Promise<NodeBackupConfigResponse> {
  return api.put<NodeBackupConfigResponse>(`/nodes/${nodeId}/backup/config`, dto);
}

/** List recent backup runs for a node, newest first. */
export async function getNodeBackupRuns(
  nodeId: string,
  limit = 20,
): Promise<NodeBackupRunsResponse> {
  return api.get<NodeBackupRunsResponse>(
    `/nodes/${nodeId}/backup/runs?limit=${limit}`,
  );
}

import { api } from '../../../core/headless/index.js';
import type {
  WorkflowRunStatus,
  WorkflowTriggerType,
  WorkflowSubjectType,
} from '../types.js';

// ---------------------------------------------------------------------------
// Admin workflow oversight API client (issue #143).
//
// Mirrors the Phase 5 admin control-plane endpoints exactly:
//   GET  /admin/workflows/stats          (Admin + system_settings:read)
//   GET  /admin/workflows                 (Admin + system_settings:read)
//   GET  /admin/workflow-runs             (Admin + jobs:read)
//   POST /admin/workflows/:id/disable     (Admin + system_settings:write)
//   POST /admin/workflow-runs/:id/cancel  (Admin + jobs:write)
//
// `api.get`/`api.post` already unwrap the TransformInterceptor `{ data }`
// envelope, so these return the service payloads directly.
// ---------------------------------------------------------------------------

/** KPI strip aggregate for `GET /admin/workflows/stats`. */
/**
 * The admin workflow stats shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowStats {
  windowDays: number;
  runsLast7Days: number;
  itemsActioned: number;
  failures: number;
  currentlyRunning: number;
}

/** Latest-run summary embedded in each oversight-table row. */
/**
 * The admin workflow last run shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowLastRun {
  status: WorkflowRunStatus;
  triggerType: WorkflowTriggerType;
  createdAt: string;
  finishedAt: string | null;
  matchedCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
}

/** A single row of `GET /admin/workflows`. */
/**
 * The admin workflow list item shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowListItem {
  id: string;
  circle: { id: string; name: string } | null;
  name: string;
  subjectType: WorkflowSubjectType;
  trigger: WorkflowTriggerType;
  enabled: boolean;
  cronExpression: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string; displayName: string | null } | null;
  lastRun: AdminWorkflowLastRun | null;
  totals: { runs: number; matched: number; actioned: number };
}

/** Shared pagination meta shape used by both admin list endpoints. */
/**
 * The admin workflows meta shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowsMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * The admin workflows response shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowsResponse {
  items: AdminWorkflowListItem[];
  meta: AdminWorkflowsMeta;
}

/** A single row of `GET /admin/workflow-runs`. */
/**
 * The admin workflow run shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowRun {
  id: string;
  workflowId: string;
  workflow: { id: string; name: string } | null;
  circleId: string;
  circle: { id: string; name: string } | null;
  status: WorkflowRunStatus;
  triggerType: WorkflowTriggerType;
  matchedCount: number;
  truncated: boolean;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  startedById: string | null;
  approvedById: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

/**
 * The admin workflow runs response shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowRunsResponse {
  items: AdminWorkflowRun[];
  meta: AdminWorkflowsMeta;
}

/**
 * The admin workflows query shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowsQuery {
  page?: number;
  pageSize?: number;
  circleId?: string;
  trigger?: WorkflowTriggerType;
  enabled?: boolean;
}

/**
 * The admin workflow runs query shape.
 *
 * @stability experimental
 */
export interface AdminWorkflowRunsQuery {
  page?: number;
  pageSize?: number;
  circleId?: string;
  workflowId?: string;
  status?: WorkflowRunStatus;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Reads the KPI strip aggregate (`GET /admin/workflows/stats`).
 *
 * @stability experimental
 */
export async function getAdminWorkflowStats(): Promise<AdminWorkflowStats> {
  return api.get<AdminWorkflowStats>('/admin/workflows/stats');
}

/**
 * Lists every workflow across every circle (`GET /admin/workflows`).
 *
 * @stability experimental
 */
export async function listAdminWorkflows(
  params: AdminWorkflowsQuery = {},
): Promise<AdminWorkflowsResponse> {
  const sp = new URLSearchParams();
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  if (params.circleId) sp.set('circleId', params.circleId);
  if (params.trigger) sp.set('trigger', params.trigger);
  if (params.enabled !== undefined) sp.set('enabled', String(params.enabled));
  const qs = sp.toString();
  return api.get<AdminWorkflowsResponse>(`/admin/workflows${qs ? `?${qs}` : ''}`);
}

/**
 * Lists every run across every circle (`GET /admin/workflow-runs`).
 *
 * @stability experimental
 */
export async function listAdminWorkflowRuns(
  params: AdminWorkflowRunsQuery = {},
): Promise<AdminWorkflowRunsResponse> {
  const sp = new URLSearchParams();
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  if (params.circleId) sp.set('circleId', params.circleId);
  if (params.workflowId) sp.set('workflowId', params.workflowId);
  if (params.status) sp.set('status', params.status);
  const qs = sp.toString();
  return api.get<AdminWorkflowRunsResponse>(
    `/admin/workflow-runs${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Force-disables a workflow regardless of circle membership.
 *
 * @stability experimental
 */
export async function disableAdminWorkflow(
  id: string,
): Promise<{ id: string; enabled: boolean }> {
  return api.post<{ id: string; enabled: boolean }>(
    `/admin/workflows/${id}/disable`,
  );
}

/**
 * Cancels a runaway run app-wide.
 *
 * @stability experimental
 */
export async function cancelAdminWorkflowRun(
  id: string,
): Promise<{ id: string; status: WorkflowRunStatus }> {
  return api.post<{ id: string; status: WorkflowRunStatus }>(
    `/admin/workflow-runs/${id}/cancel`,
  );
}

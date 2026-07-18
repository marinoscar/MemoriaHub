import { api } from './api';
import type {
  Workflow,
  WorkflowListResponse,
  WorkflowsQueryParams,
  CreateWorkflowDto,
  UpdateWorkflowDto,
  WorkflowPreviewRequest,
  WorkflowPreviewResponse,
  WorkflowSubjectsResponse,
  CreateRunDto,
  RunsQueryParams,
  RunItemsQueryParams,
  WorkflowRunStatus,
  WorkflowRunListResponse,
  WorkflowRunDetail,
  WorkflowRunItemsResponse,
  ApproveRunDto,
} from '../types/workflows';

// ---------------------------------------------------------------------------
// Workflow CRUD
// ---------------------------------------------------------------------------

export async function listWorkflows(
  params: WorkflowsQueryParams,
): Promise<WorkflowListResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('circleId', params.circleId);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));
  return api.get<WorkflowListResponse>(`/workflows?${searchParams.toString()}`);
}

export async function getWorkflow(id: string): Promise<Workflow> {
  return api.get<Workflow>(`/workflows/${id}`);
}

export async function createWorkflow(dto: CreateWorkflowDto): Promise<Workflow> {
  return api.post<Workflow>('/workflows', dto);
}

export async function updateWorkflow(
  id: string,
  dto: UpdateWorkflowDto,
): Promise<Workflow> {
  return api.patch<Workflow>(`/workflows/${id}`, dto);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await api.delete<void>(`/workflows/${id}`);
}

// ---------------------------------------------------------------------------
// Preview + subject registry
// ---------------------------------------------------------------------------

export async function previewWorkflow(
  body: WorkflowPreviewRequest,
): Promise<WorkflowPreviewResponse> {
  return api.post<WorkflowPreviewResponse>('/workflows/preview', body);
}

export async function getWorkflowSubjects(): Promise<WorkflowSubjectsResponse> {
  return api.get<WorkflowSubjectsResponse>('/workflows/subjects');
}

// ---------------------------------------------------------------------------
// Runs — note the TWO base paths:
//   - `/workflows/:id/runs`   (list runs for a workflow)
//   - `/workflow-runs/:id`    (run detail / items / approve / cancel)
// ---------------------------------------------------------------------------

export async function runWorkflow(
  id: string,
  body?: CreateRunDto,
): Promise<{ runId: string; status: WorkflowRunStatus }> {
  return api.post<{ runId: string; status: WorkflowRunStatus }>(
    `/workflows/${id}/run`,
    body ?? {},
  );
}

export async function listWorkflowRuns(
  id: string,
  params?: RunsQueryParams,
): Promise<WorkflowRunListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString();
  return api.get<WorkflowRunListResponse>(
    `/workflows/${id}/runs${qs ? `?${qs}` : ''}`,
  );
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return api.get<WorkflowRunDetail>(`/workflow-runs/${runId}`);
}

export async function listWorkflowRunItems(
  runId: string,
  params?: RunItemsQueryParams,
): Promise<WorkflowRunItemsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString();
  return api.get<WorkflowRunItemsResponse>(
    `/workflow-runs/${runId}/items${qs ? `?${qs}` : ''}`,
  );
}

export async function approveWorkflowRun(
  runId: string,
  body: ApproveRunDto,
): Promise<{ runId: string; status: WorkflowRunStatus }> {
  return api.post<{ runId: string; status: WorkflowRunStatus }>(
    `/workflow-runs/${runId}/approve`,
    body,
  );
}

export async function cancelWorkflowRun(
  runId: string,
): Promise<{ runId: string; status: WorkflowRunStatus }> {
  return api.post<{ runId: string; status: WorkflowRunStatus }>(
    `/workflow-runs/${runId}/cancel`,
  );
}

// ---------------------------------------------------------------------------
// Client-side composite
// ---------------------------------------------------------------------------

/**
 * Duplicate a workflow. There is NO server duplicate endpoint — this is a
 * client-side composite that calls `createWorkflow` with a copied definition,
 * a "Copy of …" name, and `enabled: false` so the clone never runs until the
 * user reviews it.
 */
export async function duplicateWorkflow(source: Workflow): Promise<Workflow> {
  return createWorkflow({
    circleId: source.circleId,
    name: `Copy of ${source.name}`,
    description: source.description,
    enabled: false,
    trigger: source.trigger,
    cronExpression: source.cronExpression,
    definition: source.definition,
  });
}

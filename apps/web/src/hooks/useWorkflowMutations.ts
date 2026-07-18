import { useState, useCallback } from 'react';
import type {
  Workflow,
  CreateWorkflowDto,
  UpdateWorkflowDto,
  CreateRunDto,
  ApproveRunDto,
  WorkflowRunStatus,
} from '../types/workflows';
import {
  createWorkflow as createWorkflowApi,
  updateWorkflow as updateWorkflowApi,
  deleteWorkflow as deleteWorkflowApi,
  runWorkflow as runWorkflowApi,
  approveWorkflowRun as approveWorkflowRunApi,
  cancelWorkflowRun as cancelWorkflowRunApi,
  duplicateWorkflow as duplicateWorkflowApi,
} from '../services/workflows';

type RunResult = { runId: string; status: WorkflowRunStatus };

interface UseWorkflowMutationsResult {
  createWorkflow: (dto: CreateWorkflowDto) => Promise<Workflow>;
  updateWorkflow: (id: string, dto: UpdateWorkflowDto) => Promise<Workflow>;
  deleteWorkflow: (id: string) => Promise<void>;
  runWorkflow: (id: string, body?: CreateRunDto) => Promise<RunResult>;
  approveRun: (runId: string, body: ApproveRunDto) => Promise<RunResult>;
  cancelRun: (runId: string) => Promise<RunResult>;
  duplicateWorkflow: (source: Workflow) => Promise<Workflow>;
  setEnabled: (id: string, enabled: boolean) => Promise<Workflow>;
  isSaving: boolean;
  error: string | null;
}

export function useWorkflowMutations(): UseWorkflowMutationsResult {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(fn: () => Promise<T>, fallback: string): Promise<T> => {
      setIsSaving(true);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : fallback;
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  const createWorkflow = useCallback(
    (dto: CreateWorkflowDto) =>
      run(() => createWorkflowApi(dto), 'Failed to create workflow'),
    [run],
  );

  const updateWorkflow = useCallback(
    (id: string, dto: UpdateWorkflowDto) =>
      run(() => updateWorkflowApi(id, dto), 'Failed to update workflow'),
    [run],
  );

  const deleteWorkflow = useCallback(
    (id: string) => run(() => deleteWorkflowApi(id), 'Failed to delete workflow'),
    [run],
  );

  const runWorkflow = useCallback(
    (id: string, body?: CreateRunDto) =>
      run(() => runWorkflowApi(id, body), 'Failed to run workflow'),
    [run],
  );

  const approveRun = useCallback(
    (runId: string, body: ApproveRunDto) =>
      run(() => approveWorkflowRunApi(runId, body), 'Failed to approve run'),
    [run],
  );

  const cancelRun = useCallback(
    (runId: string) =>
      run(() => cancelWorkflowRunApi(runId), 'Failed to cancel run'),
    [run],
  );

  const duplicateWorkflow = useCallback(
    (source: Workflow) =>
      run(() => duplicateWorkflowApi(source), 'Failed to duplicate workflow'),
    [run],
  );

  const setEnabled = useCallback(
    (id: string, enabled: boolean) =>
      run(() => updateWorkflowApi(id, { enabled }), 'Failed to update workflow'),
    [run],
  );

  return {
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
    runWorkflow,
    approveRun,
    cancelRun,
    duplicateWorkflow,
    setEnabled,
    isSaving,
    error,
  };
}

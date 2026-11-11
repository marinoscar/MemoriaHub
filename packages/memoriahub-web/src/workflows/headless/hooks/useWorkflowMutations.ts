import { useState, useCallback } from 'react';
import type {
  Workflow,
  CreateWorkflowDto,
  UpdateWorkflowDto,
  CreateRunDto,
  ApproveRunDto,
  WorkflowRunStatus,
} from '../types.js';
import {
  createWorkflow as createWorkflowApi,
  updateWorkflow as updateWorkflowApi,
  deleteWorkflow as deleteWorkflowApi,
  runWorkflow as runWorkflowApi,
  approveWorkflowRun as approveWorkflowRunApi,
  cancelWorkflowRun as cancelWorkflowRunApi,
  duplicateWorkflow as duplicateWorkflowApi,
} from '../services/workflows.js';
import { useIsMounted } from '../../../core/headless/index.js';

/**
 * Run Result.
 *
 * @stability experimental
 */
export type RunResult = { runId: string; status: WorkflowRunStatus };

/**
 * Use Workflow Mutations Result.
 *
 * @stability experimental
 */
export interface UseWorkflowMutationsResult {
  /** The `createWorkflow`. */
  createWorkflow: (dto: CreateWorkflowDto) => Promise<Workflow>;
  /** The `updateWorkflow`. */
  updateWorkflow: (id: string, dto: UpdateWorkflowDto) => Promise<Workflow>;
  /** The `deleteWorkflow`. */
  deleteWorkflow: (id: string) => Promise<void>;
  /** The `runWorkflow`. */
  runWorkflow: (id: string, body?: CreateRunDto) => Promise<RunResult>;
  /** The `approveRun`. */
  approveRun: (runId: string, body: ApproveRunDto) => Promise<RunResult>;
  /** The `cancelRun`. */
  cancelRun: (runId: string) => Promise<RunResult>;
  /** The `duplicateWorkflow`. */
  duplicateWorkflow: (source: Workflow) => Promise<Workflow>;
  /** The `setEnabled`. */
  setEnabled: (id: string, enabled: boolean) => Promise<Workflow>;
  /** The `isSaving`. */
  isSaving: boolean;
  /** The `error`. */
  error: string | null;
}

/**
 * Use Workflow Mutations.
 *
 * @stability experimental
 */
export function useWorkflowMutations(): UseWorkflowMutationsResult {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const run = useCallback(
    async <T>(fn: () => Promise<T>, fallback: string): Promise<T> => {
      setIsSaving(true);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : fallback;
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
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

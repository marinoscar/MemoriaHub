import { defineExecutor } from './define.js';

/** `workflow_execute_batch`: wraps ./compute/workflow-execute-batch.ts. */
export const workflowExecuteBatchExecutor = defineExecutor({
  type: 'workflow_execute_batch',
  input: 'none',
  load: () => import('./compute/workflow-execute-batch.js'),
});

import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { MemoriahubJobHandler } from '../../ports/index.js';
import type { WorkflowActionHandlerRegistry, WorkflowActionExecutor } from '../actions/workflow-action.executor.js';
import type { WorkflowsModule } from '../workflows.module.js';

// =============================================================================
// describeWorkflowsSliceConformance (RETRO-J9, #622)
// =============================================================================
//
// The executable proof of the workflows slice's host contract, independent of the host that binds it. Test-runner
// neutral.
//
//   job types   the five handlers register under their permanent type strings, each with a label and its
//               execution profile; only `workflow_execute_batch` is node-claimable (the node pair), the rest are
//               server-only;
//   payloads    a handler given a malformed payload does nothing and does not throw (a bad row never fails a
//               worker);
//   guards      a pending evaluate or execute-batch job of an active run cannot be deleted, one of a finished
//               run can;
//   executor    an action type with no registered handler is a failed outcome, a registered handler is called,
//               a handler that throws is a failed outcome rather than an exception.
// =============================================================================

/**
 * The permanent type strings and profiles of the slice's handlers.
 *
 * @stability experimental
 */
export const WORKFLOW_JOB_TYPES = {
  workflow_evaluate: { maxRuntimeMs: 900_000, maxAttempts: 3 },
  workflow_evaluate_item: { maxRuntimeMs: 60_000, maxAttempts: 3 },
  workflow_execute_batch: { maxRuntimeMs: 600_000, maxAttempts: 3 },
  'workflows.schedule_tick': { maxRuntimeMs: 300_000, maxAttempts: 3 },
  'workflows.micro_run_finalize': { maxRuntimeMs: 300_000, maxAttempts: 3 },
} as const;

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface WorkflowsSliceUnderTest {
  /** The handlers the slice registered with the jobs port, by type. */
  handlers: ReadonlyMap<string, MemoriahubJobHandler>;
  /** The action handler registry. */
  actionHandlers: WorkflowActionHandlerRegistry;
  /** The action executor. */
  executor: WorkflowActionExecutor;
  /** Stores a run in the database the slice reads, in the given status. */
  seedRun(runId: string, status: string): void;
}

/**
 * How the kit builds the slice.
 *
 * @stability experimental
 */
export interface WorkflowsSliceConformanceOptions {
  /** A name for the report. */
  name: string;
  /** Builds the slice over fresh ports and an empty database. */
  create(): Promise<WorkflowsSliceUnderTest>;
}

/** The slice module type, for a host that wants to name it. */
export type WorkflowsModuleType = typeof WorkflowsModule;

const job = (type: string, payload: unknown, status = 'pending') =>
  ({ id: 'job-1', type, attempts: 1, payload, status, subjectType: 'circle', subjectId: 'circle-1' }) as never;

/**
 * Declares the slice's conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - how to build the slice.
 * @stability experimental
 */
export function describeWorkflowsSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: WorkflowsSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`workflows slice conformance (${options.name})`, () => {
    describe('job types', () => {
      it('registers the five handlers under their permanent types, labels and profiles', async () => {
        const slice = await options.create();
        expect([...slice.handlers.keys()].sort()).toEqual(Object.keys(WORKFLOW_JOB_TYPES).sort());
        for (const [type, profile] of Object.entries(WORKFLOW_JOB_TYPES)) {
          const handler = slice.handlers.get(type)!;
          expect(typeof handler.label).toBe('string');
          expect(handler.profile).toEqual(profile);
        }
      });

      it('makes only workflow_execute_batch node-claimable, and never AI', async () => {
        const slice = await options.create();
        for (const [type, handler] of slice.handlers) {
          const nodeEligible = handler.nodeResultSchema !== undefined && handler.persistNodeResult !== undefined;
          expect(nodeEligible).toBe(type === 'workflow_execute_batch');
          expect(handler.usesAi).not.toBe(true);
        }
      });
    });

    describe('payloads', () => {
      it('does nothing, without throwing, for a malformed payload', async () => {
        const slice = await options.create();
        for (const type of ['workflow_evaluate', 'workflow_evaluate_item', 'workflow_execute_batch']) {
          await expect(slice.handlers.get(type)!.process(job(type, { nothing: true }, 'running'))).resolves.toBeUndefined();
        }
      });
    });

    describe('guards', () => {
      it('refuses to delete a pending execute-batch job of a running run, and allows it once the run is finished', async () => {
        const slice = await options.create();
        slice.seedRun('run-active', 'running');
        slice.seedRun('run-done', 'completed');
        const handler = slice.handlers.get('workflow_execute_batch')!;
        const veto = await handler.canDelete!(job('workflow_execute_batch', { runId: 'run-active', itemIds: [] }));
        expect(typeof veto === 'string' && veto.includes('run-active')).toBe(true);
        expect(await handler.canDelete!(job('workflow_execute_batch', { runId: 'run-done', itemIds: [] }))).toBeNull();
      });

      it('refuses to delete a pending evaluate job of an evaluating run', async () => {
        const slice = await options.create();
        slice.seedRun('run-eval', 'evaluating');
        const handler = slice.handlers.get('workflow_evaluate')!;
        const veto = await handler.canDelete!(job('workflow_evaluate', { runId: 'run-eval' }));
        expect(typeof veto === 'string' && veto.includes('run-eval')).toBe(true);
      });
    });

    describe('executor', () => {
      const ctx = { runId: 'run-1', circleId: 'circle-1', actorUserId: 'user-1', actorPermissions: [], handledGroups: new Set<string>() };

      it('fails an action type nobody applies', async () => {
        const slice = await options.create();
        const outcome = await slice.executor.execute({ type: 'conformance_unknown', params: {} }, { id: 'item-1' }, ctx);
        expect(outcome.status).toBe('failed');
      });

      it('dispatches to the registered handler and turns a throw into a failed outcome', async () => {
        const slice = await options.create();
        slice.actionHandlers.register({
          types: ['conformance_ok', 'conformance_throws'],
          execute: async (action) => {
            if (action.type === 'conformance_throws') throw new Error('boom');
            return { status: 'applied' };
          },
        });
        expect((await slice.executor.execute({ type: 'conformance_ok', params: {} }, { id: 'item-1' }, ctx)).status).toBe('applied');
        const failed = await slice.executor.execute({ type: 'conformance_throws', params: {} }, { id: 'item-1' }, ctx);
        expect(failed).toEqual({ status: 'failed', detail: 'boom' });
      });
    });
  });
}

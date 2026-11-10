import type { ReviewRunAction } from '@marinoscar/memoriahub-contract/review-runs';

import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { ReviewRunEvaluateHandler } from '../review-run-evaluate.handler.js';
import type { ReviewRunExecuteBatchHandler } from '../review-run-execute-batch.handler.js';
import type { ReviewRunSubjectRegistry } from '../review-run-subject.registry.js';
import type { ReviewRunSubjectStrategy } from '../review-run-subject.strategy.js';
import type { ReviewRunService } from '../review-run.service.js';

// =============================================================================
// describeReviewRunsSliceConformance (RETRO-J9, #622)
// =============================================================================
//
// The executable proof of the shared review-run engine, independent of the queue it serves. It drives a run
// with a scripted strategy, so the rules hold for every strategy a host registers. Test-runner neutral.
//
//   creation    a subject with no strategy and an action the strategy does not support are 400s; a second run of
//               the SAME queue and circle while one is active is a 409 (a different queue is not); trashing needs
//               `media:delete` on top of the circle role;
//   lifecycle   evaluate materializes the matched set and fans out batches; zero matches completes the run;
//               a skipped subject never fails the batch; a failed one finishes the run `completed_with_errors`;
//               the run finalizes when no row remains matched or processing (not on counter equality);
//   cancel      a cancelled run stops later batches and an already finished run cannot be cancelled;
//   registry    the burst, duplicate and location strategies are registered by their owners, never by the engine.
// =============================================================================

/**
 * A scripted subject for the engine: which subjects exist, which fail and which skip.
 *
 * @stability experimental
 */
export interface ScriptedSubjects {
  /** The subject ids the strategy matches, in order. */
  matched: string[];
  /** Subject ids whose execution skips. */
  skip?: string[];
  /** Subject ids whose execution throws. */
  fail?: string[];
}

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface ReviewRunsSliceUnderTest {
  /** The run service. */
  service: ReviewRunService;
  /** The evaluate handler. */
  evaluate: ReviewRunEvaluateHandler;
  /** The execute-batch handler. */
  execute: ReviewRunExecuteBatchHandler;
  /** The strategy registry (empty). */
  registry: ReviewRunSubjectRegistry;
  /** A user who is an editor of `circle-1` and holds `media:write` only. */
  editor: { userId: string; perms: string[] };
  /** The same user with `media:delete` added. */
  deleter: { userId: string; perms: string[] };
  /** The jobs queued so far (type, payload). */
  queuedJobs(): Array<{ type: string; payload: Record<string, unknown> }> | Promise<Array<{ type: string; payload: Record<string, unknown> }>>;
  /** The run row, read back. */
  readRun(runId: string): Promise<Record<string, any> | null> | Record<string, any> | null;
  /** Job types registered with the queue. */
  registeredJobTypes(): string[];
}

/**
 * Options of {@link describeReviewRunsSliceConformance}.
 *
 * @stability experimental
 */
export interface ReviewRunsSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): ReviewRunsSliceUnderTest | Promise<ReviewRunsSliceUnderTest>;
}

function scriptedStrategy(
  subject: 'burst_group' | 'duplicate_group' | 'location_suggestion',
  column: ReviewRunSubjectStrategy['subjectColumn'],
  actions: readonly ReviewRunAction[],
  script: ScriptedSubjects,
): ReviewRunSubjectStrategy {
  return {
    subject,
    subjectColumn: column,
    supportedActions: actions,
    async evaluatePage(_run, cursor, pageSize) {
      const from = cursor ? (cursor['offset'] as number) : 0;
      const ids = script.matched.slice(from, from + pageSize);
      return { subjectIds: ids, nextCursor: ids.length === 0 ? null : { offset: from + ids.length } };
    },
    async executeItem(_run, subjectId) {
      if (script.fail?.includes(subjectId)) throw new Error(`cannot resolve ${subjectId}`);
      return script.skip?.includes(subjectId) ? 'skipped' : 'applied';
    },
    async hydrateItems() {
      return new Map();
    },
  };
}

/**
 * Runs the review-runs slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeReviewRunsSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: ReviewRunsSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;
  const base = { circleId: 'circle-1', threshold: 80 };

  async function drain(slice: ReviewRunsSliceUnderTest, runId: string): Promise<void> {
    await slice.evaluate.process({ id: 'job-eval', attempts: 1, payload: { runId } });
    for (const job of (await slice.queuedJobs()).filter((j) => j.type === 'review_run_execute_batch')) {
      await slice.execute.process({ id: 'job-batch', attempts: 1, payload: job.payload });
    }
  }

  describe(`review-runs slice conformance: ${options.name}`, () => {
    it('queues the engine jobs and registers the two deprecated shim types', async () => {
      const slice = await options.create();
      const types = slice.registeredJobTypes();
      for (const type of ['review_run_evaluate', 'review_run_execute_batch', 'location_suggestion_run_evaluate', 'location_suggestion_run_execute_batch']) {
        expect(types.includes(type)).toBe(true);
      }
    });

    it('refuses a subject with no registered strategy', async () => {
      const slice = await options.create();
      await expect(
        slice.service.createRun({ ...base, subjectType: 'burst_group', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms }),
      ).rejects.toThrow(/Unknown review-run subject type/);
    });

    it('refuses an action the strategy does not support', async () => {
      const slice = await options.create();
      slice.registry.register(scriptedStrategy('location_suggestion', 'locationSuggestionId', ['accept', 'reject'], { matched: [] }));
      await expect(
        slice.service.createRun({ ...base, subjectType: 'location_suggestion', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms }),
      ).rejects.toThrow(/not supported/);
    });

    it('needs media:delete to trash, and refuses a second active run of the same queue only', async () => {
      const slice = await options.create();
      slice.registry.register(scriptedStrategy('burst_group', 'burstGroupId', ['resolve_archive', 'resolve_trash', 'dismiss'], { matched: ['b1'] }));
      slice.registry.register(scriptedStrategy('duplicate_group', 'duplicateGroupId', ['resolve_archive', 'dismiss'], { matched: ['d1'] }));

      await expect(
        slice.service.createRun({ ...base, subjectType: 'burst_group', action: 'resolve_trash', userId: slice.editor.userId, perms: slice.editor.perms }),
      ).rejects.toThrow(/media:delete/);

      const first = await slice.service.createRun({ ...base, subjectType: 'burst_group', action: 'resolve_trash', userId: slice.deleter.userId, perms: slice.deleter.perms });
      expect(first.status).toBe('evaluating');
      await expect(
        slice.service.createRun({ ...base, subjectType: 'burst_group', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms }),
      ).rejects.toThrow(/already in progress/);
      const other = await slice.service.createRun({ ...base, subjectType: 'duplicate_group', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms });
      expect(other.status).toBe('evaluating');
    });

    it('completes a run with no matches without queueing a batch', async () => {
      const slice = await options.create();
      slice.registry.register(scriptedStrategy('burst_group', 'burstGroupId', ['dismiss'], { matched: [] }));
      const run = await slice.service.createRun({ ...base, subjectType: 'burst_group', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms });

      await drain(slice, run.id);

      expect((await slice.readRun(run.id))?.['status']).toBe('completed');
      expect((await slice.queuedJobs()).filter((j) => j.type === 'review_run_execute_batch')).toEqual([]);
    });

    it('finalizes completed_with_errors, counting applied, skipped and failed subjects', async () => {
      const slice = await options.create();
      slice.registry.register(
        scriptedStrategy('duplicate_group', 'duplicateGroupId', ['dismiss'], { matched: ['d1', 'd2', 'd3', 'd4'], skip: ['d2'], fail: ['d3'] }),
      );
      const run = await slice.service.createRun({ ...base, subjectType: 'duplicate_group', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms });

      await drain(slice, run.id);

      const row = await slice.readRun(run.id);
      expect(row).toMatchObject({ status: 'completed_with_errors', matchedCount: 4, processedCount: 4, succeededCount: 2, skippedCount: 1, failedCount: 1 });
    });

    it('stops a cancelled run before its next batch and refuses to cancel a finished one', async () => {
      const slice = await options.create();
      slice.registry.register(scriptedStrategy('burst_group', 'burstGroupId', ['dismiss'], { matched: ['b1', 'b2'] }));
      const run = await slice.service.createRun({ ...base, subjectType: 'burst_group', action: 'dismiss', userId: slice.editor.userId, perms: slice.editor.perms });
      await slice.evaluate.process({ id: 'job-eval', attempts: 1, payload: { runId: run.id } });

      await slice.service.cancelRun(run.id, slice.editor.userId, slice.editor.perms);
      for (const job of (await slice.queuedJobs()).filter((j) => j.type === 'review_run_execute_batch')) {
        await slice.execute.process({ id: 'job-batch', attempts: 1, payload: job.payload });
      }

      expect((await slice.readRun(run.id))?.['status']).toBe('cancelled');
      expect((await slice.readRun(run.id))?.['processedCount']).toBe(0);
      await expect(slice.service.cancelRun(run.id, slice.editor.userId, slice.editor.perms)).rejects.toThrow(/already finished/);
    });
  });
}

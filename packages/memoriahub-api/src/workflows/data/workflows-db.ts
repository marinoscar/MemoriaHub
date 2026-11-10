import type { MemoriahubPrismaClientLike } from '../../ports/index.js';
import type { MediaDelegate } from '../../media/index.js';

// =============================================================================
// The workflows slice's view of the database client
// =============================================================================
//
// The slice never imports a generated client. It narrows `MEMORIAHUB_PRISMA` with the delegates it reads and
// writes; a delegate is structural and loose on purpose (the rows are the domain's `memoriahub-db` schema,
// which the host types for its own callers).
// =============================================================================

/**
 * A model delegate with `groupBy` and `aggregate`.
 *
 * @stability experimental
 */
export interface WorkflowDelegate extends MediaDelegate {
  /** Aggregates rows. */
  aggregate(args: any): Promise<any>;
}

/**
 * The model delegates the workflows slice uses.
 *
 * @stability experimental
 */
export interface WorkflowsModels {
  /** The workflows. */
  workflow: WorkflowDelegate;
  /** The runs. */
  workflowRun: WorkflowDelegate;
  /** The run items. */
  workflowRunItem: WorkflowDelegate;
  /** The media items the conditions select. */
  mediaItem: MediaDelegate;
  /** The per-item tag status (settlement). */
  mediaTagStatus: MediaDelegate;
  /** The per-item face status (settlement). */
  mediaFaceStatus: MediaDelegate;
  /** The location suggestions (settlement). */
  locationSuggestion: MediaDelegate;
  /** The queue rows (in-flight producers of an item). */
  job: MediaDelegate;
  /** The audit trail. */
  auditEvent: MediaDelegate;
  /** The users (names of a run's actors). */
  user: MediaDelegate;
}

/**
 * The database port narrowed to the workflows slice's delegates.
 *
 * @stability experimental
 */
export type WorkflowsDb = MemoriahubPrismaClientLike & WorkflowsModels;

/**
 * A transaction client of {@link WorkflowsDb}.
 *
 * @stability experimental
 */
export type WorkflowsTx = WorkflowsModels & Pick<MemoriahubPrismaClientLike, '$queryRaw' | '$executeRaw'>;

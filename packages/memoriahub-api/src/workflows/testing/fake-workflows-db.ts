import type { WorkflowsDb } from '../data/workflows-db.js';
import { FakeMemoriahubPrisma } from '../../testing/index.js';

type Row = Record<string, any>;

/** A table that holds rows by id and answers the lookups the workflows slice's guards make; everything else is empty. */
class FakeTable {
  readonly rows = new Map<string, Row>();

  async findUnique(args: { where: Row }): Promise<Row | null> {
    const id = args.where['id'];
    return typeof id === 'string' ? ({ ...(this.rows.get(id) ?? null) } as Row | null) : null;
  }

  async findFirst(): Promise<Row | null> {
    return null;
  }

  async findMany(): Promise<Row[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }

  async create(args: { data: Row }): Promise<Row> {
    return { id: 'fake', ...args.data };
  }

  async createMany(): Promise<{ count: number }> {
    return { count: 0 };
  }

  async update(args: { data: Row }): Promise<Row> {
    return { ...args.data };
  }

  async updateMany(): Promise<{ count: number }> {
    return { count: 0 };
  }

  async deleteMany(): Promise<{ count: number }> {
    return { count: 0 };
  }

  async groupBy(): Promise<Row[]> {
    return [];
  }

  async aggregate(): Promise<Row> {
    return {};
  }
}

/**
 * An in-memory database for the workflows slice: every model answers empty except `workflowRun`, whose rows a
 * test seeds with {@link FakeWorkflowsDb.seedRun}. Enough to boot the module and prove the guards of the job
 * handlers; the behaviour of a run is the slice's unit specs' job.
 *
 * @stability experimental
 */
export class FakeWorkflowsDb extends FakeMemoriahubPrisma {
  readonly workflow = new FakeTable();

  readonly workflowRun = new FakeTable();

  readonly workflowRunItem = new FakeTable();

  readonly mediaItem = new FakeTable();

  readonly mediaTagStatus = new FakeTable();

  readonly mediaFaceStatus = new FakeTable();

  readonly locationSuggestion = new FakeTable();

  readonly job = new FakeTable();

  readonly auditEvent = new FakeTable();

  readonly user = new FakeTable();

  /**
   * Stores a run.
   *
   * @param run - the run row (an `id` and a `status` at least).
   */
  seedRun(run: { id: string; status: string } & Row): void {
    this.workflowRun.rows.set(run.id, run);
  }

  /** The database seen as the slice's narrowed client. */
  asDb(): WorkflowsDb {
    return this as unknown as WorkflowsDb;
  }
}

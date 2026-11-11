import type { WorkflowsDb } from '../data/workflows-db.js';
import type { MediaDelegate } from '../../media/index.js';
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
  readonly workflow: MediaDelegate & any = new FakeTable();

  readonly workflowRun: MediaDelegate & any = new FakeTable();

  readonly workflowRunItem: MediaDelegate & any = new FakeTable();

  readonly mediaItem: MediaDelegate & any = new FakeTable();

  readonly mediaTagStatus: MediaDelegate & any = new FakeTable();

  readonly mediaFaceStatus: MediaDelegate & any = new FakeTable();

  readonly locationSuggestion: MediaDelegate & any = new FakeTable();

  readonly job: MediaDelegate & any = new FakeTable();

  readonly auditEvent: MediaDelegate & any = new FakeTable();

  readonly user: MediaDelegate & any = new FakeTable();

  /**
   * Stores a run.
   *
   * @param run - the run row (an `id` and a `status` at least).
   */
  seedRun(run: { id: string; status: string; [column: string]: unknown }): void {
    (this.workflowRun as FakeTable).rows.set(run.id, run);
  }

  /** The database seen as the slice's narrowed client. */
  asDb(): WorkflowsDb {
    return this as unknown as WorkflowsDb;
  }
}

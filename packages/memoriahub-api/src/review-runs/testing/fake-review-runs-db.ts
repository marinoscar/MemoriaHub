import type { MediaDelegate } from '../../media/index.js';
import type { ReviewRunsDb } from '../data/review-runs-db.js';
import { FakeMemoriahubPrisma } from '../../testing/index.js';

type Row = Record<string, any>;

/** Does `value` satisfy the filter `cond` (equality, `in`, `not`, `lt`, `gte`)? */
function matchField(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ('in' in c && !(c['in'] as unknown[]).includes(value)) return false;
    if ('not' in c && value === c['not']) return false;
    if ('lt' in c && !((value as number) < (c['lt'] as number))) return false;
    if ('gte' in c && !((value as number) >= (c['gte'] as number))) return false;
    return true;
  }
  return value === cond;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => matchField(row[key], cond));
}

/** An in-memory delegate over an array of rows, supporting the calls the review-run engine makes. */
class FakeTable implements MediaDelegate {
  readonly rows: Row[] = [];

  private seq = 0;

  constructor(private readonly defaults: () => Row = () => ({})) {}

  async findMany(args: Row = {}): Promise<any[]> {
    let out = this.rows.filter((r) => matches(r, args['where']));
    if (typeof args['take'] === 'number') out = out.slice(0, args['take']);
    return out.map((r) => ({ ...r }));
  }

  async findFirst(args: Row = {}): Promise<any | null> {
    return (await this.findMany(args))[0] ?? null;
  }

  async findUnique(args: Row): Promise<any | null> {
    return (await this.findFirst({ where: args['where'] })) ?? null;
  }

  async findUniqueOrThrow(args: Row): Promise<any> {
    const row = await this.findUnique(args);
    if (!row) throw new Error('not found');
    return row;
  }

  async create(args: Row): Promise<any> {
    const row = { id: `fake-${++this.seq}`, createdAt: new Date(), updatedAt: new Date(), ...this.defaults(), ...args['data'] };
    this.rows.push(row);
    return { ...row };
  }

  async createMany(args: Row): Promise<{ count: number }> {
    let count = 0;
    for (const data of args['data'] as Row[]) {
      const exists =
        args['skipDuplicates'] === true &&
        this.rows.some((r) => r['runId'] === data['runId'] && ['burstGroupId', 'duplicateGroupId', 'locationSuggestionId'].some((k) => data[k] != null && r[k] === data[k]));
      if (exists) continue;
      await this.create({ data });
      count++;
    }
    return { count };
  }

  private apply(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && !(value instanceof Date) && 'increment' in (value as Row)) {
        row[key] = (row[key] ?? 0) + (value as Row)['increment'];
      } else {
        row[key] = value;
      }
    }
    row['updatedAt'] = new Date();
  }

  async update(args: Row): Promise<any> {
    const row = this.rows.find((r) => matches(r, args['where']));
    if (!row) throw new Error('not found');
    this.apply(row, args['data']);
    return { ...row };
  }

  async updateMany(args: Row): Promise<{ count: number }> {
    const hit = this.rows.filter((r) => matches(r, args['where']));
    for (const row of hit) this.apply(row, args['data']);
    return { count: hit.length };
  }

  async upsert(): Promise<any> {
    throw new Error('not supported by the fake');
  }

  async delete(args: Row): Promise<any> {
    const i = this.rows.findIndex((r) => matches(r, args['where']));
    if (i < 0) throw new Error('not found');
    return this.rows.splice(i, 1)[0];
  }

  async deleteMany(args: Row = {}): Promise<{ count: number }> {
    const keep = this.rows.filter((r) => !matches(r, args['where']));
    const count = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return { count };
  }

  async aggregate(): Promise<any> {
    throw new Error('aggregate is not supported by this fake');
  }

  async count(args: Row = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, args['where'])).length;
  }

  async groupBy(args: Row): Promise<any[]> {
    const field = (args['by'] as string[])[0] as string;
    const groups = new Map<unknown, number>();
    for (const r of this.rows.filter((row) => matches(row, args['where']))) groups.set(r[field], (groups.get(r[field]) ?? 0) + 1);
    return [...groups].map(([value, n]) => ({ [field]: value, _count: { _all: n } }));
  }
}

/**
 * An in-memory `MEMORIAHUB_PRISMA` with the three delegates the review-run engine uses. It supports the
 * filters, `createMany({ skipDuplicates })`, `{ increment }` updates and the single-field `groupBy` the engine
 * issues, nothing more; a slice test that needs a real database uses the host's `*.db.spec.ts` tier.
 *
 * @stability experimental
 */
export class FakeReviewRunsDb extends FakeMemoriahubPrisma {
  /** The `review_runs` rows. */
  readonly reviewRun: MediaDelegate = new FakeTable(() => ({
    matchedCount: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
  }));

  /** The `review_run_items` rows. */
  readonly reviewRunItem: MediaDelegate = new FakeTable(() => ({ burstGroupId: null, duplicateGroupId: null, locationSuggestionId: null, error: null }));

  /** The audit trail. */
  readonly auditEvent: MediaDelegate = new FakeTable();

  /** This fake as the slice's database type. */
  asDb(): ReviewRunsDb {
    return this as unknown as ReviewRunsDb;
  }
}

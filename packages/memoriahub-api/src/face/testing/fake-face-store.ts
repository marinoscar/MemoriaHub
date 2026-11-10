// =============================================================================
// An in-memory store behind the face slice's database delegates
// =============================================================================
//
// Just enough of the Prisma query language to run the face rules without a database: equality,
// `null`, `{ in }`, `{ not }` and `{ isEmpty }` on a field, plain `orderBy` and `take`. A real
// host runs the same rules against its database (`face-slice-conformance.db.spec.ts`).
// =============================================================================

/** One row of a fake table. @stability experimental */
export type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(value);
      if ('not' in cond) return cond.not === null ? value !== null && value !== undefined : value !== cond.not;
      if ('isEmpty' in cond) return (Array.isArray(value) && value.length === 0) === cond.isEmpty;
      return false;
    }
    return (value ?? null) === cond;
  });
}

/**
 * One in-memory model with the delegate calls the face slice makes.
 *
 * @stability experimental
 */
export class FakeFaceTable {
  /** The rows. */
  readonly rows: Row[] = [];

  private sequence = 0;

  /**
   * @param prefix - the prefix of generated ids.
   */
  constructor(private readonly prefix: string) {}

  /** Reads many rows. */
  async findMany(args: { where?: Row; orderBy?: Row; take?: number } = {}): Promise<Row[]> {
    let found = this.rows.filter((r) => matches(r, args.where));
    const order = args.orderBy ? Object.entries(args.orderBy)[0] : undefined;
    if (order) {
      const [field, dir] = order as [string, 'asc' | 'desc'];
      found = [...found].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    return (args.take !== undefined ? found.slice(0, args.take) : found).map((r) => ({ ...r }));
  }

  /** Reads the first matching row. */
  async findFirst(args: { where?: Row } = {}): Promise<Row | null> {
    return (await this.findMany(args))[0] ?? null;
  }

  /** Reads a row by id. */
  async findUnique(args: { where: Row }): Promise<Row | null> {
    return this.findFirst({ where: args.where });
  }

  /** Creates a row. */
  async create(args: { data: Row }): Promise<Row> {
    this.sequence += 1;
    const row = { id: `${this.prefix}-${this.sequence}`, ...args.data };
    this.rows.push(row);
    return { ...row };
  }

  /** Updates the matching rows. */
  async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
    const hit = this.rows.filter((r) => matches(r, args.where));
    hit.forEach((r) => Object.assign(r, args.data));
    return { count: hit.length };
  }

  /** Deletes the matching rows. */
  async deleteMany(args: { where?: Row } = {}): Promise<{ count: number }> {
    const keep = this.rows.filter((r) => !matches(r, args.where));
    const count = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return { count };
  }

  /** Creates or updates a row keyed by one unique field. */
  async upsert(args: { where: Row; create: Row; update: Row }): Promise<Row> {
    const existing = this.rows.find((r) => matches(r, args.where));
    if (existing) return { ...Object.assign(existing, args.update) };
    return this.create({ data: args.create });
  }

  /** Counts the matching rows. */
  async count(args: { where?: Row } = {}): Promise<number> {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
}

/**
 * The models of the face slice over in-memory tables.
 *
 * @stability experimental
 */
export interface FakeFaceStore {
  /** `faces`. */
  face: FakeFaceTable;
  /** `people`. */
  person: FakeFaceTable;
  /** `media_face_status`. */
  mediaFaceStatus: FakeFaceTable;
  /** `media_items`. */
  mediaItem: FakeFaceTable;
}

/**
 * Builds the tables and installs them on a fake database client.
 *
 * @param prisma - the fake database client (`FakeMemoriahubPrisma`).
 * @returns the tables, for a test to seed and read.
 * @stability experimental
 */
export function installFakeFaceStore(prisma: object): FakeFaceStore {
  const store: FakeFaceStore = {
    face: new FakeFaceTable('face'),
    person: new FakeFaceTable('person'),
    mediaFaceStatus: new FakeFaceTable('status'),
    mediaItem: new FakeFaceTable('item'),
  };
  Object.assign(prisma, store, {
    storageObject: new FakeFaceTable('object'),
    auditEvent: new FakeFaceTable('audit'),
  });
  return store;
}

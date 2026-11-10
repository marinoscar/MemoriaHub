// A hand-rolled stand-in for the database client of a slice: every model delegate is made on first
// use, every delegate method a spec touches is a `jest.fn()`, and `$transaction(fn)` runs the
// callback with the same client. Any model name works (`db.mediaItem`, `db.tagLabel`, ...).

const METHODS = ['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'groupBy'] as const;

type Delegate = Record<(typeof METHODS)[number], jest.Mock>;

function delegate(): Delegate {
  return Object.fromEntries(METHODS.map((method) => [method, jest.fn()])) as Delegate;
}

/** The mocked client: any property is a model delegate; `$queryRaw`, `$executeRaw` and `$transaction` are mocks. */
export type MockDb = Record<string, Delegate> & {
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
  runInOrg: jest.Mock;
};

/** Builds a fresh mocked client. */
export function mockDb(): MockDb {
  const models = new Map<string, Delegate>();
  const specials: Record<string, jest.Mock> = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
    runInOrg: jest.fn(),
  };
  const db: MockDb = new Proxy({} as MockDb, {
    get(_target, name: string) {
      if (name in specials) return specials[name];
      if (name === 'then') return undefined;
      let d = models.get(name);
      if (!d) {
        d = delegate();
        models.set(name, d);
      }
      return d;
    },
  });
  specials['$transaction']!.mockImplementation(async (fn: (tx: MockDb) => unknown) => fn(db));
  return db;
}

// A hand-rolled stand-in for the database client of the media slice: every delegate method a spec
// touches is a `jest.fn()`, and `$transaction(fn)` runs the callback with the same client.

const METHODS = ['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'groupBy'] as const;

type Delegate = Record<(typeof METHODS)[number], jest.Mock>;

function delegate(): Delegate {
  return Object.fromEntries(METHODS.map((method) => [method, jest.fn()])) as Delegate;
}

/** The mocked client. */
export interface MockMediaDb {
  mediaItem: Delegate;
  trashEmptyRun: Delegate;
  trashEmptyRunItem: Delegate;
  auditEvent: Delegate;
  $transaction: jest.Mock;
}

/** Builds a fresh mocked client. */
export function mockMediaDb(): MockMediaDb {
  const db: MockMediaDb = {
    mediaItem: delegate(),
    trashEmptyRun: delegate(),
    trashEmptyRunItem: delegate(),
    auditEvent: delegate(),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: MockMediaDb) => unknown) => fn(db));
  return db;
}

// A deep mock of the database client of the media slice: any `db.model.method` is a lazily created
// `jest.fn()` (returns `undefined` until a spec configures it), and `$transaction(fn)` runs the
// callback with the same client. It stands in for a generated client's deep mock without importing one.

type DeepMock = Record<string, any>;

/** Builds a fresh deep mock; `$transaction`, `$queryRaw`, `$executeRaw` and `runInOrg` are pre-wired. */
export function deepMockDb(): DeepMock {
  const cache = new Map<string, any>();
  const models = new Map<string, DeepMock>();
  const db: DeepMock = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop.startsWith('$') || prop === 'runInOrg') {
          if (!cache.has(prop)) cache.set(prop, jest.fn());
          return cache.get(prop);
        }
        if (!models.has(prop)) {
          const methods = new Map<string, jest.Mock>();
          models.set(
            prop,
            new Proxy(
              {},
              {
                get(_t, method: string | symbol) {
                  if (typeof method === 'symbol' || method === 'then') return undefined;
                  if (!methods.has(method)) methods.set(method, jest.fn());
                  return methods.get(method);
                },
              },
            ),
          );
        }
        return models.get(prop);
      },
    },
  );
  db['$transaction'].mockImplementation(async (arg: any) => {
    if (typeof arg === 'function') return arg(db);
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  });
  db['runInOrg'].mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(db));
  return db;
}

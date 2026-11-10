// =============================================================================
// A deep jest mock of the database port, for the slice specs that mock Prisma
// =============================================================================
//
// `createMockDb()` answers any `db.<model>.<method>` with a `jest.fn()` (created on first access and
// kept), so a spec seeds `(db.face.count as jest.Mock).mockResolvedValue(0)` exactly as it did against
// the web app's deep mock. `$transaction` hands the callback the same mock and `runInOrg` runs its
// callback on it. The mock is untyped on purpose: it stands in for whichever `*Db` a slice narrows.
// =============================================================================

export type MockDb = any;

const top = ['$queryRaw', '$executeRaw', '$transaction', 'runInOrg', '$connect', '$disconnect'];

/** Builds a fresh mock database client. */
export function createMockDb(): MockDb {
  const cache = new Map<string, unknown>();
  const mock: any = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (cache.has(prop)) return cache.get(prop);
        let value: unknown;
        if (top.includes(prop)) {
          value = jest.fn();
        } else {
          const methods = new Map<string, jest.Mock>();
          value = new Proxy(
            {},
            {
              get(_t, method: string) {
                if (typeof method !== 'string' || method === 'then') return undefined;
                if (!methods.has(method)) methods.set(method, jest.fn());
                return methods.get(method);
              },
            },
          );
        }
        cache.set(prop, value);
        return value;
      },
    },
  );
  mock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mock) : Promise.all(arg as unknown[]),
  );
  mock.runInOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(mock));
  return mock;
}

/** Resets every recorded call and implementation, then reinstalls the transaction helpers. */
export function resetMockDb(mock: MockDb): void {
  for (const name of top) mock[name].mockReset();
  mock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mock) : Promise.all(arg as unknown[]),
  );
  mock.runInOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(mock));
}

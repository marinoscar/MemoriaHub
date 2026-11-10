import type {
  MemoriahubPrismaClientLike,
  MemoriahubRunInOrgOptions,
  MemoriahubSql,
  MemoriahubTransactionOptions,
} from '../ports/index.js';

/**
 * A `MEMORIAHUB_PRISMA` with no database: raw queries return nothing, a transaction hands its callback
 * the same client, and `runInOrg` records the organization it ran under. A slice's unit test that needs
 * rows narrows this with its own delegates.
 *
 * @stability experimental
 */
export class FakeMemoriahubPrisma implements MemoriahubPrismaClientLike {
  /** The organizations `runInOrg` was called with, in order. */
  readonly orgScopes: Array<{ orgId: string; userId?: string }> = [];

  /** Raw queries. */
  async $queryRaw<T = unknown>(_query: TemplateStringsArray | MemoriahubSql, ..._values: unknown[]): Promise<T> {
    return [] as unknown as T;
  }

  /** Raw statements. */
  async $executeRaw(_query: TemplateStringsArray | MemoriahubSql, ..._values: unknown[]): Promise<number> {
    return 0;
  }

  /** Transactions. */
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: MemoriahubTransactionOptions): Promise<T>;
  $transaction<const Q extends readonly unknown[]>(
    queries: [...Q],
    options?: MemoriahubTransactionOptions,
  ): Promise<{ -readonly [K in keyof Q]: Awaited<Q[K]> }>;
  async $transaction(arg: unknown): Promise<unknown> {
    if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(this);
    return Promise.all(arg as unknown[]);
  }

  /** Org-scoped transaction. */
  async runInOrg<R>(orgId: string, fn: (tx: any) => Promise<R>, options?: MemoriahubRunInOrgOptions): Promise<R> {
    this.orgScopes.push({ orgId, ...(options?.userId !== undefined ? { userId: options.userId } : {}) });
    return fn(this);
  }
}

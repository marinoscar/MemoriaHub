// =============================================================================
// MEMORIAHUB_PRISMA: the database port (RETRO-J4, #610)
// =============================================================================
//
// The host's Prisma client, seen structurally. A slice never imports a generated
// client: it narrows this one with the delegates it uses (`Pick`-style row types)
// and builds raw SQL with the `Prisma` helper of `@marinoscar/memoriahub-api/core`.
//
// ROW-LEVEL SECURITY IS THE HOST'S. A write to an `org` table runs through
// `runInOrg`: one interactive transaction whose first statement sets the
// transaction-local organization scope (`set_config(..., true)`, never a session
// `SET`). A slice never uses a `forOrg` client inside `$transaction(async tx => ...)`.
// =============================================================================

/**
 * Injection token of {@link MemoriahubPrismaClientLike}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_PRISMA = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_PRISMA');

/**
 * A SQL fragment built by the `Prisma.sql` helper. Structural: any
 * `sql-template-tag` value (the one Prisma builds) satisfies it.
 *
 * @stability experimental
 */
export interface MemoriahubSql {
  /** The static pieces between the values. */
  readonly strings: ReadonlyArray<string>;
  /** The bound values, in order. */
  readonly values: ReadonlyArray<unknown>;
}

/**
 * Options of a transaction.
 *
 * @stability experimental
 */
export interface MemoriahubTransactionOptions {
  /** The longest the transaction may run, in milliseconds. */
  timeout?: number;
  /** The longest to wait for a connection before the transaction starts, in milliseconds. */
  maxWait?: number;
  /** The isolation level; the host default when absent. */
  isolationLevel?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
}

/**
 * Options of {@link MemoriahubPrismaClientLike.runInOrg}.
 *
 * @stability experimental
 */
export interface MemoriahubRunInOrgOptions extends MemoriahubTransactionOptions {
  /** The acting user (`app.user_id`), when the unit of work has one. */
  userId?: string;
}

/**
 * The part of a Prisma client every slice may rely on. Narrow it further with
 * the model delegates a slice uses.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubPrismaClientLike {
  /**
   * Runs a raw query and returns its rows.
   *
   * @param query - a template literal or a {@link MemoriahubSql}.
   * @param values - the bound values of a template literal.
   */
  $queryRaw<T = unknown>(query: TemplateStringsArray | MemoriahubSql, ...values: unknown[]): Promise<T>;

  /**
   * Runs a raw statement and returns the affected row count.
   *
   * @param query - a template literal or a {@link MemoriahubSql}.
   * @param values - the bound values of a template literal.
   */
  $executeRaw(query: TemplateStringsArray | MemoriahubSql, ...values: unknown[]): Promise<number>;

  /**
   * Runs a callback in a transaction.
   *
   * @param fn - receives the transaction client.
   * @param options - an optional timeout and isolation level.
   */
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: MemoriahubTransactionOptions): Promise<T>;

  /**
   * Runs several prepared queries in one transaction and returns their results, in order.
   *
   * @param queries - the queries (delegate calls not yet awaited).
   * @param options - an optional timeout and isolation level.
   */
  $transaction<const Q extends readonly unknown[]>(
    queries: [...Q],
    options?: MemoriahubTransactionOptions,
  ): Promise<{ -readonly [K in keyof Q]: Awaited<Q[K]> }>;

  /**
   * One interactive transaction in one organization's row-level-security scope: the
   * scope is the transaction's first statement. Use it for every write that touches an
   * `org` table and for a unit of work of more than one statement.
   *
   * @param orgId - the organization (a principal's active organization or a job's `orgId`, never request input).
   * @param fn - receives the plain transaction client.
   * @param options - the acting user, a timeout and an isolation level.
   */
  runInOrg<R>(orgId: string, fn: (tx: any) => Promise<R>, options?: MemoriahubRunInOrgOptions): Promise<R>;
}

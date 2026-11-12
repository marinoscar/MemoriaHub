// Row-level-security scope for real-database specs.
//
// The DB tier runs as an ordinary role that owns the tables (NOSUPERUSER NOBYPASSRLS), so the forced
// row-level security policies on the `org` tables apply to every statement a spec issues, exactly as they
// do to the API. A spec therefore seeds and reads through the same scope production code uses: the
// organization written with `set_config(name, value, true)` (transaction-local) as the FIRST statement of
// a transaction, never a session-level `SET` (see `PrismaService.runInOrg`).
//
// `orgScoped(client)` wraps a `pg` client so each `query` runs in its own short transaction with that
// scope. `{ bypass: true }` writes `app.rls_bypass` instead, the way a platform migration does: only for a
// spec that must see or write rows of every organization on purpose (a migration replay, a cross-org
// count) and each use says why.
import type { Client } from 'pg';

export interface OrgScopeOptions {
  /** The organization; defaults to the default organization (`mh_default_org_id()`). */
  orgId?: string;
  /** Explicit, documented bypass for a spec that reads or writes every organization. */
  bypass?: boolean;
}

export interface ScopedQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>>; rowCount: number | null }>;
}

/** Runs `fn` in one transaction whose first statement opens the scope. */
export async function inOrgTransaction<R>(
  client: Pick<Client, 'query'>,
  fn: (q: Pick<Client, 'query'>) => Promise<R>,
  options: OrgScopeOptions = {},
): Promise<R> {
  await client.query('BEGIN');
  try {
    if (options.bypass) await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
    else if (options.orgId) await client.query(`SELECT set_config('app.org_id', $1, true)`, [options.orgId]);
    else await client.query(`SELECT set_config('app.org_id', mh_default_org_id()::text, true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * A client whose every `query` is one statement in an org-scoped transaction. A spec that manages its own
 * transaction (`BEGIN` ... `COMMIT`) keeps full control: transaction-control statements pass straight
 * through and, while one is open, statements run as written (the spec opens its own scope).
 */
export function orgScoped(client: Pick<Client, 'query'>, options: OrgScopeOptions = {}): ScopedQueryable {
  // One wrapper per client and scope, so the open-transaction state survives across calls.
  const key = options.bypass ? 'bypass' : (options.orgId ?? 'default');
  const cached = wrappers.get(client)?.get(key);
  if (cached) return cached;
  let open = false;
  const wrapper: ScopedQueryable = {
    query: async (sql, params) => {
      const control = /^\s*(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK)\b/i.exec(sql);
      if (control) {
        open = /^(BEGIN|START)/i.test(control[1]!);
        return (await client.query(sql, params as unknown[])) as never;
      }
      if (open) return (await client.query(sql, params as unknown[])) as never;
      return (await inOrgTransaction(client, (c) => c.query(sql, params as unknown[]) as never, options)) as never;
    },
  };
  if (!wrappers.has(client)) wrappers.set(client, new Map());
  wrappers.get(client)!.set(key, wrapper);
  return wrapper;
}

const wrappers = new WeakMap<object, Map<string, ScopedQueryable>>();

/** The client a Prisma-based spec seeds and reads through: every operation in the default organization's scope. */
export type SeedClient = ReturnType<import('../../src/prisma/prisma.service').PrismaService['forOrg']>;

/** `prisma.forOrg(<default organization>)`: the org-scoped client (`PrismaService.forOrg`), for specs that seed RLS tables. */
export async function seedClient(prisma: import('../../src/prisma/prisma.service').PrismaService): Promise<SeedClient> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM organizations ORDER BY is_default DESC LIMIT 1`;
  if (rows.length === 0) throw new Error('no organization row: run the migrations first');
  return prisma.forOrg(rows[0]!.id);
}

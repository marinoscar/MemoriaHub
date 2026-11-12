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
import { forSystem } from '@marinoscar/platform-api/core';

import {
  MEDIA_HOUSEKEEPING_REASON,
  registerMemoriaHubSystemAccessReasons,
} from '../../src/app-registrations/system-access-reasons';

export interface OrgScopeOptions {
  /** The organization; defaults to the default organization (the default organization). */
  orgId?: string;
  /** Explicit, documented bypass for a spec that reads or writes every organization. */
  bypass?: boolean;
}

export interface ScopedQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>>; rowCount: number | null }>;
}

async function scopeStatement(client: Pick<Client, 'query'>, options: OrgScopeOptions): Promise<void> {
  if (options.bypass) await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
  else if (options.orgId) await client.query(`SELECT set_config('app.org_id', $1, true)`, [options.orgId]);
  else await client.query(`SELECT set_config('app.org_id', $1, true)`, [await defaultOrgOf(client)]);
}

const defaultOrgs = new WeakMap<object, string>();

/**
 * The default organization's id, or '' while the schema predates `organizations` (a migration-replay spec
 * applies the history step by step). `organizations` carries no row-level security, so this read needs no scope.
 */
async function defaultOrgOf(client: Pick<Client, 'query'>): Promise<string> {
  const cached = defaultOrgs.get(client);
  if (cached) return cached;
  const has = await client.query(`SELECT to_regclass('public.organizations') IS NOT NULL AS ok`);
  if (!has.rows[0]?.ok) return '';
  const row = await client.query(`SELECT id::text AS id FROM organizations WHERE is_default LIMIT 1`);
  const id = (row.rows[0]?.id as string | undefined) ?? '';
  if (id) defaultOrgs.set(client, id);
  return id;
}

/** Runs `fn` in one transaction whose first statement opens the scope. */
export async function inOrgTransaction<R>(
  client: Pick<Client, 'query'>,
  fn: (q: Pick<Client, 'query'>) => Promise<R>,
  options: OrgScopeOptions = {},
): Promise<R> {
  await client.query('BEGIN');
  try {
    await scopeStatement(client, options);
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
        const result = await client.query(sql, params as unknown[]);
        // The scope is the transaction's first statement; the spec may widen or replace it afterwards.
        if (open) await scopeStatement(client, options);
        return result as never;
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

/**
 * The platform's system client (`app.rls_bypass`, transaction-local) under MemoriaHub's housekeeping
 * reason, for the code under test that sweeps every organization's rows (a retention purge) on the client
 * it is given. An explicit, reasoned bypass; never a superuser connection.
 */
export function housekeepingClient(prisma: import('../../src/prisma/prisma.service').PrismaService): never {
  registerMemoriaHubSystemAccessReasons();
  return forSystem(prisma as never, MEDIA_HOUSEKEEPING_REASON as never) as never;
}

/**
 * A `PrismaService` whose CONNECTION carries `app.rls_bypass = on` (the `options` startup parameter), for
 * the code under test that is MemoriaHub's own domain services.
 *
 * Those services read the organization tables on the plain client with no organization of their own and
 * keep using `this.prisma` inside `$transaction(async tx => ...)`, which a `forOrg` client refuses
 * (`ScopedAccessError`) and which returns 0 rows on the plain one under row-level security: the "API
 * connects as the bootstrap superuser" row of docs/platform-adoption/local-exceptions.md. The app-read
 * scoping release that row waits for removes the need; until then a spec of that code takes the bypass
 * EXPLICITLY, on a connection of its own, as the same ordinary role (never a superuser) and the same
 * `PGOPTIONS=-c app.rls_bypass=on` the platform backup engine uses. The seeding and the assertions of the
 * spec still run through the org-scoped client, so only the code under test is unscoped.
 */
export async function rlsBypassPrisma(): Promise<import('../../src/prisma/prisma.service').PrismaService> {
  const { PrismaService } = await import('../../src/prisma/prisma.service');
  const { buildBaseDatabaseUrl } = await import('../../src/config/database-url.util');
  const previous = process.env.DATABASE_URL;
  const base = buildBaseDatabaseUrl();
  process.env.DATABASE_URL = `${base}${base.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c app.rls_bypass=on')}`;
  try {
    const client = new PrismaService();
    await client.$connect();
    return client;
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

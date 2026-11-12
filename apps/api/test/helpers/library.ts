// Seeds libraries for real-database specs (RETRO-K2): a shared library is a platform group of the
// scope id the content rows carry; a personal library is a `personal_libraries` row. Both take any
// object with `query(sql, params)` (a `pg` client) or a Prisma client (`$executeRawUnsafe`).
type PgLike = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
type PrismaLike = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
  $transaction?: <R>(fn: (tx: { $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> }) => Promise<R>) => Promise<R>;
};
type Q = PgLike | PrismaLike;

/**
 * The statement that opens the row-level-security scope: the default organization, written with
 * `set_config(name, value, true)` (transaction-local) as the FIRST statement of the transaction, the way
 * `PrismaService.runInOrg` does. `groups` and `group_members` force RLS on `org_id`, so an ordinary role
 * (the API's role in production and in the DB tier) is refused without it.
 */
const ORG_SCOPE = `SELECT set_config('app.org_id', mh_default_org_id()::text, true)`;

async function run(q: Q, sql: string, params: unknown[]): Promise<void> {
  if ('query' in q) {
    // A `pg` client: one short transaction per statement, scope first.
    await q.query('BEGIN');
    try {
      await q.query(ORG_SCOPE);
      await q.query(sql, params);
      await q.query('COMMIT');
    } catch (error) {
      await q.query('ROLLBACK');
      throw error;
    }
  } else if (typeof q.$transaction === 'function') {
    await q.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ORG_SCOPE);
      await tx.$executeRawUnsafe(sql, ...params);
    });
  } else {
    await q.$executeRawUnsafe(sql, ...params);
  }
}

export type GroupRoleName = 'admin' | 'editor' | 'viewer';

/** The group (and its members) behind a shared library. The first admin is the creator. */
export async function createSharedLibrary(
  q: Q,
  lib: { id: string; name?: string; createdById: string; members?: Array<{ userId: string; role: GroupRoleName }> },
): Promise<void> {
  await run(
    q,
    `INSERT INTO groups (id, org_id, name, created_by_id, version, created_at, updated_at)
     VALUES ($1::uuid, mh_default_org_id(), $2, $3::uuid, 1, now(), now())`,
    [lib.id, lib.name ?? `Library ${lib.id.slice(0, 8)}`, lib.createdById],
  );
  const members = lib.members ?? [{ userId: lib.createdById, role: 'admin' as const }];
  for (const member of members) {
    await run(
      q,
      `INSERT INTO group_members (id, group_id, user_id, org_id, role, created_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, mh_default_org_id(), $3, now(), now())`,
      [lib.id, member.userId, member.role],
    );
  }
}

/** The personal library of a user (its id is the scope id their content rows carry). */
export async function createPersonalLibrary(q: Q, lib: { id: string; userId: string }): Promise<void> {
  await run(q, `INSERT INTO personal_libraries (id, user_id) VALUES ($1::uuid, $2::uuid)`, [lib.id, lib.userId]);
}

/** Removes libraries created by the helpers (content must be gone). */
export async function dropLibraries(q: Q, ids: string[]): Promise<void> {
  await run(q, `DELETE FROM group_members WHERE group_id = ANY($1::uuid[])`, [ids]);
  await run(q, `DELETE FROM groups WHERE id = ANY($1::uuid[])`, [ids]);
  await run(q, `DELETE FROM personal_libraries WHERE id = ANY($1::uuid[])`, [ids]);
}

/**
 * A new library for a Prisma-based spec: a group (the default) or, with `personal`, the owner's
 * personal library. Returns its scope id. Replaces `prisma.circle.create` + `circleMember.create`.
 */
export async function newLibrary(
  prisma: { $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> },
  lib: { ownerId: string; personal?: boolean; name?: string; members?: Array<{ userId: string; role: GroupRoleName }> },
): Promise<{ id: string }> {
  const id = (await import('node:crypto')).randomUUID();
  if (lib.personal) {
    await createPersonalLibrary(prisma, { id, userId: lib.ownerId });
  } else {
    await createSharedLibrary(prisma, {
      id,
      name: lib.name,
      createdById: lib.ownerId,
      members: [{ userId: lib.ownerId, role: 'admin' }, ...(lib.members ?? [])],
    });
  }
  return { id };
}

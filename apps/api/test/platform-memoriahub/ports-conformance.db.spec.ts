/**
 * `MEMORIAHUB_PRISMA` over the real `PrismaService` against real PostgreSQL (RETRO-J4, #610).
 *
 * The adapters over the platform queue, access and storage are proven by `ports-conformance.spec.ts` over
 * stand-ins; what a stand-in cannot prove is the one binding that has NO adapter class: `useExisting:
 * PrismaService`. `runInOrg` is the contract row-level security rests on: the organization scope is
 * TRANSACTION-LOCAL (`set_config(name, value, true)` as the first statement), never a session `SET`, so it
 * must be visible inside the callback and gone on the pooled connection afterwards, also after a rollback.
 *
 * Needs only a reachable database (no table is read). Skips (reported as skipped, never passed) when
 * nothing listens on the port.
 */
import { randomUUID } from 'crypto';

import { Prisma } from '@marinoscar/memoriahub-api/core';
import type { MemoriahubPrismaClientLike } from '@marinoscar/memoriahub-api/ports';

import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

type SettingRow = { value: string | null };

describeMaybeDb('MEMORIAHUB_PRISMA over PrismaService (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let port: MemoriahubPrismaClientLike;

  const orgSetting = (client: Pick<MemoriahubPrismaClientLike, '$queryRaw'>) =>
    client.$queryRaw<SettingRow[]>`SELECT NULLIF(current_setting('app.org_id', true), '') AS value`;
  const userSetting = (client: Pick<MemoriahubPrismaClientLike, '$queryRaw'>) =>
    client.$queryRaw<SettingRow[]>`SELECT NULLIF(current_setting('app.user_id', true), '') AS value`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    port = prisma;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('runs a raw query built with the core SQL helper', async () => {
    const rows = await port.$queryRaw<Array<{ n: number }>>(Prisma.sql`SELECT ${7}::int AS n`);
    expect(rows).toEqual([{ n: 7 }]);
    expect(await port.$executeRaw(Prisma.sql`SELECT 1`)).toBeGreaterThanOrEqual(0);
  });

  it('runInOrg sets the organization and the acting user for the transaction only', async () => {
    const orgId = randomUUID();
    const userId = randomUUID();

    const inside = await port.runInOrg(
      orgId,
      async (tx) => ({ org: (await orgSetting(tx))[0]?.value, user: (await userSetting(tx))[0]?.value }),
      { userId },
    );
    expect(inside).toEqual({ org: orgId, user: userId });

    // Transaction-local: the pooled connection the next statement may reuse carries nothing.
    for (let i = 0; i < 5; i += 1) {
      expect((await orgSetting(port))[0]?.value).toBeNull();
      expect((await userSetting(port))[0]?.value).toBeNull();
    }
  });

  it('keeps the scope off the connection when the transaction rolls back', async () => {
    const orgId = randomUUID();
    await expect(
      port.runInOrg(orgId, async (tx) => {
        expect((await orgSetting(tx))[0]?.value).toBe(orgId);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    for (let i = 0; i < 5; i += 1) expect((await orgSetting(port))[0]?.value).toBeNull();
  });

  it('gives two concurrent units of work their own organization', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const read = (orgId: string) =>
      port.runInOrg(orgId, async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(0.05)::text`;
        return (await orgSetting(tx))[0]?.value;
      });

    expect(await Promise.all([read(a), read(b)])).toEqual([a, b]);
  });

  it('runs both transaction forms', async () => {
    expect(await port.$transaction(async (tx) => (await tx.$queryRaw`SELECT 2::int AS n`)[0].n)).toBe(2);
    const [first, second] = await port.$transaction([port.$queryRaw`SELECT 1::int AS n`, port.$queryRaw`SELECT 3::int AS n`]);
    expect([(first as Array<{ n: number }>)[0]!.n, (second as Array<{ n: number }>)[0]!.n]).toEqual([1, 3]);
  });
});

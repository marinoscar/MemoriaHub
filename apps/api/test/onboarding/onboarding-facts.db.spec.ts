/**
 * Real-Postgres tier (RETRO-H3, #599): MemoriaHub's onboarding facts against a real schema.
 *
 * Proves the Prisma `where` clauses the facts build are valid against the composed schema (relation
 * filters, enum values, nullable columns) and scoped to the caller: a second user's rows never
 * count. Skips when no database is reachable.
 */
import { randomUUID } from 'node:crypto';
import type { OnboardingRequestContext } from '@marinoscar/platform-api/onboarding';

import {
  ALBUM_COUNTS_FACT,
  CIRCLE_MEMBERSHIP_FACT,
  DEVICES_FACT,
  MEDIA_COUNTS_FACT,
  PEOPLE_NAMED_FACT,
} from '../../src/platform/onboarding/onboarding.facts';
import { PrismaService } from '../../src/prisma/prisma.service';
import { GroupInvitesService } from '@marinoscar/platform-api/sharing';
import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../../src/platform/sharing/owner-scope-sweep.service';
import { buildOwnerAccessService } from '../helpers/owner-access';
import { sqlScopeDirectory } from '../helpers/scope-directory';
import { dropLibraries, newLibrary } from '../helpers/library';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { seedClient, type SeedClient } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('onboarding facts (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
  let seed: SeedClient;
  let userId: string;
  let otherId: string;
  let circleId: string;
  let pendingTotal = 0;

  const ctxFor = (id: string) =>
    ({
      caller: { id, permissions: [], roles: [], activeOrgId: null },
      get: (token: unknown) =>
        token === GroupInvitesService
          ? { list: async () => ({ items: [], total: pendingTotal, page: 1, pageSize: 1, totalPages: 1 }) }
          : token === DefaultOrgId
            ? { get: async () => randomUUID() }
            : token === OwnerAccessService
              ? buildOwnerAccessService(prisma)
              : token === OwnerScopeSweepService
                ? sqlScopeDirectory(prisma as never)
                : prisma,
    }) as unknown as OnboardingRequestContext;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    seed = await seedClient(prisma);
    const stamp = Date.now();
    userId = (await prisma.user.create({ data: { email: `onboarding-a-${stamp}@example.test` } })).id;
    otherId = (await prisma.user.create({ data: { email: `onboarding-b-${stamp}@example.test` } })).id;
    circleId = (await newLibrary(prisma, { ownerId: userId })).id;
    await seed.album.create({ data: { circleId, addedById: otherId, name: 'Album X' } });
  });

  afterAll(async () => {
    // Children first: `albums` and `people` reference the circle and the users without a cascade.
    await seed.person.deleteMany({ where: { circleId } });
    await seed.album.deleteMany({ where: { circleId } });
    await dropLibraries(prisma, [circleId]);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it('counts only the caller\'s own uploads and albums', async () => {
    await expect(MEDIA_COUNTS_FACT.resolve(ctxFor(userId))).resolves.toEqual({ addedByUser: 0 });
    await expect(ALBUM_COUNTS_FACT.resolve(ctxFor(userId))).resolves.toEqual({ addedByUser: 0 });
    await expect(ALBUM_COUNTS_FACT.resolve(ctxFor(otherId))).resolves.toEqual({ addedByUser: 1 });
  });

  it('sees a lone circle admin, then a pending invite', async () => {
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctxFor(userId))).resolves.toEqual({
      collaboratorCircles: 1,
      otherMembers: 0,
      pendingInvites: 0,
    });
    // Pending invites are group invites read through the sharing slice since RETRO-I5
    // (onboarding-facts.spec.ts); the stand-in below answers one.
    pendingTotal = 1;
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctxFor(userId))).resolves.toMatchObject({ pendingInvites: 1 });
    // The other user is in no circle at all.
    await expect(CIRCLE_MEMBERSHIP_FACT.resolve(ctxFor(otherId))).resolves.toEqual({
      collaboratorCircles: 0,
      otherMembers: 0,
      pendingInvites: 0,
    });
  });

  it('counts named people only in the caller\'s circles', async () => {
    await expect(PEOPLE_NAMED_FACT.resolve(ctxFor(userId))).resolves.toEqual({ named: 0 });
    await seed.person.create({ data: { circleId, addedById: userId, name: 'Person A' } });
    await expect(PEOPLE_NAMED_FACT.resolve(ctxFor(userId))).resolves.toEqual({ named: 1 });
    await expect(PEOPLE_NAMED_FACT.resolve(ctxFor(otherId))).resolves.toEqual({ named: 0 });
  });

  it('resolves the devices fact for a user with none', async () => {
    await expect(DEVICES_FACT.resolve(ctxFor(userId))).resolves.toEqual({ syncDevices: 0, activeTokens: 0 });
  });
});

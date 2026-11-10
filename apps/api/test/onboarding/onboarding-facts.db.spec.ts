/**
 * Real-Postgres tier (RETRO-H3, #599): MemoriaHub's onboarding facts against a real schema.
 *
 * Proves the Prisma `where` clauses the facts build are valid against the composed schema (relation
 * filters, enum values, nullable columns) and scoped to the caller: a second user's rows never
 * count. Skips when no database is reachable.
 */
import { randomUUID } from 'node:crypto';
import type { OnboardingRequestContext } from '@marinoscar/platform-api/onboarding';
import { CircleRole } from '@prisma/client';

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
import { isDatabaseReachable } from '../helpers/db-probe.helper';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('onboarding facts (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaService;
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
    const stamp = Date.now();
    userId = (await prisma.user.create({ data: { email: `onboarding-a-${stamp}@example.test` } })).id;
    otherId = (await prisma.user.create({ data: { email: `onboarding-b-${stamp}@example.test` } })).id;
    const circle = await prisma.circle.create({
      data: { name: `Circle ${randomUUID()}`, ownerId: userId, isPersonal: false },
    });
    circleId = circle.id;
    await prisma.circleMember.create({ data: { circleId, userId, role: CircleRole.circle_admin } });
    await prisma.album.create({ data: { circleId, addedById: otherId, name: 'Album X' } });
  });

  afterAll(async () => {
    // Children first: `albums` and `people` reference the circle and the users without a cascade.
    await prisma.person.deleteMany({ where: { circleId } });
    await prisma.album.deleteMany({ where: { circleId } });
    await prisma.circleMember.deleteMany({ where: { circleId } });
    await prisma.circle.deleteMany({ where: { id: circleId } });
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
    await prisma.person.create({ data: { circleId, addedById: userId, name: 'Person A' } });
    await expect(PEOPLE_NAMED_FACT.resolve(ctxFor(userId))).resolves.toEqual({ named: 1 });
    await expect(PEOPLE_NAMED_FACT.resolve(ctxFor(otherId))).resolves.toEqual({ named: 0 });
  });

  it('resolves the devices fact for a user with none', async () => {
    await expect(DEVICES_FACT.resolve(ctxFor(userId))).resolves.toEqual({ syncDevices: 0, activeTokens: 0 });
  });
});

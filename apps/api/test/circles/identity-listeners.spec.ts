import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { CircleRole } from '@prisma/client';

import { CircleIdentityListeners } from '../../src/circles/identity-listeners';
import { EmailService } from '../../src/email/email.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../mocks/prisma.mock';

// Circles reacting to the identity slice's events (RETRO-B2, issue #611): the
// personal circle for a new user and the claim of pending circle invites. These
// were inline in the app's AuthService; the invite scenarios are the old
// `invite-claim-on-login` suite, ported.

const USER_ID = 'user-existing-001';
const EMAIL = 'alice@example.test';
const CIRCLE_ID = 'circle-001';

function invite(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: randomUUID(),
    circleId: CIRCLE_ID,
    email: EMAIL,
    role: 'viewer' as CircleRole,
    claimedAt: null,
    claimedById: null,
    ...overrides,
  };
}

describe('CircleIdentityListeners', () => {
  let listeners: CircleIdentityListeners;
  let prisma: MockPrismaService;
  let email: { sendEmailAsync: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    email = { sendEmailAsync: jest.fn() };
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    prisma.circle.findUnique.mockResolvedValue({ name: 'Family', description: null } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleIdentityListeners,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
      ],
    }).compile();
    listeners = module.get(CircleIdentityListeners);
  });

  function pending(...rows: ReturnType<typeof invite>[]) {
    prisma.circleInvite.findMany.mockResolvedValue(rows.map((r) => ({ id: r.id })) as any);
    prisma.circleInvite.findFirst.mockImplementation((async ({ where }: any) =>
      rows.find((r) => r.id === where.id) ?? null) as any);
    prisma.circleInvite.update.mockResolvedValue({} as any);
  }

  describe('identity.user.created', () => {
    beforeEach(() => {
      prisma.circleInvite.findMany.mockResolvedValue([] as any);
      prisma.user.findUnique.mockResolvedValue({ displayName: null, providerDisplayName: 'Alice' } as any);
      prisma.circle.create.mockResolvedValue({ id: 'personal-1' } as any);
    });

    it('creates exactly one personal circle with the user as circle_admin', async () => {
      prisma.circle.findFirst.mockResolvedValue(null);

      await listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null });

      expect(prisma.circle.create).toHaveBeenCalledWith({
        data: { name: "Alice's Library", ownerId: USER_ID, isPersonal: true },
      });
      expect(prisma.circleMember.create).toHaveBeenCalledWith({
        data: { circleId: 'personal-1', userId: USER_ID, role: 'circle_admin' },
      });
    });

    it('does not create a second personal circle (the two events fire back to back)', async () => {
      prisma.circle.findFirst.mockResolvedValue({ id: 'personal-1' } as any);

      await listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null });
      await listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null });

      expect(prisma.circle.create).not.toHaveBeenCalled();
    });

    it('serialises on a per-user advisory lock', async () => {
      prisma.circle.findFirst.mockResolvedValue(null);
      await listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null });
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('never throws into the sign-in: a failure is logged', async () => {
      prisma.circle.findFirst.mockRejectedValue(new Error('db down'));
      await expect(
        listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null }),
      ).resolves.toBeUndefined();
    });
  });

  describe('identity.login.succeeded', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ email: EMAIL } as any);
    });

    it('creates the member row with the invited role and marks the invite claimed', async () => {
      const i = invite({ role: 'collaborator' });
      pending(i);
      prisma.circleMember.findUnique.mockResolvedValue(null);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: false });

      expect(prisma.circleInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: EMAIL, claimedAt: null } }),
      );
      expect(prisma.circleMember.create).toHaveBeenCalledWith({
        data: { circleId: CIRCLE_ID, userId: USER_ID, role: 'collaborator' },
      });
      expect(prisma.circleInvite.update).toHaveBeenCalledWith({
        where: { id: i.id },
        data: { claimedById: USER_ID, claimedAt: expect.any(Date) },
      });
      expect(email.sendEmailAsync).toHaveBeenCalledWith(EMAIL, 'membership-confirmation', expect.objectContaining({ role: 'collaborator' }));
    });

    it('does nothing when there are no pending invites', async () => {
      prisma.circleInvite.findMany.mockResolvedValue([] as any);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: false });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.circleMember.create).not.toHaveBeenCalled();
    });

    it('upgrades a lower role, and mails the confirmation', async () => {
      pending(invite({ role: 'circle_admin' }));
      prisma.circleMember.findUnique.mockResolvedValue({ role: 'viewer' } as any);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: false });

      expect(prisma.circleMember.update).toHaveBeenCalledWith({
        where: { circleId_userId: { circleId: CIRCLE_ID, userId: USER_ID } },
        data: { role: 'circle_admin' },
      });
      expect(prisma.circleMember.create).not.toHaveBeenCalled();
      expect(email.sendEmailAsync).toHaveBeenCalledTimes(1);
    });

    it('never downgrades, but still marks the invite claimed (no mail)', async () => {
      const i = invite({ role: 'viewer' });
      pending(i);
      prisma.circleMember.findUnique.mockResolvedValue({ role: 'circle_admin' } as any);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: false });

      expect(prisma.circleMember.update).not.toHaveBeenCalled();
      expect(prisma.circleMember.create).not.toHaveBeenCalled();
      expect(prisma.circleInvite.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: i.id } }));
      expect(email.sendEmailAsync).not.toHaveBeenCalled();
    });

    it('is a no-op for an equal role', async () => {
      pending(invite({ role: 'collaborator' }));
      prisma.circleMember.findUnique.mockResolvedValue({ role: 'collaborator' } as any);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: false });

      expect(prisma.circleMember.update).not.toHaveBeenCalled();
      expect(prisma.circleMember.create).not.toHaveBeenCalled();
    });

    it('claims every pending invite, one transaction each', async () => {
      pending(invite({ circleId: 'c-1' }), invite({ circleId: 'c-2', role: 'collaborator' }));
      prisma.circleMember.findUnique.mockResolvedValue(null);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: false });

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.circleMember.create).toHaveBeenCalledTimes(2);
    });

    it('skips an invite another handler claimed under the lock (user.created and login.succeeded race)', async () => {
      const i = invite();
      prisma.circleInvite.findMany.mockResolvedValue([{ id: i.id }] as any);
      prisma.circleInvite.findFirst.mockResolvedValue(null);

      await listeners.onLoginSucceeded({ userId: USER_ID, provider: 'google', isNewUser: true });

      expect(prisma.circleMember.create).not.toHaveBeenCalled();
      expect(prisma.circleInvite.update).not.toHaveBeenCalled();
    });
  });
});

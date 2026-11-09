import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole } from '@prisma/client';

import { CircleIdentityListeners } from '../../src/circles/identity-listeners';
import { GroupMemberMirrorListener } from '../../src/circles/group-member-mirror.listener';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { IDENTITY_EVENTS } from '@marinoscar/platform-api/identity';

import { notificationsForwardingTo } from '../mocks/email-notifications.adapter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../mocks/prisma.mock';

// Circles reacting to the identity slice's events (RETRO-B2, issue #611): the
// personal circle for a new user. Since RETRO-I5 (#583) pending invites are
// platform group invites, claimed by the sharing slice's own listener at sign-up
// and sign-in (proved against a real database by
// test/sharing/invites-autoclaim.db.spec.ts); what the app still does is mirror
// the memberships the slice writes back into circle_members and mail the
// membership confirmation (GroupMemberMirrorListener, below).

const USER_ID = 'user-existing-001';
const EMAIL = 'person-a@example.test';
const CIRCLE_ID = 'circle-001';
const ORG_ID = 'org-001';

describe('CircleIdentityListeners', () => {
  let listeners: CircleIdentityListeners;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma));
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [CircleIdentityListeners, { provide: PrismaService, useValue: prisma }],
    }).compile();
    listeners = module.get(CircleIdentityListeners);
  });

  it('no longer listens to identity.login.succeeded (the sharing slice claims invites)', () => {
    const handlers = Object.getOwnPropertyNames(CircleIdentityListeners.prototype);
    expect(handlers).not.toContain('onLoginSucceeded');
    expect(handlers).not.toContain('claimPendingInvites');
    expect(IDENTITY_EVENTS.LOGIN_SUCCEEDED).toBe('identity.login.succeeded');
  });

  describe('identity.user.created', () => {
    beforeEach(() => {
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

});

describe('GroupMemberMirrorListener', () => {
  let listener: GroupMemberMirrorListener;
  let prisma: MockPrismaService;
  let email: { sendEmailAsync: jest.Mock };

  const member = (role: string | null) => ({
    orgId: ORG_ID,
    groupId: CIRCLE_ID,
    actorUserId: USER_ID,
    userId: USER_ID,
    role,
    previousRole: null,
  });

  beforeEach(async () => {
    prisma = createMockPrismaService();
    email = { sendEmailAsync: jest.fn() };
    prisma.circle.findUnique.mockResolvedValue({ name: 'Circle Alpha', description: null, isPersonal: false } as any);
    prisma.user.findUnique.mockResolvedValue({ email: EMAIL } as any);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupMemberMirrorListener,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notificationsForwardingTo(email) },
      ],
    }).compile();
    listener = module.get(GroupMemberMirrorListener);
  });

  it.each([
    ['admin', CircleRole.circle_admin],
    ['editor', CircleRole.collaborator],
    ['viewer', CircleRole.viewer],
  ])('mirrors a member added as %s into circle_members as %s', async (groupRole, circleRole) => {
    await listener.onMemberAdded(member(groupRole) as any);

    expect(prisma.circleMember.upsert).toHaveBeenCalledWith({
      where: { circleId_userId: { circleId: CIRCLE_ID, userId: USER_ID } },
      update: { role: circleRole },
      create: { circleId: CIRCLE_ID, userId: USER_ID, role: circleRole },
    });
  });

  it('mirrors a role change (an upgrade by an accepted invite)', async () => {
    await listener.onMemberRoleChanged({ ...member('admin'), previousRole: 'editor' } as any);
    expect(prisma.circleMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { role: CircleRole.circle_admin } }),
    );
  });

  it('mirrors a removal', async () => {
    await listener.onMemberRemoved(member(null) as any);
    expect(prisma.circleMember.deleteMany).toHaveBeenCalledWith({ where: { circleId: CIRCLE_ID, userId: USER_ID } });
  });

  it('leaves a group with no circle, or a personal circle, alone', async () => {
    prisma.circle.findUnique.mockResolvedValueOnce(null);
    await listener.onMemberAdded(member('viewer') as any);
    prisma.circle.findUnique.mockResolvedValueOnce({ name: 'Mine', description: null, isPersonal: true } as any);
    await listener.onMemberAdded(member('viewer') as any);

    expect(prisma.circleMember.upsert).not.toHaveBeenCalled();
  });

  it('never throws: a failed write is logged', async () => {
    prisma.circleMember.upsert.mockRejectedValue(new Error('db down'));
    await expect(listener.onMemberAdded(member('viewer') as any)).resolves.toBeUndefined();
  });

  it('mails the membership confirmation when an auto-accepted invite joined or upgraded', async () => {
    for (const outcome of ['joined', 'upgraded'] as const) {
      await listener.onInviteAutoAccepted({
        ...member('editor'),
        inviteId: 'inv-1',
        role: 'editor',
        outcome,
        memberRole: 'editor',
      } as any);
    }

    expect(email.sendEmailAsync).toHaveBeenCalledTimes(2);
    expect(email.sendEmailAsync).toHaveBeenCalledWith(
      EMAIL,
      'membership-confirmation',
      expect.objectContaining({ circleName: 'Circle Alpha', role: 'collaborator', viewUrl: expect.stringContaining(`/circles/${CIRCLE_ID}`) }),
    );
  });

  it('sends nothing when the invite changed nothing (never-downgrade kept a higher role)', async () => {
    await listener.onInviteAutoAccepted({
      ...member('admin'),
      inviteId: 'inv-1',
      role: 'viewer',
      outcome: 'unchanged',
      previousRole: 'admin',
      memberRole: 'admin',
    } as any);

    expect(email.sendEmailAsync).not.toHaveBeenCalled();
  });
});

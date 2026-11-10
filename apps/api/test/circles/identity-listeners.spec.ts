import { Test, TestingModule } from '@nestjs/testing';
import { IDENTITY_EVENTS } from '@marinoscar/platform-api/identity';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { CircleIdentityListeners } from '../../src/circles/identity-listeners';
import { GroupInviteEmailListener } from '../../src/circles/group-invite-email.listener';
import { OwnerScopeSweepService } from '../../src/platform/sharing/owner-scope-sweep.service';
import { PersonalLibraryStore } from '../../src/platform/sharing/personal-library.store';
import { PrismaService } from '../../src/prisma/prisma.service';
import { notificationsForwardingTo } from '../mocks/email-notifications.adapter';
import { createMockPrismaService, MockPrismaService } from '../mocks/prisma.mock';

// Circles reacting to the identity slice's events (RETRO-B2, issue #611; RETRO-K2): the personal
// library of a new user. Pending invites are platform group invites, claimed by the sharing slice's
// own listener at sign-up and sign-in (proved against a real database by
// test/sharing/invites-autoclaim.db.spec.ts); the only thing the app still does about an invite is
// mail the membership confirmation (GroupInviteEmailListener, below).

const USER_ID = 'user-existing-001';
const EMAIL = 'person-a@example.test';
const GROUP_ID = 'group-001';

describe('CircleIdentityListeners', () => {
  let listeners: CircleIdentityListeners;
  let personal: { ensure: jest.Mock };

  beforeEach(async () => {
    personal = { ensure: jest.fn().mockResolvedValue({ id: 'lib-1', created: true }) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [CircleIdentityListeners, { provide: PersonalLibraryStore, useValue: personal }],
    }).compile();
    module.useLogger(false);
    listeners = module.get(CircleIdentityListeners);
  });

  it('no longer listens to identity.login.succeeded (the sharing slice claims invites)', () => {
    const handlers = Object.getOwnPropertyNames(CircleIdentityListeners.prototype);
    expect(handlers).not.toContain('onLoginSucceeded');
    expect(handlers).not.toContain('claimPendingInvites');
    expect(IDENTITY_EVENTS.LOGIN_SUCCEEDED).toBe('identity.login.succeeded');
  });

  describe('identity.user.created', () => {
    it('creates the personal library of the new user', async () => {
      await listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null });
      expect(personal.ensure).toHaveBeenCalledWith(USER_ID);
    });

    it('is a no-op when the library exists (the two events fire back to back)', async () => {
      personal.ensure.mockResolvedValue({ id: 'lib-1', created: false });
      await expect(listeners.ensurePersonalCircle(USER_ID)).resolves.toBeUndefined();
      expect(personal.ensure).toHaveBeenCalledTimes(1);
    });

    it('never throws into the sign-in: a failure is logged', async () => {
      personal.ensure.mockRejectedValue(new Error('db down'));
      await expect(
        listeners.onUserCreated({ userId: USER_ID, email: EMAIL, source: 'google', orgId: null }),
      ).resolves.toBeUndefined();
    });
  });
});

describe('GroupInviteEmailListener', () => {
  let listener: GroupInviteEmailListener;
  let prisma: MockPrismaService;
  let email: { sendEmailAsync: jest.Mock };
  let scopes: { summary: jest.Mock };

  const accepted = (outcome: 'joined' | 'upgraded' | 'unchanged', memberRole = 'editor') => ({
    groupId: GROUP_ID,
    userId: USER_ID,
    orgId: 'org-001',
    inviteId: 'inv-1',
    role: 'editor',
    outcome,
    memberRole,
  });

  beforeEach(async () => {
    prisma = createMockPrismaService();
    prisma.user.findUnique.mockResolvedValue({ email: EMAIL } as any);
    scopes = { summary: jest.fn().mockResolvedValue({ id: GROUP_ID, name: 'Circle Alpha', kind: 'group' }) };
    email = { sendEmailAsync: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupInviteEmailListener,
        { provide: PrismaService, useValue: prisma },
        { provide: OwnerScopeSweepService, useValue: scopes },
        { provide: NotificationsService, useValue: notificationsForwardingTo(email as any) },
      ],
    }).compile();
    module.useLogger(false);
    listener = module.get(GroupInviteEmailListener);
  });

  it('mails the membership confirmation when an auto-accepted invite joined or upgraded', async () => {
    for (const outcome of ['joined', 'upgraded'] as const) {
      await listener.onInviteAutoAccepted(accepted(outcome) as any);
    }

    expect(email.sendEmailAsync).toHaveBeenCalledTimes(2);
    expect(email.sendEmailAsync).toHaveBeenCalledWith(
      EMAIL,
      'membership-confirmation',
      expect.objectContaining({ circleName: 'Circle Alpha', role: 'collaborator', viewUrl: expect.stringContaining(`/circles/${GROUP_ID}`) }),
    );
  });

  it('sends nothing when the invite changed nothing (never-downgrade kept a higher role)', async () => {
    await listener.onInviteAutoAccepted(accepted('unchanged', 'admin') as any);
    expect(email.sendEmailAsync).not.toHaveBeenCalled();
  });

  it('never throws: a failed lookup is logged', async () => {
    scopes.summary.mockRejectedValue(new Error('db down'));
    await expect(listener.onInviteAutoAccepted(accepted('joined') as any)).resolves.toBeUndefined();
    expect(email.sendEmailAsync).not.toHaveBeenCalled();
  });
});

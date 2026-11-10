import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CirclesService } from './circles.service';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerAccessService } from '../platform/sharing/owner-scope';
import { OwnerScopeSweepService } from '../platform/sharing/owner-scope-sweep.service';
import { PersonalLibraryStore } from '../platform/sharing/personal-library.store';
import { GroupMemberMirrorListener } from './group-member-mirror.listener';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import {
  GroupInvitesService,
  GroupMembershipService,
  GroupsService,
  SHARING_PERMISSIONS,
} from '@marinoscar/platform-api/sharing';
import { DefaultOrgId } from '../common/tenancy/default-org-id';

import { notificationsForwardingTo } from '../../test/mocks/email-notifications.adapter';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

const groupInvite = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  groupId: 'c1',
  orgId: ORG_ID,
  email: 'person-b@example.test',
  role: 'editor',
  status: 'pending',
  invitedById: 'user-1',
  expiresAt: null,
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const group = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  orgId: ORG_ID,
  name: 'Group A',
  description: null,
  metadata: null,
  createdById: 'user-1',
  version: 1,
  myRole: 'admin',
  memberCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

describe('CirclesService (served from platform groups, RETRO-K1)', () => {
  let service: CirclesService;
  let mockPrisma: MockPrismaService;
  let mockMembership: jest.Mocked<OwnerAccessService>;
  let mockEmail: { sendEmail: jest.Mock; sendEmailAsync: jest.Mock };
  let mockInvites: { list: jest.Mock; create: jest.Mock; revoke: jest.Mock };
  let groups: { create: jest.Mock; get: jest.Mock; list: jest.Mock; update: jest.Mock };
  let members: { list: jest.Mock; add: jest.Mock; changeRole: jest.Mock; remove: jest.Mock };
  let personal: { ownerOf: jest.Mock; idOf: jest.Mock; get: jest.Mock; page: jest.Mock };
  let scopes: { summary: jest.Mock; membersOf: jest.Mock };
  let mirror: { ensureCircleFor: jest.Mock };

  const mockUser = {
    id: 'user-1',
    email: 'user@example.com',
    roles: [],
    permissions: [],
  } as any;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockMembership = {
      requireOwnerRole: jest.fn().mockResolvedValue({ role: 'admin' as const, isSuperAdmin: false }),
      roleIn: jest.fn().mockResolvedValue('admin'),
      invalidateMembers: jest.fn(),
    } as any;

    mockInvites = { list: jest.fn(), create: jest.fn(), revoke: jest.fn().mockResolvedValue(undefined) };
    groups = {
      create: jest.fn().mockResolvedValue(group()),
      get: jest.fn().mockResolvedValue(group()),
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, totalPages: 1 }),
      update: jest.fn().mockResolvedValue(group({ name: 'Renamed' })),
    };
    members = {
      list: jest.fn(),
      add: jest.fn(),
      changeRole: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    personal = {
      ownerOf: jest.fn().mockResolvedValue(null),
      idOf: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      page: jest.fn().mockResolvedValue([]),
    };
    scopes = { summary: jest.fn().mockResolvedValue({ id: 'c1', name: 'Group A', kind: 'group' }), membersOf: jest.fn().mockResolvedValue([]) };
    mirror = { ensureCircleFor: jest.fn().mockResolvedValue(undefined) };

    mockEmail = {
      sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'mock-message-id' }),
      sendEmailAsync: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CirclesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OwnerAccessService, useValue: mockMembership },
        { provide: NotificationsService, useValue: notificationsForwardingTo(mockEmail) },
        { provide: GroupInvitesService, useValue: mockInvites },
        { provide: GroupsService, useValue: groups },
        { provide: GroupMembershipService, useValue: members },
        { provide: PersonalLibraryStore, useValue: personal },
        { provide: OwnerScopeSweepService, useValue: scopes },
        { provide: GroupMemberMirrorListener, useValue: mirror },
        { provide: DefaultOrgId, useValue: { get: jest.fn().mockResolvedValue(ORG_ID) } },
      ],
    }).compile();

    service = module.get<CirclesService>(CirclesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create()', () => {
    it('creates a platform group, writes its circle row synchronously and answers the circle shape', async () => {
      const result = await service.create('user-1', { name: 'Group A' } as any);

      expect(groups.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', activeOrgId: ORG_ID }),
        { name: 'Group A', description: undefined },
      );
      expect(mirror.ensureCircleFor).toHaveBeenCalledWith('c1', 'Group A', null, 'user-1');
      expect(mockMembership.invalidateMembers).toHaveBeenCalledWith(['user-1']);
      expect(result).toMatchObject({ id: 'c1', name: 'Group A', isPersonal: false, ownerId: 'user-1', memberRole: 'circle_admin', _count: { members: 2 } });
    });
  });

  describe('list()', () => {
    it('lists the caller\'s groups and personal library with circle roles, by name', async () => {
      groups.list.mockResolvedValue({ items: [group({ myRole: 'editor' })], total: 1, page: 1, pageSize: 100, totalPages: 1 });
      personal.idOf.mockResolvedValue('p1');
      personal.get.mockResolvedValue({ id: 'p1', ownerId: 'user-1', ownerName: 'Person A', ownerEmail: 'a@example.test', createdAt: new Date('2026-01-01T00:00:00Z') });

      const result = await service.list(mockUser, false);

      expect(groups.list).toHaveBeenCalledWith(expect.anything(), { scope: 'mine', page: 1, pageSize: 100 });
      expect(result.items.map((i) => [i.id, i.isPersonal, i.memberRole])).toEqual([
        ['c1', false, 'collaborator'],
        ['p1', true, 'circle_admin'],
      ]);
      expect(result.items[1]).toMatchObject({ name: "Person A's Library", _count: { members: 1 } });
    });

    it('requires groups:admin (or circles:manage_any) for all=true', async () => {
      await expect(service.list(mockUser, true)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.list({ ...mockUser, permissions: [SHARING_PERMISSIONS.GROUPS_ADMIN] }, true)).resolves.toBeDefined();
      expect(groups.list).toHaveBeenCalledWith(expect.anything(), { scope: 'all', page: 1, pageSize: 100 });
    });
  });

  describe('getById()', () => {
    it('answers a group with the member and media counts', async () => {
      mockPrisma.mediaItem.count.mockResolvedValue(7 as any);

      const result = await service.getById(mockUser, 'c1');

      expect(mockMembership.requireOwnerRole).toHaveBeenCalledWith('user-1', 'c1', [], 'viewer');
      expect(result).toMatchObject({ id: 'c1', _count: { members: 2, mediaItems: 7 } });
    });

    it('answers a personal library for its owner', async () => {
      personal.get.mockResolvedValue({ id: 'p1', ownerId: 'user-1', ownerName: null, ownerEmail: 'a@example.test', createdAt: new Date('2026-01-01T00:00:00Z') });
      mockPrisma.mediaItem.count.mockResolvedValue(3 as any);

      const result = await service.getById(mockUser, 'p1');

      expect(groups.get).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'p1', isPersonal: true, _count: { members: 1, mediaItems: 3 } });
    });

    it('is a 404 when the slice does not know the group', async () => {
      groups.get.mockRejectedValue(new NotFoundException('Group not found'));
      await expect(service.getById(mockUser, 'c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update() and remove()', () => {
    it('renames through the slice and refuses a personal library', async () => {
      const updated = await service.update(mockUser, 'c1', { name: 'Renamed' } as any);
      expect(groups.update).toHaveBeenCalledWith(expect.anything(), 'c1', { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');

      personal.ownerOf.mockResolvedValue('user-1');
      await expect(service.update(mockUser, 'p1', { name: 'X' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to delete a personal library', async () => {
      personal.ownerOf.mockResolvedValue('user-1');
      await expect(service.remove(mockUser, 'p1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.circle.delete).not.toHaveBeenCalled();
    });

    it('deletes a shared circle (the content cascades) and drops the members\' cached groups', async () => {
      scopes.membersOf.mockResolvedValue([{ userId: 'user-1', role: 'admin' }, { userId: 'user-2', role: 'viewer' }]);
      mockPrisma.circle.delete.mockResolvedValue({} as any);

      await service.remove(mockUser, 'c1');

      expect(mockPrisma.circle.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(mockMembership.invalidateMembers).toHaveBeenCalledWith(['user-1', 'user-2']);
    });

    it('is a 404 for an unknown circle', async () => {
      scopes.summary.mockResolvedValue(null);
      await expect(service.remove(mockUser, 'c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('members', () => {
    const member = (userId: string, role: string) => ({ groupId: 'c1', userId, role, email: `${userId}@example.test`, displayName: null, addedById: null, createdAt: '2026-01-01T00:00:00.000Z' });

    it('lists the members with circle roles and the user fields the clients read', async () => {
      members.list.mockResolvedValue({ items: [member('user-1', 'admin'), member('user-2', 'editor')], total: 2, page: 1, pageSize: 100, totalPages: 1 });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'u1@example.test', displayName: 'U1', providerDisplayName: null, profileImageUrl: null, providerProfileImageUrl: null }] as any);

      const result = await service.listMembers(mockUser, 'c1');

      expect(result.total).toBe(2);
      expect(result.items.map((i) => [i.userId, i.role])).toEqual([['user-1', 'circle_admin'], ['user-2', 'collaborator']]);
      expect(result.items[0]).toMatchObject({ circleId: 'c1', user: { email: 'u1@example.test' } });
    });

    it('lists a personal library as its owner only', async () => {
      personal.ownerOf.mockResolvedValue('user-1');
      personal.get.mockResolvedValue({ id: 'p1', ownerId: 'user-1', ownerName: null, ownerEmail: 'a@example.test', createdAt: new Date('2026-01-01T00:00:00Z') });
      mockPrisma.user.findMany.mockResolvedValue([] as any);

      const result = await service.listMembers(mockUser, 'p1');

      expect(members.list).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ userId: 'user-1', role: 'circle_admin' });
    });

    it('adds a member with the mapped group role and sends the confirmation e-mail', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-2' } as any);
      mockPrisma.user.findMany.mockResolvedValue([{ id: 'user-2', email: 'u2@example.test', displayName: null, providerDisplayName: null, profileImageUrl: null, providerProfileImageUrl: null }] as any);
      members.add.mockResolvedValue(member('user-2', 'editor'));

      const result = await service.addMember(mockUser, 'c1', { userId: 'user-2', role: 'collaborator' } as any);

      expect(members.add).toHaveBeenCalledWith(expect.anything(), 'c1', { userId: 'user-2', role: 'editor' });
      expect(mockMembership.invalidateMembers).toHaveBeenCalledWith(['user-2']);
      expect(result).toMatchObject({ userId: 'user-2', role: 'collaborator' });
    });

    it('is a 404 for an unknown user and a 400 for a personal library', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.addMember(mockUser, 'c1', { userId: 'x', role: 'viewer' } as any)).rejects.toBeInstanceOf(NotFoundException);

      mockPrisma.user.findUnique.mockResolvedValue({ id: 'x' } as any);
      personal.ownerOf.mockResolvedValue('user-1');
      await expect(service.addMember(mockUser, 'p1', { userId: 'x', role: 'viewer' } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(members.add).not.toHaveBeenCalled();
    });

    it('maps the slice\'s LAST_GROUP_ADMIN 409 to the former 400 on demote and remove', async () => {
      const lastAdmin = () => new ConflictException({ message: 'last', code: 'LAST_GROUP_ADMIN' });
      members.changeRole.mockRejectedValue(lastAdmin());
      members.remove.mockRejectedValue(lastAdmin());

      await expect(service.updateMemberRole(mockUser, 'c1', 'user-1', { role: 'viewer' } as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.removeMember(mockUser, 'c1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('changes a role and removes a member through the slice, dropping the cached groups', async () => {
      members.changeRole.mockResolvedValue(member('user-2', 'viewer'));
      mockPrisma.user.findMany.mockResolvedValue([] as any);

      const updated = await service.updateMemberRole(mockUser, 'c1', 'user-2', { role: 'viewer' } as any);
      expect(members.changeRole).toHaveBeenCalledWith(expect.anything(), 'c1', 'user-2', 'viewer');
      expect(updated.role).toBe('viewer');

      await service.removeMember(mockUser, 'c1', 'user-2');
      expect(members.remove).toHaveBeenCalledWith(expect.anything(), 'c1', 'user-2');
      expect(mockMembership.invalidateMembers).toHaveBeenCalledWith(['user-2']);
    });

    it('lets a member leave with viewer-level access only', async () => {
      await service.removeMember(mockUser, 'c1', 'user-1');
      expect(mockMembership.requireOwnerRole).toHaveBeenCalledWith('user-1', 'c1', [], 'viewer');
    });
  });

  // ---- invites (RETRO-I5: group invites through the sharing slice) ----

  describe('invites', () => {
    beforeEach(() => {
      personal.ownerOf.mockResolvedValue(null);
    });

    it('createInvite creates a group invite with the mapped role and answers the legacy shape', async () => {
      mockInvites.create.mockResolvedValue(groupInvite());

      const result = await service.createInvite(mockUser, 'c1', {
        email: 'person-b@example.test',
        role: 'collaborator',
      } as any);

      expect(mockMembership.requireOwnerRole).toHaveBeenCalledWith('user-1', 'c1', [], 'admin');
      expect(mockInvites.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'user', userId: 'user-1', email: 'user@example.com', activeOrgId: ORG_ID }),
        'c1',
        { email: 'person-b@example.test', role: 'editor' },
      );
      expect(result).toEqual({
        id: 'inv-1',
        circleId: 'c1',
        email: 'person-b@example.test',
        role: 'collaborator',
        notes: null,
        addedById: 'user-1',
        addedAt: '2026-01-01T00:00:00.000Z',
        claimedById: null,
        claimedAt: null,
      });
      // The invite no longer writes the allowlist or mails the invitee itself: the slice and its notifier do.
      expect(mockPrisma.allowedEmail.upsert).not.toHaveBeenCalled();
      expect(mockEmail.sendEmailAsync).not.toHaveBeenCalled();
    });

    it.each([
      ['circle_admin', 'admin'],
      ['viewer', 'viewer'],
    ])('maps %s to the group role %s', async (circleRole, groupRole) => {
      mockInvites.create.mockResolvedValue(groupInvite({ role: groupRole }));

      const result = await service.createInvite(mockUser, 'c1', { email: 'x@example.test', role: circleRole } as any);

      expect(mockInvites.create.mock.calls[0][2]).toEqual({ email: 'x@example.test', role: groupRole });
      expect(result.role).toBe(circleRole);
    });

    it('createInvite refuses a personal circle before reaching the slice', async () => {
      personal.ownerOf.mockResolvedValue('user-1');

      await expect(
        service.createInvite(mockUser, 'c1', { email: 'x@example.test', role: 'viewer' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockInvites.create).not.toHaveBeenCalled();
    });

    it('createInvite surfaces the slice refusal (409 INVITE_PENDING) unchanged', async () => {
      mockInvites.create.mockRejectedValue(new ConflictException({ message: 'pending', details: { reason: 'INVITE_PENDING' } }));

      await expect(
        service.createInvite(mockUser, 'c1', { email: 'x@example.test', role: 'viewer' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('a circles:manage_any caller acts as groups:admin in the slice', async () => {
      mockInvites.create.mockResolvedValue(groupInvite());
      const superAdmin = { ...mockUser, permissions: ['circles:manage_any'] };

      await service.createInvite(superAdmin, 'c1', { email: 'x@example.test', role: 'viewer' } as any);

      expect(mockInvites.create.mock.calls[0][0].permissions).toContain(SHARING_PERMISSIONS.GROUPS_ADMIN);
    });

    it('listInvites lists pending and accepted invites, not revoked or declined ones, across pages', async () => {
      mockInvites.list
        .mockResolvedValueOnce({
          items: [groupInvite({ id: 'a' }), groupInvite({ id: 'b', status: 'revoked' })],
          total: 4,
          page: 1,
          pageSize: 100,
          totalPages: 2,
        })
        .mockResolvedValueOnce({
          items: [groupInvite({ id: 'c', status: 'accepted', acceptedAt: '2026-01-02T00:00:00.000Z' }), groupInvite({ id: 'd', status: 'declined' })],
          total: 4,
          page: 2,
          pageSize: 100,
          totalPages: 2,
        });

      const result = await service.listInvites(mockUser, 'c1');

      expect(mockInvites.list).toHaveBeenNthCalledWith(1, expect.anything(), 'c1', { status: 'all', page: 1, pageSize: 100 });
      expect(result.items.map((i) => i.id)).toEqual(['a', 'c']);
      expect(result.items[1].claimedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(result.total).toBe(2);
    });

    it('listInvites answers an empty list for a personal circle (it has no group)', async () => {
      personal.ownerOf.mockResolvedValue('user-1');

      expect(await service.listInvites(mockUser, 'c1')).toEqual({ items: [], total: 0 });
      expect(mockInvites.list).not.toHaveBeenCalled();
    });

    it('revokeInvite revokes through the slice', async () => {
      await service.revokeInvite(mockUser, 'c1', 'inv-1');

      expect(mockInvites.revoke).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'c1', 'inv-1');
    });

    it('revokeInvite is a 404 for a personal circle', async () => {
      personal.ownerOf.mockResolvedValue('user-1');

      await expect(service.revokeInvite(mockUser, 'c1', 'inv-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockInvites.revoke).not.toHaveBeenCalled();
    });
  });
});

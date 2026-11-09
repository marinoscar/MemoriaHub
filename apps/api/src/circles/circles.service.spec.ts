import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { CirclesService } from './circles.service';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerAccessService } from '../platform/sharing/owner-scope';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { GroupInvitesService, SHARING_PERMISSIONS } from '@marinoscar/platform-api/sharing';
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

describe('CirclesService', () => {
  let service: CirclesService;
  let mockPrisma: MockPrismaService;
  let mockMembership: jest.Mocked<OwnerAccessService>;
  let mockEmail: { sendEmail: jest.Mock; sendEmailAsync: jest.Mock };
  let mockInvites: { list: jest.Mock; create: jest.Mock; revoke: jest.Mock };

  const mockUser = {
    id: 'user-1',
    email: 'user@example.com',
    permissions: [],
  } as any;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockPrisma.circleMember.findMany.mockResolvedValue([]);

    mockMembership = {
      requireOwnerRole: jest.fn().mockResolvedValue({ role: 'admin' as const, isSuperAdmin: false }),
      roleIn: jest.fn().mockResolvedValue('admin'),
      invalidateMembers: jest.fn(),
    } as any;

    mockInvites = { list: jest.fn(), create: jest.fn(), revoke: jest.fn().mockResolvedValue(undefined) };

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
        { provide: DefaultOrgId, useValue: { get: jest.fn().mockResolvedValue(ORG_ID) } },
      ],
    }).compile();

    service = module.get<CirclesService>(CirclesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---- create() ----

  describe('create()', () => {
    it('should create circle and add creator as circle_admin in a transaction', async () => {
      const mockCircle = {
        id: 'circle-1',
        name: 'Test Circle',
        isPersonal: false,
        ownerId: 'user-1',
      };
      const mockMember = {
        id: 'member-1',
        circleId: 'circle-1',
        userId: 'user-1',
        role: CircleRole.circle_admin,
      };

      // $transaction passes mockPrisma as tx to the callback
      mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(mockPrisma));
      mockPrisma.circle.create.mockResolvedValue(mockCircle as any);
      mockPrisma.circleMember.create.mockResolvedValue(mockMember as any);

      const result = await service.create('user-1', { name: 'Test Circle' });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.circle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Test Circle',
          ownerId: 'user-1',
          isPersonal: false,
        }),
      });
      expect(mockPrisma.circleMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          circleId: 'circle-1',
          userId: 'user-1',
          role: CircleRole.circle_admin,
        }),
      });
      expect(result).toHaveProperty('id', 'circle-1');
    });
  });

  // ---- getById() ----

  describe('getById()', () => {
    it('should throw ForbiddenException when user is not a member', async () => {
      mockMembership.requireOwnerRole.mockRejectedValue(
        new ForbiddenException('not a member'),
      );

      await expect(service.getById(mockUser, 'circle-1')).rejects.toThrow(ForbiddenException);
      await expect(service.getById(mockUser, 'circle-1')).rejects.toThrow('not a member');
    });

    it('should return circle with counts when user is a member', async () => {
      const mockCircle = {
        id: 'circle-1',
        name: 'Test Circle',
        _count: { members: 3, mediaItems: 10 },
      };
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'viewer' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circle.findUnique.mockResolvedValue(mockCircle as any);

      const result = await service.getById(mockUser, 'circle-1');

      expect(mockMembership.requireOwnerRole).toHaveBeenCalledWith(
        'user-1',
        'circle-1',
        [],
        'viewer',
      );
      expect(result).toEqual(mockCircle);
    });
  });

  // ---- update() ----

  describe('update()', () => {
    it('should throw ForbiddenException when viewer tries to update (not circle_admin)', async () => {
      mockMembership.requireOwnerRole.mockRejectedValue(
        new ForbiddenException('This action requires circle_admin role or higher'),
      );

      await expect(
        service.update(mockUser, 'circle-1', { name: 'New Name' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should update circle when caller is circle_admin', async () => {
      const updatedCircle = {
        id: 'circle-1',
        name: 'New Name',
        description: null,
        isPersonal: false,
        ownerId: 'user-1',
      };

      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circle.update.mockResolvedValue(updatedCircle as any);

      const result = await service.update(mockUser, 'circle-1', { name: 'New Name' });

      expect(mockMembership.requireOwnerRole).toHaveBeenCalledWith(
        'user-1',
        'circle-1',
        [],
        'admin',
      );
      expect(mockPrisma.circle.update).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
        data: { name: 'New Name' },
      });
      expect(result).toEqual(updatedCircle);
    });
  });

  // ---- remove() ----

  describe('remove()', () => {
    it('should throw BadRequestException when trying to delete a personal circle', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circle.findUnique.mockResolvedValue({
        isPersonal: true,
        ownerId: 'user-1',
      } as any);

      await expect(service.remove(mockUser, 'circle-1')).rejects.toThrow(BadRequestException);
      await expect(service.remove(mockUser, 'circle-1')).rejects.toThrow(
        'Cannot delete a personal circle',
      );
      expect(mockPrisma.circle.delete).not.toHaveBeenCalled();
    });

    it('should delete non-personal circle when caller is circle_admin', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circle.findUnique.mockResolvedValue({
        isPersonal: false,
        ownerId: 'user-1',
      } as any);
      mockPrisma.circle.delete.mockResolvedValue({} as any);

      await service.remove(mockUser, 'circle-1');

      expect(mockPrisma.circle.delete).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
      });
    });

    it('should throw NotFoundException when circle does not exist', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circle.findUnique.mockResolvedValue(null);

      await expect(service.remove(mockUser, 'circle-nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ---- updateMemberRole() ----

  describe('updateMemberRole()', () => {
    it('should throw BadRequestException when demoting the last circle_admin', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'member-1',
        circleId: 'c1',
        userId: 'u1',
        role: CircleRole.circle_admin,
      } as any);
      mockPrisma.circleMember.count.mockResolvedValue(1);

      await expect(
        service.updateMemberRole(mockUser, 'c1', 'u1', { role: CircleRole.viewer }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateMemberRole(mockUser, 'c1', 'u1', { role: CircleRole.viewer }),
      ).rejects.toThrow('Cannot demote the last circle admin');
    });

    it('should allow demoting a circle_admin when there are multiple admins', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'member-1',
        circleId: 'c1',
        userId: 'u1',
        role: CircleRole.circle_admin,
      } as any);
      mockPrisma.circleMember.count.mockResolvedValue(2);
      mockPrisma.circleMember.update.mockResolvedValue({
        id: 'member-1',
        circleId: 'c1',
        userId: 'u1',
        role: CircleRole.viewer,
      } as any);

      const result = await service.updateMemberRole(mockUser, 'c1', 'u1', {
        role: CircleRole.viewer,
      });

      expect(mockPrisma.circleMember.update).toHaveBeenCalledWith({
        where: { circleId_userId: { circleId: 'c1', userId: 'u1' } },
        data: { role: CircleRole.viewer },
      });
      expect(result).toHaveProperty('role', CircleRole.viewer);
    });

    it('should throw NotFoundException when target user is not a member', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);

      await expect(
        service.updateMemberRole(mockUser, 'c1', 'non-member', { role: CircleRole.viewer }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---- removeMember() ----

  describe('removeMember()', () => {
    it('should throw BadRequestException when removing the last circle_admin', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'member-1',
        circleId: 'c1',
        userId: 'u2',
        role: CircleRole.circle_admin,
      } as any);
      mockPrisma.circleMember.count.mockResolvedValue(1);

      await expect(service.removeMember(mockUser, 'c1', 'u2')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.removeMember(mockUser, 'c1', 'u2')).rejects.toThrow(
        'Cannot remove the last circle admin',
      );
      expect(mockPrisma.circleMember.delete).not.toHaveBeenCalled();
    });

    it('should remove a viewer member successfully', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'member-2',
        circleId: 'c1',
        userId: 'u2',
        role: CircleRole.viewer,
      } as any);
      mockPrisma.circleMember.delete.mockResolvedValue({} as any);

      await service.removeMember(mockUser, 'c1', 'u2');

      expect(mockPrisma.circleMember.delete).toHaveBeenCalledWith({
        where: { circleId_userId: { circleId: 'c1', userId: 'u2' } },
      });
    });
  });

  // ---- addMember() ----

  describe('addMember()', () => {
    it('should upsert the circle member and trigger a membership-confirmation email', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target-user' } as any);
      mockPrisma.circleMember.upsert.mockResolvedValue({
        circleId: 'c1',
        userId: 'target-user',
        role: CircleRole.viewer,
        user: {
          id: 'target-user',
          email: 'target@example.com',
          displayName: null,
          providerDisplayName: 'Target',
        },
      } as any);
      mockPrisma.circle.findUnique.mockResolvedValue({
        name: 'Test Circle',
        description: 'A circle',
      } as any);

      const result = await service.addMember(mockUser, 'c1', {
        userId: 'target-user',
        role: CircleRole.viewer,
      });

      expect(mockPrisma.circleMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId_userId: { circleId: 'c1', userId: 'target-user' } },
        }),
      );
      expect(mockEmail.sendEmailAsync).toHaveBeenCalledWith(
        'target@example.com',
        'membership-confirmation',
        expect.objectContaining({ role: CircleRole.viewer }),
      );
      expect(result).toEqual(
        expect.objectContaining({ userId: 'target-user', role: CircleRole.viewer }),
      );
    });

    it('should throw NotFoundException when the target user does not exist', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.addMember(mockUser, 'c1', { userId: 'missing-user', role: CircleRole.viewer }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.circleMember.upsert).not.toHaveBeenCalled();
    });

    it('should still add the member even if the notification dispatch throws', async () => {
      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'admin' as const,
        isSuperAdmin: false,
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'target-user' } as any);
      mockPrisma.circleMember.upsert.mockResolvedValue({
        circleId: 'c1',
        userId: 'target-user',
        role: CircleRole.collaborator,
        user: {
          id: 'target-user',
          email: 'target@example.com',
          displayName: null,
          providerDisplayName: 'Target',
        },
      } as any);
      mockPrisma.circle.findUnique.mockResolvedValue({
        name: 'Test Circle',
        description: 'A circle',
      } as any);
      mockEmail.sendEmailAsync.mockImplementation(() => {
        throw new Error('email provider exploded');
      });

      const result = await service.addMember(mockUser, 'c1', {
        userId: 'target-user',
        role: CircleRole.collaborator,
      });

      expect(result).toEqual(
        expect.objectContaining({ userId: 'target-user', role: CircleRole.collaborator }),
      );
    });
  });

  // ---- list() ----

  describe('list()', () => {
    it('should return paginated envelope with member circles for regular user', async () => {
      const mockMemberships = [
        {
          role: CircleRole.circle_admin,
          circle: {
            id: 'c1',
            name: 'Alpha Circle',
            _count: { members: 3 },
          },
        },
        {
          role: CircleRole.viewer,
          circle: {
            id: 'c2',
            name: 'Beta Circle',
            _count: { members: 1 },
          },
        },
      ];

      mockPrisma.circleMember.findMany.mockResolvedValue(mockMemberships as any);

      const result = await service.list(mockUser, false);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ id: 'c1', memberRole: CircleRole.circle_admin });
      expect(result.items[1]).toMatchObject({ id: 'c2', memberRole: CircleRole.viewer });
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(result.pageSize).toBe(2);
    });

    it('should return empty envelope when user has no memberships', async () => {
      mockPrisma.circleMember.findMany.mockResolvedValue([]);

      const result = await service.list(mockUser, false);

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should throw ForbiddenException when non-super-admin requests all=true', async () => {
      const regularUser = { ...mockUser, permissions: [] };

      await expect(service.list(regularUser, true)).rejects.toThrow(ForbiddenException);
    });

    it('should return all circles in envelope for super-admin with all=true', async () => {
      const superAdminUser = {
        ...mockUser,
        permissions: ['circles:manage_any'],
      };
      const mockCircles = [
        { id: 'c1', name: 'Circle 1', _count: { members: 2 } },
        { id: 'c2', name: 'Circle 2', _count: { members: 5 } },
      ];

      mockPrisma.circle.findMany.mockResolvedValue(mockCircles as any);

      const result = await service.list(superAdminUser as any, true);

      expect(result.items).toEqual(mockCircles);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });

  // ---- listMembers() ----

  describe('listMembers()', () => {
    it('should return member envelope for a circle viewer', async () => {
      const mockMembers = [
        { id: 'm1', userId: 'u1', role: CircleRole.circle_admin, user: { id: 'u1', email: 'u1@test.com' } },
        { id: 'm2', userId: 'u2', role: CircleRole.viewer, user: { id: 'u2', email: 'u2@test.com' } },
      ];

      mockMembership.requireOwnerRole.mockResolvedValue({
        role: 'viewer' as const,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findMany.mockResolvedValue(mockMembers as any);

      const result = await service.listMembers(mockUser, 'c1');

      expect(mockMembership.requireOwnerRole).toHaveBeenCalledWith(
        'user-1',
        'c1',
        [],
        'viewer',
      );
      expect(result.items).toEqual(mockMembers);
      expect(result.total).toBe(2);
    });
  });


  // ---- invites (RETRO-I5: group invites through the sharing slice) ----

  describe('invites', () => {
    beforeEach(() => {
      mockPrisma.circle.findUnique.mockResolvedValue({ isPersonal: false } as any);
    });

    it('createInvite creates a group invite with the mapped role and answers the legacy shape', async () => {
      mockInvites.create.mockResolvedValue(groupInvite());

      const result = await service.createInvite(mockUser, 'c1', {
        email: 'person-b@example.test',
        role: CircleRole.collaborator,
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
        role: CircleRole.collaborator,
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
      [CircleRole.circle_admin, 'admin'],
      [CircleRole.viewer, 'viewer'],
    ])('maps %s to the group role %s', async (circleRole, groupRole) => {
      mockInvites.create.mockResolvedValue(groupInvite({ role: groupRole }));

      const result = await service.createInvite(mockUser, 'c1', { email: 'x@example.test', role: circleRole } as any);

      expect(mockInvites.create.mock.calls[0][2]).toEqual({ email: 'x@example.test', role: groupRole });
      expect(result.role).toBe(circleRole);
    });

    it('createInvite refuses a personal circle before reaching the slice', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue({ isPersonal: true } as any);

      await expect(
        service.createInvite(mockUser, 'c1', { email: 'x@example.test', role: CircleRole.viewer } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockInvites.create).not.toHaveBeenCalled();
    });

    it('createInvite surfaces the slice refusal (409 INVITE_PENDING) unchanged', async () => {
      mockInvites.create.mockRejectedValue(new ConflictException({ message: 'pending', details: { reason: 'INVITE_PENDING' } }));

      await expect(
        service.createInvite(mockUser, 'c1', { email: 'x@example.test', role: CircleRole.viewer } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('a circles:manage_any caller acts as groups:admin in the slice', async () => {
      mockInvites.create.mockResolvedValue(groupInvite());
      const superAdmin = { ...mockUser, permissions: ['circles:manage_any'] };

      await service.createInvite(superAdmin, 'c1', { email: 'x@example.test', role: CircleRole.viewer } as any);

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
      mockPrisma.circle.findUnique.mockResolvedValue({ isPersonal: true } as any);

      expect(await service.listInvites(mockUser, 'c1')).toEqual({ items: [], total: 0 });
      expect(mockInvites.list).not.toHaveBeenCalled();
    });

    it('revokeInvite revokes through the slice', async () => {
      await service.revokeInvite(mockUser, 'c1', 'inv-1');

      expect(mockInvites.revoke).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'c1', 'inv-1');
    });

    it('revokeInvite is a 404 for a personal circle', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue({ isPersonal: true } as any);

      await expect(service.revokeInvite(mockUser, 'c1', 'inv-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockInvites.revoke).not.toHaveBeenCalled();
    });
  });
});

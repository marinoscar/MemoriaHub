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
import { CircleMembershipService } from './circle-membership.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('CirclesService', () => {
  let service: CirclesService;
  let mockPrisma: MockPrismaService;
  let mockMembership: jest.Mocked<CircleMembershipService>;
  let mockAllowlist: jest.Mocked<AllowlistService>;

  const mockUser = {
    id: 'user-1',
    email: 'user@example.com',
    permissions: [],
  } as any;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: CircleRole.circle_admin, isSuperAdmin: false }),
      resolveRole: jest.fn().mockResolvedValue(CircleRole.circle_admin),
    } as any;

    mockAllowlist = {
      isEmailAllowed: jest.fn().mockResolvedValue(true),
      markEmailClaimed: jest.fn().mockResolvedValue(undefined),
      addEmail: jest.fn(),
      removeEmail: jest.fn(),
      listAllowedEmails: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CirclesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockMembership },
        { provide: AllowlistService, useValue: mockAllowlist },
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
      mockMembership.assertCircleAccess.mockRejectedValue(
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.viewer,
        isSuperAdmin: false,
      });
      mockPrisma.circle.findUnique.mockResolvedValue(mockCircle as any);

      const result = await service.getById(mockUser, 'circle-1');

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        'circle-1',
        [],
        CircleRole.viewer,
      );
      expect(result).toEqual(mockCircle);
    });
  });

  // ---- update() ----

  describe('update()', () => {
    it('should throw ForbiddenException when viewer tries to update (not circle_admin)', async () => {
      mockMembership.assertCircleAccess.mockRejectedValue(
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

      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circle.update.mockResolvedValue(updatedCircle as any);

      const result = await service.update(mockUser, 'circle-1', { name: 'New Name' });

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        'circle-1',
        [],
        CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circle.findUnique.mockResolvedValue(null);

      await expect(service.remove(mockUser, 'circle-nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ---- updateMemberRole() ----

  describe('updateMemberRole()', () => {
    it('should throw BadRequestException when demoting the last circle_admin', async () => {
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
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

  // ---- createInvite() ----

  describe('createInvite()', () => {
    it('should upsert allowedEmail and create a pending invite', async () => {
      const mockInvite = {
        id: 'invite-1',
        circleId: 'c1',
        email: 'test@example.com',
        role: CircleRole.viewer,
        claimedAt: null,
        addedById: 'user-1',
      };

      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.allowedEmail.upsert.mockResolvedValue({} as any);
      mockPrisma.circleInvite.findUnique.mockResolvedValue(null);
      mockPrisma.circleInvite.create.mockResolvedValue(mockInvite as any);

      const result = await service.createInvite(mockUser, 'c1', {
        email: 'test@example.com',
        role: CircleRole.viewer,
      });

      expect(mockPrisma.allowedEmail.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'test@example.com' },
        }),
      );
      expect(mockPrisma.circleInvite.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          circleId: 'c1',
          email: 'test@example.com',
          role: CircleRole.viewer,
          addedById: 'user-1',
        }),
      });
      expect(result).toEqual(mockInvite);
    });

    it('should update role on an existing pending invite', async () => {
      const existingPendingInvite = {
        id: 'invite-1',
        circleId: 'c1',
        email: 'test@example.com',
        role: CircleRole.viewer,
        claimedAt: null,
      };
      const updatedInvite = { ...existingPendingInvite, role: CircleRole.collaborator };

      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.allowedEmail.upsert.mockResolvedValue({} as any);
      mockPrisma.circleInvite.findUnique.mockResolvedValue(existingPendingInvite as any);
      mockPrisma.circleInvite.update.mockResolvedValue(updatedInvite as any);

      const result = await service.createInvite(mockUser, 'c1', {
        email: 'test@example.com',
        role: CircleRole.collaborator,
      });

      expect(mockPrisma.circleInvite.create).not.toHaveBeenCalled();
      expect(mockPrisma.circleInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId_email: { circleId: 'c1', email: 'test@example.com' } },
          data: expect.objectContaining({ role: CircleRole.collaborator }),
        }),
      );
      expect(result).toEqual(updatedInvite);
    });

    it('should throw ConflictException when invite is already claimed', async () => {
      const claimedInvite = {
        id: 'invite-1',
        circleId: 'c1',
        email: 'test@example.com',
        role: CircleRole.viewer,
        claimedAt: new Date(),
      };

      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.allowedEmail.upsert.mockResolvedValue({} as any);
      mockPrisma.circleInvite.findUnique.mockResolvedValue(claimedInvite as any);

      await expect(
        service.createInvite(mockUser, 'c1', {
          email: 'test@example.com',
          role: CircleRole.viewer,
        }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.createInvite(mockUser, 'c1', {
          email: 'test@example.com',
          role: CircleRole.viewer,
        }),
      ).rejects.toThrow('Invite already claimed by this user');
    });
  });

  // ---- revokeInvite() ----

  describe('revokeInvite()', () => {
    it('should throw BadRequestException when revoking an already-claimed invite', async () => {
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circleInvite.findUnique.mockResolvedValue({
        id: 'inv-1',
        circleId: 'c1',
        claimedAt: new Date(),
      } as any);

      await expect(service.revokeInvite(mockUser, 'c1', 'inv-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.revokeInvite(mockUser, 'c1', 'inv-1')).rejects.toThrow(
        'Cannot revoke an invite that has already been claimed',
      );
      expect(mockPrisma.circleInvite.delete).not.toHaveBeenCalled();
    });

    it('should delete a pending invite successfully', async () => {
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circleInvite.findUnique.mockResolvedValue({
        id: 'inv-1',
        circleId: 'c1',
        claimedAt: null,
      } as any);
      mockPrisma.circleInvite.delete.mockResolvedValue({} as any);

      await service.revokeInvite(mockUser, 'c1', 'inv-1');

      expect(mockPrisma.circleInvite.delete).toHaveBeenCalledWith({
        where: { id: 'inv-1' },
      });
    });

    it('should throw NotFoundException when invite does not exist', async () => {
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circleInvite.findUnique.mockResolvedValue(null);

      await expect(service.revokeInvite(mockUser, 'c1', 'non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when invite belongs to a different circle', async () => {
      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circleInvite.findUnique.mockResolvedValue({
        id: 'inv-1',
        circleId: 'different-circle',
        claimedAt: null,
      } as any);

      await expect(service.revokeInvite(mockUser, 'c1', 'inv-1')).rejects.toThrow(NotFoundException);
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

  // ---- listInvites() ----

  describe('listInvites()', () => {
    it('should return invite envelope for circle_admin', async () => {
      const mockInvites = [
        { id: 'inv-1', circleId: 'c1', email: 'a@test.com', claimedAt: null },
        { id: 'inv-2', circleId: 'c1', email: 'b@test.com', claimedAt: new Date() },
      ];

      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.circle_admin,
        isSuperAdmin: false,
      });
      mockPrisma.circleInvite.findMany.mockResolvedValue(mockInvites as any);

      const result = await service.listInvites(mockUser, 'c1');

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        'c1',
        [],
        CircleRole.circle_admin,
      );
      expect(result.items).toEqual(mockInvites);
      expect(result.total).toBe(2);
    });
  });

  // ---- listMembers() ----

  describe('listMembers()', () => {
    it('should return member envelope for a circle viewer', async () => {
      const mockMembers = [
        { id: 'm1', userId: 'u1', role: CircleRole.circle_admin, user: { id: 'u1', email: 'u1@test.com' } },
        { id: 'm2', userId: 'u2', role: CircleRole.viewer, user: { id: 'u2', email: 'u2@test.com' } },
      ];

      mockMembership.assertCircleAccess.mockResolvedValue({
        role: CircleRole.viewer,
        isSuperAdmin: false,
      });
      mockPrisma.circleMember.findMany.mockResolvedValue(mockMembers as any);

      const result = await service.listMembers(mockUser, 'c1');

      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        'user-1',
        'c1',
        [],
        CircleRole.viewer,
      );
      expect(result.items).toEqual(mockMembers);
      expect(result.total).toBe(2);
    });
  });

  // ---- getFaceSettings() ----

  describe('getFaceSettings()', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue({ faceRecognitionEnabled: true } as any);
      await service.getFaceSettings('circle-1', mockUser);
      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        mockUser.id, 'circle-1', mockUser.permissions, CircleRole.viewer
      );
    });

    it('throws NotFoundException when circle not found', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(null as any);
      await expect(service.getFaceSettings('circle-1', mockUser)).rejects.toThrow(NotFoundException);
    });

    it('returns { faceRecognitionEnabled } from the circle', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue({ faceRecognitionEnabled: true } as any);
      const result = await service.getFaceSettings('circle-1', mockUser);
      expect(result).toEqual({ faceRecognitionEnabled: true });
    });

    it('returns { faceRecognitionEnabled: false } when disabled', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue({ faceRecognitionEnabled: false } as any);
      const result = await service.getFaceSettings('circle-1', mockUser);
      expect(result).toEqual({ faceRecognitionEnabled: false });
    });
  });

  // ---- updateFaceSettings() ----

  describe('updateFaceSettings()', () => {
    it('calls assertCircleAccess with circle_admin role', async () => {
      mockPrisma.circle.update.mockResolvedValue({ faceRecognitionEnabled: true } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      await service.updateFaceSettings('circle-1', true, mockUser);
      expect(mockMembership.assertCircleAccess).toHaveBeenCalledWith(
        mockUser.id, 'circle-1', mockUser.permissions, CircleRole.circle_admin
      );
    });

    it('updates circle faceRecognitionEnabled to true', async () => {
      mockPrisma.circle.update.mockResolvedValue({ faceRecognitionEnabled: true } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      await service.updateFaceSettings('circle-1', true, mockUser);
      expect(mockPrisma.circle.update).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
        data: { faceRecognitionEnabled: true },
        select: { faceRecognitionEnabled: true },
      });
    });

    it('updates circle faceRecognitionEnabled to false', async () => {
      mockPrisma.circle.update.mockResolvedValue({ faceRecognitionEnabled: false } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      await service.updateFaceSettings('circle-1', false, mockUser);
      expect(mockPrisma.circle.update).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
        data: { faceRecognitionEnabled: false },
        select: { faceRecognitionEnabled: true },
      });
    });

    it('writes a circle:face_settings_update audit event', async () => {
      mockPrisma.circle.update.mockResolvedValue({ faceRecognitionEnabled: true } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      await service.updateFaceSettings('circle-1', true, mockUser);
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'circle:face_settings_update',
            targetId: 'circle-1',
          }),
        }),
      );
    });

    it('returns { faceRecognitionEnabled } from the updated circle', async () => {
      mockPrisma.circle.update.mockResolvedValue({ faceRecognitionEnabled: true } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      const result = await service.updateFaceSettings('circle-1', true, mockUser);
      expect(result).toEqual({ faceRecognitionEnabled: true });
    });
  });
});

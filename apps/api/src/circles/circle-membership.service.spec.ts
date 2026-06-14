import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { CircleMembershipService } from './circle-membership.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PERMISSIONS } from '../common/constants/roles.constants';

describe('CircleMembershipService', () => {
  let service: CircleMembershipService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleMembershipService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CircleMembershipService>(CircleMembershipService);
  });

  describe('resolveRole', () => {
    it('returns the role when member is found', async () => {
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'cm-1',
        circleId: 'circle-1',
        userId: 'user-1',
        role: CircleRole.collaborator,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.resolveRole('user-1', 'circle-1');
      expect(result).toBe(CircleRole.collaborator);
    });

    it('returns null when member is not found', async () => {
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);

      const result = await service.resolveRole('user-1', 'circle-1');
      expect(result).toBeNull();
    });
  });

  describe('assertCircleAccess', () => {
    const circleId = 'circle-1';
    const userId = 'user-1';
    const circleExists = { id: circleId };

    it('throws ForbiddenException for non-member', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(circleExists as any);
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);

      await expect(
        service.assertCircleAccess(userId, circleId, [], CircleRole.viewer),
      ).rejects.toThrow(new ForbiddenException('You are not a member of this circle'));
    });

    it('throws ForbiddenException when viewer tries collaborator action', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(circleExists as any);
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'cm-1',
        circleId,
        userId,
        role: CircleRole.viewer,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(
        service.assertCircleAccess(userId, circleId, [], CircleRole.collaborator),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.assertCircleAccess(userId, circleId, [], CircleRole.collaborator),
      ).rejects.toThrow('collaborator');
    });

    it('allows viewer for viewer-required action', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(circleExists as any);
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'cm-1',
        circleId,
        userId,
        role: CircleRole.viewer,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.assertCircleAccess(userId, circleId, [], CircleRole.viewer);
      expect(result).toEqual({ role: CircleRole.viewer, isSuperAdmin: false });
    });

    it('allows collaborator for collaborator-required action', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(circleExists as any);
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'cm-1',
        circleId,
        userId,
        role: CircleRole.collaborator,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.assertCircleAccess(userId, circleId, [], CircleRole.collaborator);
      expect(result).toEqual({ role: CircleRole.collaborator, isSuperAdmin: false });
    });

    it('allows circle_admin for circle_admin-required action', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(circleExists as any);
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'cm-1',
        circleId,
        userId,
        role: CircleRole.circle_admin,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.assertCircleAccess(userId, circleId, [], CircleRole.circle_admin);
      expect(result).toEqual({ role: CircleRole.circle_admin, isSuperAdmin: false });
    });

    it('throws NotFoundException when circle does not exist', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(null);

      await expect(
        service.assertCircleAccess(userId, circleId, [], CircleRole.viewer),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.assertCircleAccess(userId, circleId, [], CircleRole.viewer),
      ).rejects.toThrow('not found');
    });

    it('grants super-admin access via CIRCLES_MANAGE_ANY', async () => {
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);

      const result = await service.assertCircleAccess(
        userId,
        circleId,
        [PERMISSIONS.CIRCLES_MANAGE_ANY],
        CircleRole.circle_admin,
      );
      expect(result.isSuperAdmin).toBe(true);
    });

    it('grants super-admin access via MEDIA_WRITE_ANY', async () => {
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);

      const result = await service.assertCircleAccess(
        userId,
        circleId,
        [PERMISSIONS.MEDIA_WRITE_ANY],
        CircleRole.circle_admin,
      );
      expect(result.isSuperAdmin).toBe(true);
    });

    it('grants super-admin access via MEDIA_READ_ANY', async () => {
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);

      const result = await service.assertCircleAccess(
        userId,
        circleId,
        [PERMISSIONS.MEDIA_READ_ANY],
        CircleRole.circle_admin,
      );
      expect(result.isSuperAdmin).toBe(true);
    });

    it('throws ForbiddenException when collaborator tries circle_admin action', async () => {
      mockPrisma.circle.findUnique.mockResolvedValue(circleExists as any);
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        id: 'cm-1',
        circleId,
        userId,
        role: CircleRole.collaborator,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(
        service.assertCircleAccess(userId, circleId, [], CircleRole.circle_admin),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

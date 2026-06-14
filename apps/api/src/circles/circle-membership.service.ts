import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/constants/roles.constants';

const ROLE_RANK: Record<CircleRole, number> = {
  viewer: 1,
  collaborator: 2,
  circle_admin: 3,
};

@Injectable()
export class CircleMembershipService {
  private readonly logger = new Logger(CircleMembershipService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveRole(userId: string, circleId: string): Promise<CircleRole | null> {
    const member = await this.prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId, userId } },
    });
    return member?.role ?? null;
  }

  async assertCircleAccess(
    userId: string,
    circleId: string,
    permissions: string[],
    required: CircleRole,
  ): Promise<{ role: CircleRole | null; isSuperAdmin: boolean }> {
    // 1. Super-admin check
    const isSuperAdmin =
      permissions.includes(PERMISSIONS.CIRCLES_MANAGE_ANY) ||
      permissions.includes(PERMISSIONS.MEDIA_WRITE_ANY) ||
      permissions.includes(PERMISSIONS.MEDIA_READ_ANY);

    if (isSuperAdmin) {
      const role = await this.resolveRole(userId, circleId);
      return { role, isSuperAdmin: true };
    }

    // 2. Circle existence check
    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { id: true },
    });
    if (!circle) {
      throw new NotFoundException(`Circle ${circleId} not found`);
    }

    // 3. Membership check
    const role = await this.resolveRole(userId, circleId);
    if (role === null) {
      throw new ForbiddenException('You are not a member of this circle');
    }

    // 4. Rank check
    if (ROLE_RANK[role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`This action requires ${required} role or higher`);
    }

    return { role, isSuperAdmin: false };
  }
}

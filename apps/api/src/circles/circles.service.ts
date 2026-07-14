import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from './circle-membership.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { EmailService } from '../email/email.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CircleRole } from '@prisma/client';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateCircleDto } from './dto/create-circle.dto';
import { UpdateCircleDto } from './dto/update-circle.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { CreateInviteDto } from './dto/create-invite.dto';

const ROLE_RANK: Record<CircleRole, number> = {
  viewer: 1,
  collaborator: 2,
  circle_admin: 3,
};

@Injectable()
export class CirclesService {
  private readonly logger = new Logger(CirclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: CircleMembershipService,
    private readonly allowlist: AllowlistService,
    private readonly email: EmailService,
  ) {}

  /** Base URL for building absolute links in emails. */
  private appUrl(): string {
    return process.env['APP_URL'] || 'http://localhost:3535';
  }

  // ----- Circles -----

  async create(userId: string, dto: CreateCircleDto) {
    return this.prisma.$transaction(async (tx) => {
      const circle = await tx.circle.create({
        data: {
          name: dto.name,
          description: dto.description,
          ownerId: userId,
          isPersonal: false,
        },
      });
      await tx.circleMember.create({
        data: { circleId: circle.id, userId, role: CircleRole.circle_admin },
      });
      this.logger.log(`Circle created: ${circle.id} by user ${userId}`);
      return circle;
    });
  }

  async list(user: RequestUser, all: boolean) {
    if (all) {
      const isSuperAdmin = user.permissions.includes(PERMISSIONS.CIRCLES_MANAGE_ANY);
      if (!isSuperAdmin) {
        throw new ForbiddenException('circles:manage_any permission required');
      }
      const items = await this.prisma.circle.findMany({
        include: { _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      });
      return { items, total: items.length, page: 1, pageSize: items.length, totalPages: 1 };
    }

    const memberships = await this.prisma.circleMember.findMany({
      where: { userId: user.id },
      include: {
        circle: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { circle: { name: 'asc' } },
    });
    const items = memberships.map((m) => ({ ...m.circle, memberRole: m.role }));
    return { items, total: items.length, page: 1, pageSize: items.length, totalPages: 1 };
  }

  async getById(user: RequestUser, id: string) {
    await this.membership.assertCircleAccess(user.id, id, user.permissions, CircleRole.viewer);

    return this.prisma.circle.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            members: true,
            mediaItems: true,
          },
        },
      },
    });
  }

  async update(user: RequestUser, id: string, dto: UpdateCircleDto) {
    await this.membership.assertCircleAccess(user.id, id, user.permissions, CircleRole.circle_admin);

    return this.prisma.circle.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
      },
    });
  }

  async remove(user: RequestUser, id: string) {
    await this.membership.assertCircleAccess(user.id, id, user.permissions, CircleRole.circle_admin);

    const circle = await this.prisma.circle.findUnique({
      where: { id },
      select: { isPersonal: true, ownerId: true },
    });
    if (!circle) throw new NotFoundException(`Circle ${id} not found`);
    if (circle.isPersonal) {
      throw new BadRequestException('Cannot delete a personal circle');
    }

    await this.prisma.circle.delete({ where: { id } });
    this.logger.log(`Circle ${id} deleted by user ${user.id}`);
  }

  // ----- Members -----

  async listMembers(user: RequestUser, circleId: string) {
    await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.viewer);
    const items = await this.prisma.circleMember.findMany({
      where: { circleId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            providerDisplayName: true,
            profileImageUrl: true,
            providerProfileImageUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { items, total: items.length };
  }

  async addMember(user: RequestUser, circleId: string, dto: AddMemberDto) {
    await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.circle_admin);

    // Verify target user exists
    const targetUser = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundException(`User ${dto.userId} not found`);

    const member = await this.prisma.circleMember.upsert({
      where: { circleId_userId: { circleId, userId: dto.userId } },
      update: { role: dto.role },
      create: { circleId, userId: dto.userId, role: dto.role },
      include: {
        user: {
          select: { id: true, email: true, displayName: true, providerDisplayName: true },
        },
      },
    });

    // Membership-confirmation email (best-effort, fire-and-forget).
    if (member.user?.email) {
      await this.sendMembershipEmail(circleId, member.user.email, dto.role);
    }

    return member;
  }

  /**
   * Best-effort membership-confirmation email. Never blocks or fails the request.
   */
  private async sendMembershipEmail(
    circleId: string,
    recipientEmail: string,
    role: string,
  ): Promise<void> {
    try {
      const circle = await this.prisma.circle.findUnique({
        where: { id: circleId },
        select: { name: true, description: true },
      });
      if (!circle) return;

      this.email.sendEmailAsync(recipientEmail, 'membership-confirmation', {
        circleName: circle.name,
        circleDescription: circle.description ?? undefined,
        role,
        viewUrl: `${this.appUrl()}/circles/${circleId}`,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue membership-confirmation email: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async updateMemberRole(
    user: RequestUser,
    circleId: string,
    targetUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.circle_admin);

    const existing = await this.prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId, userId: targetUserId } },
    });
    if (!existing) {
      throw new NotFoundException(`User ${targetUserId} is not a member of circle ${circleId}`);
    }

    // Guard: cannot demote the last circle_admin
    if (existing.role === CircleRole.circle_admin && dto.role !== CircleRole.circle_admin) {
      const adminCount = await this.prisma.circleMember.count({
        where: { circleId, role: CircleRole.circle_admin },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot demote the last circle admin');
      }
    }

    return this.prisma.circleMember.update({
      where: { circleId_userId: { circleId, userId: targetUserId } },
      data: { role: dto.role },
    });
  }

  async removeMember(user: RequestUser, circleId: string, targetUserId: string) {
    const isSelf = user.id === targetUserId;

    if (!isSelf) {
      await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.circle_admin);
    } else {
      // Self-leave: must at least be a member (viewer-level)
      await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.viewer);
    }

    const existing = await this.prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId, userId: targetUserId } },
    });
    if (!existing) {
      throw new NotFoundException(`User ${targetUserId} is not a member of circle ${circleId}`);
    }

    // Guard: cannot remove last circle_admin
    if (existing.role === CircleRole.circle_admin) {
      const adminCount = await this.prisma.circleMember.count({
        where: { circleId, role: CircleRole.circle_admin },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Cannot remove the last circle admin');
      }
    }

    await this.prisma.circleMember.delete({
      where: { circleId_userId: { circleId, userId: targetUserId } },
    });
  }

  // ----- Invites -----

  async listInvites(user: RequestUser, circleId: string) {
    await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.circle_admin);
    const items = await this.prisma.circleInvite.findMany({
      where: { circleId },
      orderBy: { addedAt: 'desc' },
    });
    return { items, total: items.length };
  }

  async createInvite(user: RequestUser, circleId: string, dto: CreateInviteDto) {
    await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.circle_admin);

    const email = dto.email; // already lowercased by Zod transform

    // Upsert into AllowedEmail so the invitee can log in
    await this.prisma.allowedEmail.upsert({
      where: { email },
      update: {}, // already allowed, no update needed
      create: {
        email,
        notes: dto.notes ?? `Invited to circle by user ${user.id}`,
        addedById: user.id,
      },
    });

    // Check for existing invite
    const existing = await this.prisma.circleInvite.findUnique({
      where: { circleId_email: { circleId, email } },
    });

    if (existing) {
      if (existing.claimedAt !== null) {
        throw new ConflictException('Invite already claimed by this user');
      }
      // Update role on pending invite
      const updated = await this.prisma.circleInvite.update({
        where: { circleId_email: { circleId, email } },
        data: { role: dto.role, notes: dto.notes },
      });
      // Only re-send on a GENUINE role change, not an idempotent repeat call.
      if (existing.role !== dto.role) {
        await this.sendInvitationEmail(circleId, email, user.id);
      }
      return updated;
    }

    const created = await this.prisma.circleInvite.create({
      data: {
        circleId,
        email,
        role: dto.role,
        notes: dto.notes,
        addedById: user.id,
      },
    });

    // New invite — send the invitation email (fire-and-forget).
    await this.sendInvitationEmail(circleId, email, user.id);

    return created;
  }

  /**
   * Best-effort circle-invitation email. Never blocks or fails the request path.
   */
  private async sendInvitationEmail(
    circleId: string,
    recipientEmail: string,
    inviterUserId: string,
  ): Promise<void> {
    try {
      const [circle, inviter] = await Promise.all([
        this.prisma.circle.findUnique({
          where: { id: circleId },
          select: { name: true },
        }),
        this.prisma.user.findUnique({
          where: { id: inviterUserId },
          select: { displayName: true, providerDisplayName: true },
        }),
      ]);
      if (!circle) return;

      const inviterName =
        inviter?.displayName ?? inviter?.providerDisplayName ?? undefined;
      const acceptUrl = `${this.appUrl()}/activate?returnTo=${encodeURIComponent(
        `/circles/${circleId}`,
      )}`;

      this.email.sendEmailAsync(recipientEmail, 'circle-invitation', {
        circleName: circle.name,
        inviterName,
        acceptUrl,
        recipientEmail,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue circle-invitation email: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async revokeInvite(user: RequestUser, circleId: string, inviteId: string) {
    await this.membership.assertCircleAccess(user.id, circleId, user.permissions, CircleRole.circle_admin);

    const invite = await this.prisma.circleInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new NotFoundException(`Invite ${inviteId} not found`);
    if (invite.circleId !== circleId) throw new NotFoundException(`Invite ${inviteId} not found`);
    if (invite.claimedAt !== null) {
      throw new BadRequestException('Cannot revoke an invite that has already been claimed');
    }

    await this.prisma.circleInvite.delete({ where: { id: inviteId } });
    this.logger.log(`Invite ${inviteId} revoked by user ${user.id}`);
  }
}

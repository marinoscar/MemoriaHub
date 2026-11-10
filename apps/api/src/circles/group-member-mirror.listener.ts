import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { UserPrincipal } from '@marinoscar/platform-api/core';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import {
  GroupsService,
  SHARING_EVENTS,
  type GroupInviteAutoAcceptedPayload,
  type GroupMemberEventPayload,
  type GroupEventPayload,
} from '@marinoscar/platform-api/sharing';
import { CircleRole } from '@prisma/client';

import { MEMORIAHUB_EMAIL_EVENT_KEYS } from '../notifications-registry/memoriahub-email.notifications';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// Group membership written by the sharing slice -> circle_members (RETRO-I5, #583)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(RETRO-I6): until circles are dropped, the circle list
// (`GET /api/circles`), the member list and the onboarding facts still read
// `circle_members`, while access is decided on `group_members` (RETRO-I3). The
// RETRO-I2 trigger keeps `circle_members -> group_members` equal; this listener
// is the way back for the writes the SLICE makes, which the trigger never sees:
//
//   sharing.group.member_added        a group invite accepted or auto-accepted
//   sharing.group.member_role_changed (the former circle-invite claim), or a
//   sharing.group.member_removed      member written through /api/groups/**
//
// Each upserts (or deletes) the circle member of the circle with the group's
// id, with the mapped role (admin -> circle_admin, editor -> collaborator,
// viewer -> viewer). The trigger then rewrites group_members with the SAME role,
// so nothing loops. A group with no circle (created through /api/groups) and a
// personal circle are left alone.
//
// It also sends the membership-confirmation e-mail the former claim sent, on
// `sharing.group.invite_auto_accepted` when the invite changed something
// (joined or upgraded), fire-and-forget like before.
//
// The events are emitted after the slice's transaction committed; every body
// is one or two small database writes (the `on-event-no-io` rule) and never
// throws (a failure is logged; the next membership write converges it).
// =============================================================================

/** Group role -> the circle role the circle tables still store. */
const GROUP_ROLE_TO_CIRCLE_ROLE: Readonly<Record<string, CircleRole>> = Object.freeze({
  admin: CircleRole.circle_admin,
  editor: CircleRole.collaborator,
  viewer: CircleRole.viewer,
});

@Injectable()
export class GroupMemberMirrorListener {
  private readonly logger = new Logger(GroupMemberMirrorListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly groups: GroupsService,
  ) {}

  /**
   * A group created through `/api/groups` (RETRO-I6, #684): create the circle of the same id
   * and its creator's `circle_admin` membership. Without the circle, every content row's
   * `circle_id` foreign key (and `OwnerAccessService.resolveOwner`) would refuse the group.
   * Idempotent. The RETRO-I2 trigger `mh_circle_mirror_group` then finds the group already
   * there (`ON CONFLICT DO NOTHING`) and `mh_circle_member_mirror` re-writes the creator's
   * `group_members` row with the same role, so nothing loops. The creator's membership is
   * written HERE rather than left to the `member_added` event that follows, because the two
   * listeners run concurrently and that one skips a circle that does not exist yet.
   *
   * `groups` is read through the slice's `GroupsService` (the `no-direct-access` rule), `circles`
   * and `circle_members` are the app's own tables.
   * A group DELETE is not mirrored: `mh_group_mirror_guard` refuses deleting a group whose
   * circle exists (delete the circle instead, as for every mirrored group), and the slice has
   * no rename event, so a rename through `/api/groups` does not reach the circle's name.
   */
  @OnEvent(SHARING_EVENTS.GROUP_CREATED)
  async onGroupCreated(event: GroupEventPayload): Promise<void> {
    try {
      // Through the slice (`GroupsService.get`, as the creator who is its first admin).
      const group = await this.groups.get(creatorPrincipal(event), event.groupId).catch(() => null);
      if (!group) return;
      const ownerId = group.createdById ?? event.actorUserId;
      if (!ownerId) return;
      await this.prisma.circle.upsert({
        where: { id: event.groupId },
        update: {},
        create: { id: event.groupId, name: group.name, description: group.description, ownerId, isPersonal: false },
      });
      await this.prisma.circleMember.upsert({
        where: { circleId_userId: { circleId: event.groupId, userId: ownerId } },
        update: { role: CircleRole.circle_admin },
        create: { circleId: event.groupId, userId: ownerId, role: CircleRole.circle_admin },
      });
    } catch (err) {
      this.logger.warn(`Mirroring the creation of group ${event.groupId} into a circle failed: ${describe(err)}`);
    }
  }

  @OnEvent(SHARING_EVENTS.MEMBER_ADDED)
  async onMemberAdded(event: GroupMemberEventPayload): Promise<void> {
    await this.mirror(event);
  }

  @OnEvent(SHARING_EVENTS.MEMBER_ROLE_CHANGED)
  async onMemberRoleChanged(event: GroupMemberEventPayload): Promise<void> {
    await this.mirror(event);
  }

  @OnEvent(SHARING_EVENTS.MEMBER_REMOVED)
  async onMemberRemoved(event: GroupMemberEventPayload): Promise<void> {
    try {
      if (!(await this.sharedCircle(event.groupId))) return;
      await this.prisma.circleMember.deleteMany({ where: { circleId: event.groupId, userId: event.userId } });
    } catch (err) {
      this.logger.warn(`Mirroring the removal from group ${event.groupId} failed: ${describe(err)}`);
    }
  }

  @OnEvent(SHARING_EVENTS.INVITE_AUTO_ACCEPTED)
  async onInviteAutoAccepted(event: GroupInviteAutoAcceptedPayload): Promise<void> {
    if (event.outcome === 'unchanged') return;
    try {
      const [circle, user] = await Promise.all([
        this.sharedCircle(event.groupId),
        this.prisma.user.findUnique({ where: { id: event.userId }, select: { email: true } }),
      ]);
      if (!circle || !user) return;
      const appUrl = process.env['APP_URL'] || 'http://localhost:3535';
      void this.notifications.notifyAddress(MEMORIAHUB_EMAIL_EVENT_KEYS.membershipConfirmed, user.email, {
        circleName: circle.name,
        circleDescription: circle.description ?? undefined,
        role: GROUP_ROLE_TO_CIRCLE_ROLE[event.memberRole] ?? event.memberRole,
        viewUrl: `${appUrl}/circles/${event.groupId}`,
      });
    } catch (err) {
      this.logger.warn(`Membership-confirmation e-mail for group ${event.groupId} failed: ${describe(err)}`);
    }
  }

  private async mirror(event: GroupMemberEventPayload): Promise<void> {
    const role = event.role ? GROUP_ROLE_TO_CIRCLE_ROLE[event.role] : undefined;
    if (!role) return;
    try {
      if (!(await this.sharedCircle(event.groupId))) return;
      await this.prisma.circleMember.upsert({
        where: { circleId_userId: { circleId: event.groupId, userId: event.userId } },
        update: { role },
        create: { circleId: event.groupId, userId: event.userId, role },
      });
    } catch (err) {
      this.logger.warn(`Mirroring the membership of group ${event.groupId} failed: ${describe(err)}`);
    }
  }

  /** The shared circle mirrored by the group, or `null` (no circle, or a personal one). */
  private async sharedCircle(groupId: string): Promise<{ name: string; description: string | null } | null> {
    const circle = await this.prisma.circle.findUnique({
      where: { id: groupId },
      select: { name: true, description: true, isPersonal: true },
    });
    return circle && !circle.isPersonal ? circle : null;
  }
}

/** The creator of a just-created group, as the principal that may read it (single organization mode). */
function creatorPrincipal(event: GroupEventPayload): UserPrincipal {
  return {
    kind: 'user',
    userId: event.actorUserId,
    email: '',
    credential: 'session',
    roles: [],
    permissions: [],
    activeOrgId: event.orgId,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

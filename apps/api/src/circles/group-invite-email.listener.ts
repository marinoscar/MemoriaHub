import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { SHARING_EVENTS, type GroupInviteAutoAcceptedPayload } from '@marinoscar/platform-api/sharing';

import { MEMORIAHUB_EMAIL_EVENT_KEYS } from '../notifications-registry/memoriahub-email.notifications';
import { OwnerScopeSweepService } from '../platform/sharing/owner-scope-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { GROUP_ROLE_TO_CIRCLE_ROLE } from './circle-role';

// =============================================================================
// The membership-confirmation e-mail of an auto-accepted group invite (RETRO-I5, #583; RETRO-K2)
// =============================================================================
//
// Until RETRO-K2 this class was `GroupMemberMirrorListener`, which also copied group membership
// into `circle_members` and created a circle for a group made through `/api/groups`. The circle
// tables are gone, so only the e-mail is left: on `sharing.group.invite_auto_accepted`, when the
// invite changed something (joined or upgraded), the invitee gets `circles.membership_confirmed`,
// fire-and-forget, as the former claim sent.
//
// The event is emitted after the slice's transaction committed; the body is two small reads and a
// detached notification (the `on-event-no-io` rule) and never throws.
// =============================================================================

@Injectable()
export class GroupInviteEmailListener {
  private readonly logger = new Logger(GroupInviteEmailListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly scopes: OwnerScopeSweepService,
  ) {}

  @OnEvent(SHARING_EVENTS.INVITE_AUTO_ACCEPTED)
  async onInviteAutoAccepted(event: GroupInviteAutoAcceptedPayload): Promise<void> {
    if (event.outcome === 'unchanged') return;
    try {
      const [group, user] = await Promise.all([
        this.scopes.summary(event.groupId),
        this.prisma.user.findUnique({ where: { id: event.userId }, select: { email: true } }),
      ]);
      if (!group || !user) return;
      const appUrl = process.env['APP_URL'] || 'http://localhost:3535';
      void this.notifications.notifyAddress(MEMORIAHUB_EMAIL_EVENT_KEYS.membershipConfirmed, user.email, {
        circleName: group.name,
        role: GROUP_ROLE_TO_CIRCLE_ROLE[event.memberRole] ?? event.memberRole,
        viewUrl: `${appUrl}/circles/${event.groupId}`,
      });
    } catch (err) {
      this.logger.warn(
        `Membership-confirmation e-mail for group ${event.groupId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type {
  AllowlistInvitationNotice,
  IdentityNotifier,
  OrgInvitationNotice,
  RoleChangedNotice,
  UserWelcomeNotice,
} from '@marinoscar/platform-api/identity';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { IDENTITY_EVENT_KEYS } from '../../notifications-registry/platform-slice.notifications';

// =============================================================================
// IDENTITY_NOTIFIER -> the platform notification dispatcher (RETRO-D3, #576)
// =============================================================================
//
// The identity slice raises four notifications. Three go through the platform
// `NotificationsService` as the events declared in
// `notifications-registry/platform-slice.notifications.ts` (`user.welcome`,
// `allowlist.invitation`, `security.role_changed`), each bound to the platform
// email template of the same purpose. MemoriaHub sent none of them before this
// slice, so those events are declared `defaultEnabled: false`: an existing user
// receives nothing new unless they turn one on. The organization invitation
// drops by design: single-organization mode hides invitations.
// =============================================================================

@Injectable()
export class MemoriaHubIdentityNotifier implements IdentityNotifier {
  private readonly logger = new Logger(MemoriaHubIdentityNotifier.name);

  constructor(private readonly notifications: NotificationsService) {}

  async roleChanged(userId: string, notice: RoleChangedNotice): Promise<void> {
    await this.notifications.notify(IDENTITY_EVENT_KEYS.roleChanged, userId, {
      recipientEmail: notice.recipientEmail,
      previousRoles: notice.previousRoles,
      currentRoles: notice.currentRoles,
      changedAt: notice.changedAt,
      ...(notice.appUrl ? { appUrl: notice.appUrl } : {}),
    });
  }

  async userWelcomed(userId: string, notice: UserWelcomeNotice): Promise<void> {
    await this.notifications.notify(IDENTITY_EVENT_KEYS.welcome, userId, {
      recipientEmail: notice.recipientEmail,
      ...(notice.recipientName ? { recipientName: notice.recipientName } : {}),
      roles: notice.roles,
      ...(notice.appUrl ? { appUrl: notice.appUrl } : {}),
    });
  }

  async allowlistInvitation(email: string, notice: AllowlistInvitationNotice): Promise<void> {
    await this.notifications.notifyAddress(IDENTITY_EVENT_KEYS.allowlistInvitation, email, {
      recipientEmail: notice.recipientEmail,
      ...(notice.invitedBy ? { invitedBy: notice.invitedBy } : {}),
      ...(notice.signInUrl ? { signInUrl: notice.signInUrl } : {}),
    });
  }

  async orgInvitation(_email: string, notice: OrgInvitationNotice): Promise<void> {
    this.logger.debug(`organization invitation to "${notice.orgName}" dropped (single-organization mode)`);
  }
}

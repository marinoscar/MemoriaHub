import { Injectable, Logger } from '@nestjs/common';
import type {
  AllowlistInvitationNotice,
  IdentityNotifier,
  OrgInvitationNotice,
  RoleChangedNotice,
  UserWelcomeNotice,
} from '@marinoscar/platform-api/identity';

// =============================================================================
// IDENTITY_NOTIFIER -> MemoriaHub's email code (RETRO-B2, issue #611)
// =============================================================================
//
// The identity slice raises four notifications: role changed, welcome,
// allowlist invitation, organization invitation. MemoriaHub's email service
// (`src/email`) has templates for circle invitations, membership confirmations,
// broadcasts and the memory digest only, and before this slice nothing sent any
// of the four. To keep the behaviour (no new mail on sign-up or on a role edit),
// every method logs at debug level and drops; the organization invitation drops
// by design, since single-organization mode hides invitations.
//
// PLATFORM-ADOPTION-SHIM(RETRO-D2): the email slice brings the four templates;
// the notifications slice (RETRO-D3) replaces this adapter with the platform's
// notification dispatcher.
// =============================================================================

@Injectable()
export class MemoriaHubIdentityNotifier implements IdentityNotifier {
  private readonly logger = new Logger(MemoriaHubIdentityNotifier.name);

  async roleChanged(userId: string, _notice: RoleChangedNotice): Promise<void> {
    this.logger.debug(`role-changed notice for user ${userId} dropped (no template)`);
  }

  async userWelcomed(userId: string, _notice: UserWelcomeNotice): Promise<void> {
    this.logger.debug(`welcome notice for user ${userId} dropped (no template)`);
  }

  async allowlistInvitation(_email: string, _notice: AllowlistInvitationNotice): Promise<void> {
    this.logger.debug('allowlist-invitation notice dropped (no template)');
  }

  async orgInvitation(_email: string, _notice: OrgInvitationNotice): Promise<void> {
    this.logger.debug('organization-invitation notice dropped (single-organization mode)');
  }
}

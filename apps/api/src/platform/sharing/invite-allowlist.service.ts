import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// An invitation to a group allowlists the invitee (RETRO-I5, #583)
// =============================================================================
//
// MemoriaHub's rule since circles: inviting an address to a circle also lets
// that address sign in (the e-mail allowlist gates every sign-in). Circle
// invites are group invites now, created by the sharing slice
// (`GroupInvitesService.create`, behind `POST /api/groups/:id/invites` and the
// app's `POST /api/circles/:id/invites`), and the slice knows nothing about the
// allowlist. Its notifier port is the one place that receives the invited
// ADDRESS after the invite committed (`sharing.group.invite_created` carries ids
// only), so `SharingNotifierAdapter` calls `ensureAllowed` for every
// `groups.invitation` before the e-mail is dispatched.
//
// PLATFORM-ADOPTION-SHIM(RETRO-SEAM-ALLOWLIST-ENSURE): the identity slice's
// `AllowlistService.addEmail` also mails its own `allowlist.invitation` (a second
// e-mail to someone who just got the group invitation) and refuses an existing
// entry with 409 (and the identity module does not export it to the app), so
// this upserts the entry itself (an existing one is left untouched), exactly as
// the former circle invite did. Seam
// request: an idempotent, silent allowlist entry (docs/platform-adoption/local-
// exceptions.md). Never throws: a failed upsert is logged and the e-mail is
// still sent (an administrator can allowlist the address by hand).
// =============================================================================

@Injectable()
export class InviteAllowlistService {
  private readonly logger = new Logger(InviteAllowlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Makes sure `email` may sign in. `actorUserId` is recorded as who added it. */
  async ensureAllowed(email: string, actorUserId?: string): Promise<void> {
    const address = email.trim().toLowerCase();
    if (!address) return;
    try {
      await this.prisma.allowedEmail.upsert({
        where: { email: address },
        update: {},
        create: {
          email: address,
          notes: 'Invited to a group',
          ...(actorUserId ? { addedById: actorUserId } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(`Allowlisting an invited address failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

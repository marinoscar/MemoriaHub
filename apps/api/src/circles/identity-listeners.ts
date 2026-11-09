import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IDENTITY_EVENTS, type IdentityUserCreatedEvent } from '@marinoscar/platform-api/identity';

import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// Circles reacting to the identity slice's events (RETRO-B2, issue #611)
// =============================================================================
//
// A NEW user gets a personal circle (`isPersonal`, the user `circle_admin`).
// The identity package owns sign-in, so this hangs off its
// `identity.user.created` event, emitted after the user's transaction
// committed (outside any transaction).
//
// INVITES ARE NOT CLAIMED HERE ANY MORE (RETRO-I5, #583): circle invites are
// platform group invites, and the sharing slice's own listener claims them at
// sign-up and at every sign-in (`groups.autoAcceptInvitesOnSignup` /
// `autoAcceptInvitesOnSignIn`, `platform/sharing/sharing.config.ts`), joining or
// upgrading, never downgrading. The membership-confirmation e-mail and the
// circle_members row of a claimed invite are `group-member-mirror.listener.ts`.
//
// DATABASE WRITES ONLY IN THE HANDLER BODY (the `on-event-no-io` rule). A
// throwing handler is caught and logged here: sign-in never fails because of a
// circle. IDEMPOTENT AND RACE-SAFE: the writer serialises on a per-user
// transaction-scoped advisory lock and re-reads inside it.
//
// PLATFORM-ADOPTION-SHIM(RETRO-I6): the personal circle becomes the user's own
// library when circles are dropped.
// =============================================================================

@Injectable()
export class CircleIdentityListeners {
  private readonly logger = new Logger(CircleIdentityListeners.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(IDENTITY_EVENTS.USER_CREATED)
  async onUserCreated(event: IdentityUserCreatedEvent): Promise<void> {
    try {
      await this.ensurePersonalCircle(event.userId, event.email);
    } catch (err) {
      this.logger.error(`user.created handling failed for ${event.userId}: ${describe(err)}`);
    }
  }

  /** Exactly one personal circle per user: the lock plus the re-read make a repeat a no-op. */
  async ensurePersonalCircle(userId: string, email: string): Promise<void> {
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`circles:user:${userId}`}))`;

      const existing = await tx.circle.findFirst({
        where: { ownerId: userId, isPersonal: true },
        select: { id: true },
      });
      if (existing) return false;

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { displayName: true, providerDisplayName: true },
      });
      const circle = await tx.circle.create({
        data: {
          name: `${user?.displayName || user?.providerDisplayName || email}'s Library`,
          ownerId: userId,
          isPersonal: true,
        },
      });
      await tx.circleMember.create({
        data: { circleId: circle.id, userId, role: 'circle_admin' as const },
      });
      return true;
    });

    if (created) this.logger.log(`Personal circle created for user: ${userId}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IDENTITY_EVENTS,
  type IdentityLoginSucceededEvent,
  type IdentityUserCreatedEvent,
} from '@marinoscar/platform-api/identity';

import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { MEMORIAHUB_EMAIL_EVENT_KEYS } from '../notifications-registry/memoriahub-email.notifications';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// Circles reacting to the identity slice's events (RETRO-B2, issue #611)
// =============================================================================
//
// Two things used to happen inline in the app's `AuthService`:
//
//   1. a NEW user got a personal circle (`isPersonal`, the user `circle_admin`),
//      inside the user-creation transaction;
//   2. every sign-in claimed the pending circle invites for the user's email
//      (joining or upgrading, never downgrading) and mailed a membership
//      confirmation for each membership that changed.
//
// The identity package owns sign-in now, so both hang off its events, which are
// emitted after the user's transaction committed (outside any transaction).
// `identity.user.created` creates the personal circle and claims invites;
// `identity.login.succeeded` claims invites for later sign-ins (an invite
// created after the user's first login is claimed by the next one).
//
// DATABASE WRITES ONLY IN THE HANDLER BODIES (the `on-event-no-io` rule: no
// download, upload or storage-provider call); the confirmation email is the
// existing fire-and-forget `sendEmailAsync`. A throwing handler is caught by
// the emitter and logged here: sign-in never fails because of a circle.
//
// IDEMPOTENT AND RACE-SAFE: `user.created` and `login.succeeded` fire back to
// back on a first sign-in, so both writers serialise on a per-user
// transaction-scoped advisory lock, and each re-reads inside the lock.
//
// PLATFORM-ADOPTION-SHIM(RETRO-I5): circle invites become sharing invites and the
// personal circle a personal group when circles move to the sharing slice.
// =============================================================================

const ROLE_RANK: Record<string, number> = { viewer: 1, collaborator: 2, circle_admin: 3 };

@Injectable()
export class CircleIdentityListeners {
  private readonly logger = new Logger(CircleIdentityListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(IDENTITY_EVENTS.USER_CREATED)
  async onUserCreated(event: IdentityUserCreatedEvent): Promise<void> {
    try {
      await this.ensurePersonalCircle(event.userId, event.email);
      await this.claimPendingInvites(event.userId, event.email);
    } catch (err) {
      this.logger.error(`user.created handling failed for ${event.userId}: ${describe(err)}`);
    }
  }

  @OnEvent(IDENTITY_EVENTS.LOGIN_SUCCEEDED)
  async onLoginSucceeded(event: IdentityLoginSucceededEvent): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: event.userId },
        select: { email: true },
      });
      if (user) await this.claimPendingInvites(event.userId, user.email);
    } catch (err) {
      this.logger.error(`login.succeeded handling failed for ${event.userId}: ${describe(err)}`);
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

  /** Claims every unclaimed invite for the email: join, or upgrade a lower role, never downgrade. */
  async claimPendingInvites(userId: string, email: string): Promise<void> {
    const address = email.toLowerCase();
    const pending = await this.prisma.circleInvite.findMany({
      where: { email: address, claimedAt: null },
      select: { id: true },
    });

    for (const { id } of pending) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`circles:user:${userId}`}))`;

        // Re-read under the lock: another handler may have claimed it already.
        const invite = await tx.circleInvite.findFirst({ where: { id, claimedAt: null } });
        if (!invite) return null;

        const existing = await tx.circleMember.findUnique({
          where: { circleId_userId: { circleId: invite.circleId, userId } },
        });

        let changed = false;
        if (existing) {
          if ((ROLE_RANK[invite.role] ?? 0) > (ROLE_RANK[existing.role] ?? 0)) {
            await tx.circleMember.update({
              where: { circleId_userId: { circleId: invite.circleId, userId } },
              data: { role: invite.role },
            });
            changed = true;
          }
        } else {
          await tx.circleMember.create({ data: { circleId: invite.circleId, userId, role: invite.role } });
          changed = true;
        }

        await tx.circleInvite.update({
          where: { id: invite.id },
          data: { claimedById: userId, claimedAt: new Date() },
        });
        return { circleId: invite.circleId, role: invite.role, changed };
      });

      if (!outcome) continue;
      this.logger.log(`Circle invite ${id} claimed by user ${userId} for circle ${outcome.circleId}`);
      if (outcome.changed) await this.sendMembershipConfirmation(outcome.circleId, address, outcome.role);
    }
  }

  /** Best-effort membership-confirmation email. Never throws. */
  private async sendMembershipConfirmation(circleId: string, to: string, role: string): Promise<void> {
    try {
      const circle = await this.prisma.circle.findUnique({
        where: { id: circleId },
        select: { name: true, description: true },
      });
      if (!circle) return;

      const appUrl = process.env['APP_URL'] || 'http://localhost:3535';
      void this.notifications.notifyAddress(MEMORIAHUB_EMAIL_EVENT_KEYS.membershipConfirmed, to, {
        circleName: circle.name,
        circleDescription: circle.description ?? undefined,
        role,
        viewUrl: `${appUrl}/circles/${circleId}`,
      });
    } catch (err) {
      this.logger.warn(`Failed to enqueue membership-confirmation email on invite claim: ${describe(err)}`);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

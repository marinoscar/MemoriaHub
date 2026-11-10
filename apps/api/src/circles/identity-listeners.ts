import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IDENTITY_EVENTS, type IdentityUserCreatedEvent } from '@marinoscar/platform-api/identity';

import { PersonalLibraryStore } from '../platform/sharing/personal-library.store';

// =============================================================================
// Circles reacting to the identity slice's events (RETRO-B2, issue #611)
// =============================================================================
//
// A NEW user gets a personal library.
// The identity package owns sign-in, so this hangs off its
// `identity.user.created` event, emitted after the user's transaction
// committed (outside any transaction).
//
// INVITES ARE NOT CLAIMED HERE ANY MORE (RETRO-I5, #583): circle invites are
// platform group invites, and the sharing slice's own listener claims them at
// sign-up and at every sign-in (`groups.autoAcceptInvitesOnSignup` /
// `autoAcceptInvitesOnSignIn`, `platform/sharing/sharing.config.ts`), joining or
// upgrading, never downgrading. The membership-confirmation e-mail is
// `group-invite-email.listener.ts`.
//
// DATABASE WRITES ONLY IN THE HANDLER BODY (the `on-event-no-io` rule). A
// throwing handler is caught and logged here: sign-in never fails because of a
// library. IDEMPOTENT AND RACE-SAFE: `personal_libraries.user_id` is unique, so a
// repeat (or a concurrent writer) reads the existing row.
//
// Since RETRO-K2 the personal library is one `personal_libraries` row (its `id` is the scope id
// content rows carry); there is no circle and no circle membership to write.
// =============================================================================

@Injectable()
export class CircleIdentityListeners {
  private readonly logger = new Logger(CircleIdentityListeners.name);

  constructor(private readonly personal: PersonalLibraryStore) {}

  @OnEvent(IDENTITY_EVENTS.USER_CREATED)
  async onUserCreated(event: IdentityUserCreatedEvent): Promise<void> {
    try {
      await this.ensurePersonalCircle(event.userId);
    } catch (err) {
      this.logger.error(`user.created handling failed for ${event.userId}: ${describe(err)}`);
    }
  }

  /** Exactly one personal library per user: a repeat is a no-op. */
  async ensurePersonalCircle(userId: string): Promise<void> {
    const { created } = await this.personal.ensure(userId);
    if (created) this.logger.log(`Personal library created for user: ${userId}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

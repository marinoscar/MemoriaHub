import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailService } from '../../email/email.service';
import { EmailSendResult } from '../../email/types/email.types';
import { NotificationsService } from '../notifications.service';
import {
  BroadcastChannel,
  absoluteLink,
  broadcastNotificationType,
} from './broadcast-constants';

/** The fields of a broadcast (row or composer DTO) delivery needs. */
export interface BroadcastContent {
  id?: string | null;
  title: string;
  body: string;
  link?: string | null;
  ctaLabel?: string | null;
  critical: boolean;
  channels: readonly string[];
}

export interface BroadcastRecipient {
  id: string;
  email: string;
}

export interface BroadcastDeliveryResult {
  /** Email outcome, or null when the email channel was not selected. */
  email: EmailSendResult | null;
}

// =============================================================================
// BroadcastDeliveryService — deliver ONE broadcast to ONE recipient (#488)
// =============================================================================
//
// The single implementation of "what does delivering this broadcast mean",
// shared by the chunk handler's fan-out and the admin's test send, so a test
// send exercises exactly what a real send will do.
//
//   inbox — NotificationsService.emit() under admin_broadcast[_critical]. The
//           gate there applies: an ordinary broadcast honours the user's
//           preferences and the admin disabledTypes; a critical one is
//           mandatory. The committed row is dispatched to Web Push and the
//           SSE stream by the existing channel layer — `skipPush` narrows
//           push away when the broadcast did not select it.
//   email — EmailService.sendEmail('broadcast'), a no-op result when email is
//           disabled deployment-wide. Never throws.
//
// NEVER THROWS for a delivery problem (both primitives are best-effort); a
// thrown error here would be an infrastructure fault worth retrying.
// =============================================================================
@Injectable()
export class BroadcastDeliveryService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async deliver(
    broadcast: BroadcastContent,
    recipient: BroadcastRecipient,
  ): Promise<BroadcastDeliveryResult> {
    const channels = new Set(broadcast.channels as readonly BroadcastChannel[]);

    if (channels.has('inbox')) {
      await this.notifications.emit({
        userId: recipient.id,
        circleId: null,
        type: broadcastNotificationType(broadcast.critical),
        title: broadcast.title,
        body: broadcast.body,
        link: broadcast.link ?? null,
        data: {
          broadcastId: broadcast.id ?? null,
          ctaLabel: broadcast.ctaLabel ?? null,
          critical: broadcast.critical,
        },
        skipPush: !channels.has('push'),
      });
    }

    let email: EmailSendResult | null = null;
    if (channels.has('email')) {
      const ctaUrl = absoluteLink(this.config.get<string>('appUrl'), broadcast.link);
      email = await this.email.sendEmail(recipient.email, 'broadcast', {
        title: broadcast.title,
        body: broadcast.body,
        critical: broadcast.critical,
        ...(ctaUrl ? { ctaUrl } : {}),
        ...(ctaUrl && broadcast.ctaLabel ? { ctaLabel: broadcast.ctaLabel } : {}),
      });
    }

    return { email };
  }
}

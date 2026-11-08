// =============================================================================
// AppEmailSender: render a registered template and send it to one address
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#570): the email slice exports the pieces (the
// settings, the transport resolver, `renderEmailTemplate`, `formatFromHeader`)
// but no "send template X to address Y" service outside the notifications
// slice's email channel; that is the seam gap reported by RETRO-D2. This class
// is the thin composition of those public pieces that replaces the app's former
// `EmailService`, for the three app emails (circle invitation, membership
// confirmation, memory digest) and the broadcast email. When RETRO-D3 binds
// those events to templates through the notifications slice, callers move to
// it and this file goes.
//
// CONTRACT (unchanged from the app's EmailService):
//   - `sendEmail` NEVER throws: every failure, including an unreadable settings
//     row or a template that throws, is `{ success: false, error }`.
//   - Unconfigured is a graceful no-op: email switched off, no transport chosen
//     or no from address returns `{ success: false, error: 'email_disabled' }`
//     without touching a transport.
//   - `sendEmailAsync` is fire-and-forget for the request path: a failed send
//     never blocks or fails the user action that triggered it.
//
// Logs carry the template name and the outcome, never the body or a secret
// (the transports redact provider errors).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import {
  EmailSettingsService,
  EmailTransportResolver,
  formatFromHeader,
  renderEmailTemplate,
  type EmailMessage,
  type EmailSendResult,
  type EmailSettings,
  type EmailTemplateDataMap,
  type EmailTemplateName,
} from '@marinoscar/platform-api/email';

/** The error of a send skipped because email is not configured. */
export const EMAIL_DISABLED = 'email_disabled';

/** True when the settings can deliver mail: switched on, a transport chosen, a sender set. */
export function isEmailConfigured(settings: Pick<EmailSettings, 'enabled' | 'provider' | 'fromAddress'>): boolean {
  return Boolean(settings.enabled && settings.provider && settings.fromAddress);
}

@Injectable()
export class AppEmailSender {
  private readonly logger = new Logger(AppEmailSender.name);

  constructor(
    private readonly settings: EmailSettingsService,
    private readonly transports: EmailTransportResolver,
  ) {}

  /** Whether the deployment can deliver mail right now. Never throws (an unreadable row is `false`). */
  async isConfigured(): Promise<boolean> {
    try {
      return isEmailConfigured(await this.settings.get());
    } catch {
      return false;
    }
  }

  /** Render a registered template and send it. Returns a result; never throws. */
  async sendEmail<K extends EmailTemplateName>(
    recipient: string,
    templateName: K,
    data: EmailTemplateDataMap[K],
  ): Promise<EmailSendResult> {
    try {
      const settings = await this.settings.get();
      if (!isEmailConfigured(settings)) return { success: false, error: EMAIL_DISABLED };

      const rendered = renderEmailTemplate(templateName, data);
      const message: EmailMessage = {
        to: recipient,
        from: formatFromHeader(settings.fromAddress!, settings.fromName),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        // Per-message headers (the digest's List-Unsubscribe pair) and the
        // layout's inline parts, passed straight through to the transport.
        ...(rendered.headers ? { headers: rendered.headers } : {}),
        ...(rendered.attachments?.length ? { attachments: rendered.attachments } : {}),
      };

      const result = await this.transports.send(settings, message);
      if (result.success) {
        this.logger.log(`Email "${templateName}" sent (id=${result.messageId ?? 'n/a'})`);
      } else {
        this.logger.warn(`Email "${templateName}" failed: ${result.error ?? 'unknown error'}`);
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Email "${templateName}" errored: ${error}`);
      return { success: false, error };
    }
  }

  /** Fire-and-forget send for the request path. Swallows every error. */
  sendEmailAsync<K extends EmailTemplateName>(
    recipient: string,
    templateName: K,
    data: EmailTemplateDataMap[K],
  ): void {
    void this.sendEmail(recipient, templateName, data).catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Async email "${templateName}" failed: ${error}`);
    });
  }
}

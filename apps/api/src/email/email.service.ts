import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { EmailProvider } from './providers/email-provider.interface';
import { TEMPLATES } from './templates';
import {
  EmailMessage,
  EmailSendResult,
  EmailTemplateName,
  EmailTemplateDataMap,
} from './types/email.types';

/**
 * Central transactional-email service.
 *
 * Sending is always best-effort: `sendEmail` NEVER throws — it returns a result
 * object. `sendEmailAsync` is fire-and-forget for the request path so email
 * delivery can never block or fail a user-facing operation.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly sesProvider: SesEmailProvider,
    private readonly smtpProvider: SmtpEmailProvider,
  ) {}

  /**
   * Render and send a templated email. Returns a result; never throws.
   */
  async sendEmail<K extends EmailTemplateName>(
    recipient: string,
    templateName: K,
    data: EmailTemplateDataMap[K],
  ): Promise<EmailSendResult> {
    try {
      const settings = await this.systemSettings.getSettings();
      const email = settings.email;

      if (!email || !email.enabled || !email.provider || !email.fromAddress) {
        return { success: false, error: 'email_disabled' };
      }

      const rendered = TEMPLATES[templateName](data);

      const from = this.buildFrom(email.fromName, email.fromAddress);
      const message: EmailMessage = {
        to: recipient,
        from,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      };

      const provider: EmailProvider =
        email.provider === 'ses' ? this.sesProvider : this.smtpProvider;

      const result = await provider.send(message);
      if (!result.success) {
        this.logger.warn(
          `Email "${templateName}" to ${recipient} failed: ${result.error}`,
        );
      } else {
        this.logger.log(
          `Email "${templateName}" sent to ${recipient} (id=${result.messageId ?? 'n/a'})`,
        );
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Email "${templateName}" to ${recipient} errored: ${error}`);
      return { success: false, error };
    }
  }

  /**
   * Fire-and-forget send for the request path. Swallows all errors.
   */
  sendEmailAsync<K extends EmailTemplateName>(
    recipient: string,
    templateName: K,
    data: EmailTemplateDataMap[K],
  ): void {
    void this.sendEmail(recipient, templateName, data).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Async email "${templateName}" to ${recipient} failed: ${error}`);
    });
  }

  /**
   * Build an RFC 5322 From header from an optional display name + address.
   */
  private buildFrom(fromName: string | null, fromAddress: string): string {
    if (fromName && fromName.trim().length > 0) {
      // Quote the display name to be safe with commas/special chars.
      const safeName = fromName.replace(/"/g, '');
      return `"${safeName}" <${fromAddress}>`;
    }
    return fromAddress;
  }
}

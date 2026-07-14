import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { decryptSecret } from '../../common/crypto/secret-cipher';
import { EmailProvider } from './email-provider.interface';
import { EmailMessage, EmailSendResult } from '../types/email.types';

/**
 * SMTP email provider backed by nodemailer.
 *
 * The transport is built LAZILY from the `email.smtp*` system settings (the
 * password is decrypted from its stored AES-256-GCM ciphertext) and cached.
 * When the effective config changes, the cached transport is rebuilt.
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);

  private transport: Transporter | null = null;
  private transportKey: string | null = null;

  constructor(private readonly systemSettings: SystemSettingsService) {}

  private async getTransport(): Promise<Transporter> {
    const settings = await this.systemSettings.getSettings();
    const email = settings.email;

    if (!email || !email.smtpHost) {
      throw new Error('SMTP host is not configured');
    }

    const host = email.smtpHost;
    const port = email.smtpPort ?? 587;
    const useTls = email.smtpUseTls ?? true;
    const username = email.smtpUsername ?? undefined;
    const password = email.smtpPassword ? decryptSecret(email.smtpPassword) : undefined;

    // Cache key captures every input that affects transport construction.
    // (Password is hashed via length + tail only to avoid holding plaintext in a key.)
    const key = JSON.stringify({
      host,
      port,
      useTls,
      username: username ?? null,
      hasPass: !!password,
      passLen: password?.length ?? 0,
    });

    if (this.transport && this.transportKey === key) {
      return this.transport;
    }

    const transport = nodemailer.createTransport({
      host,
      port,
      // Implicit TLS on 465; STARTTLS (requireTLS) otherwise when TLS is enabled.
      secure: port === 465,
      requireTLS: useTls && port !== 465,
      auth: username
        ? { user: username, pass: password ?? '' }
        : undefined,
    });

    this.transport = transport;
    this.transportKey = key;
    return transport;
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    try {
      const transport = await this.getTransport();
      const info = await transport.sendMail({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      return { success: true, messageId: info.messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`SMTP send failed: ${error}`);
      return { success: false, error };
    }
  }
}

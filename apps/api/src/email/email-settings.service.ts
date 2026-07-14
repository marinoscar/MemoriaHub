import { Injectable, Logger } from '@nestjs/common';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';
import { EmailService } from './email.service';
import { SesEmailProvider } from './providers/ses-email.provider';
import { UpdateEmailSettingsDto } from './dto/update-email-settings.dto';

@Injectable()
export class EmailSettingsService {
  private readonly logger = new Logger(EmailSettingsService.name);

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly emailService: EmailService,
    private readonly sesProvider: SesEmailProvider,
  ) {}

  /**
   * Return the email configuration for the admin UI — never the ciphertext or
   * plaintext password, only masked metadata (last-4 of the decrypted password).
   */
  async getMaskedSettings() {
    const settings = await this.systemSettings.getSettings();
    const email = settings.email ?? null;

    const sesCredentialAvailable = await this.sesProvider.sesCredentialAvailable();

    let passwordLast4: string | null = null;
    if (email?.smtpPassword) {
      try {
        passwordLast4 = decryptSecret(email.smtpPassword).slice(-4);
      } catch {
        passwordLast4 = null;
      }
    }

    const provider = email?.provider ?? null;
    const credentialSource =
      provider === 'ses'
        ? 'ses:reuses-s3'
        : provider === 'smtp'
          ? 'smtp:inline'
          : null;

    return {
      provider,
      enabled: email?.enabled ?? false,
      fromAddress: email?.fromAddress ?? null,
      fromName: email?.fromName ?? null,
      sesRegion: email?.sesRegion ?? null,
      sesCredentialAvailable,
      smtp: {
        host: email?.smtpHost ?? null,
        port: email?.smtpPort ?? 587,
        useTls: email?.smtpUseTls ?? true,
        username: email?.smtpUsername ?? null,
        passwordConfigured: !!email?.smtpPassword,
        passwordLast4,
      },
      credentialSource,
    };
  }

  /**
   * Persist email settings. When `smtpPassword` is a non-empty string it is
   * encrypted before storage; when omitted/blank the stored ciphertext is
   * preserved (patchSettings falls back to the current value).
   */
  async updateSettings(dto: UpdateEmailSettingsDto, userId: string) {
    const emailPatch: Record<string, unknown> = {
      provider: dto.provider,
      enabled: dto.enabled,
    };

    if (dto.sesRegion !== undefined) emailPatch.sesRegion = dto.sesRegion;
    if (dto.smtpHost !== undefined) emailPatch.smtpHost = dto.smtpHost;
    if (dto.smtpPort !== undefined) emailPatch.smtpPort = dto.smtpPort;
    if (dto.smtpUseTls !== undefined) emailPatch.smtpUseTls = dto.smtpUseTls;
    if (dto.smtpUsername !== undefined) emailPatch.smtpUsername = dto.smtpUsername;
    if (dto.fromAddress !== undefined) emailPatch.fromAddress = dto.fromAddress;
    if (dto.fromName !== undefined) emailPatch.fromName = dto.fromName;

    // Only touch the password when a new, non-empty value is provided.
    if (typeof dto.smtpPassword === 'string' && dto.smtpPassword.length > 0) {
      emailPatch.smtpPassword = encryptSecret(dto.smtpPassword);
    }

    await this.systemSettings.patchSettings({ email: emailPatch } as any, userId);

    this.logger.log(`Email settings updated by user ${userId}`);

    return this.getMaskedSettings();
  }

  /**
   * Send a test email to verify provider connectivity/configuration.
   * Surfaces the raw provider error string when the send fails.
   */
  async sendTest(recipient: string) {
    const result = await this.emailService.sendEmail(
      recipient,
      'membership-confirmation',
      {
        circleName: 'Test Circle',
        circleDescription:
          'This is a test email from MemoriaHub to confirm your email configuration works.',
        role: 'viewer',
        viewUrl: (process.env['APP_URL'] || 'http://localhost:3535') + '/circles',
      },
    );

    return {
      ok: result.success,
      messageId: result.messageId,
      error: result.error,
    };
  }
}

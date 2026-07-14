import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { decryptSecret } from '../../common/crypto/secret-cipher';
import { EmailProvider } from './email-provider.interface';
import { EmailMessage, EmailSendResult } from '../types/email.types';

/**
 * AWS SES (v2) email provider.
 *
 * Stores NO secret of its own — it reuses the AWS credentials configured for
 * the S3 storage provider (`storage_provider_credentials` where provider='s3').
 * The SES region is taken from `email.sesRegion`, falling back to the S3 region.
 *
 * The client is built LAZILY on each send (never at DI time) so that a missing
 * or changed credential never crashes the module and always reflects the latest
 * stored configuration.
 */
@Injectable()
export class SesEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SesEmailProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  /**
   * Whether SES can be used at all: true when an s3 storage credential row with
   * an access key + encrypted secret exists (SES reuses those AWS keys).
   */
  async sesCredentialAvailable(): Promise<boolean> {
    const cred = await this.prisma.storageProviderCredential.findUnique({
      where: { provider: 's3' },
      select: { accessKeyId: true, encryptedKey: true },
    });
    return !!(cred && cred.accessKeyId && cred.encryptedKey);
  }

  private async buildClient(): Promise<SESv2Client> {
    const cred = await this.prisma.storageProviderCredential.findUnique({
      where: { provider: 's3' },
      select: { accessKeyId: true, encryptedKey: true, region: true },
    });

    if (!cred || !cred.accessKeyId || !cred.encryptedKey) {
      throw new Error(
        'SES requires AWS credentials from the S3 storage provider, but none are configured',
      );
    }

    const settings = await this.systemSettings.getSettings();
    const region = settings.email?.sesRegion ?? cred.region ?? undefined;
    if (!region) {
      throw new Error('SES region is not configured (set email.sesRegion or the S3 region)');
    }

    return new SESv2Client({
      region,
      credentials: {
        accessKeyId: cred.accessKeyId,
        secretAccessKey: decryptSecret(cred.encryptedKey),
      },
    });
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    try {
      const client = await this.buildClient();
      const command = new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: msg.html, Charset: 'UTF-8' },
              Text: { Data: msg.text, Charset: 'UTF-8' },
            },
          },
        },
      });

      const result = await client.send(command);
      return { success: true, messageId: result.MessageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`SES send failed: ${error}`);
      return { success: false, error };
    }
  }
}

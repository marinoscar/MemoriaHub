import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailService } from './email.service';
import { EmailSmtpSecretStore } from './email-smtp-secret.store';
import { EmailSettingsService } from './email-settings.service';
import { EmailSettingsController } from './email-settings.controller';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

@Module({
  imports: [PrismaModule],
  controllers: [EmailSettingsController],
  providers: [
    EmailService,
    EmailSettingsService,
    EmailSmtpSecretStore,
    SesEmailProvider,
    SmtpEmailProvider,
  ],
  exports: [EmailService],
})
export class EmailModule {}

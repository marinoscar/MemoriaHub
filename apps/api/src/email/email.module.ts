import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { EmailService } from './email.service';
import { EmailSettingsService } from './email-settings.service';
import { EmailSettingsController } from './email-settings.controller';
import { SesEmailProvider } from './providers/ses-email.provider';
import { SmtpEmailProvider } from './providers/smtp-email.provider';

@Module({
  imports: [PrismaModule, SettingsModule],
  controllers: [EmailSettingsController],
  providers: [
    EmailService,
    EmailSettingsService,
    SesEmailProvider,
    SmtpEmailProvider,
  ],
  exports: [EmailService],
})
export class EmailModule {}

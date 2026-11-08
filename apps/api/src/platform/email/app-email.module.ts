// =============================================================================
// AppEmailModule (RETRO-D2, #570)
// =============================================================================
//
// What a MemoriaHub feature imports to send mail: the platform `emailModule`
// (the one `forRoot` object) plus `AppEmailSender`. Imported by CirclesModule,
// MemoriesModule and BroadcastsModule.
// =============================================================================

import { Module } from '@nestjs/common';

import { AppEmailSender } from './app-email.sender';
import { emailModule } from './email.config';

@Module({
  imports: [emailModule],
  providers: [AppEmailSender],
  exports: [AppEmailSender, emailModule],
})
export class AppEmailModule {}

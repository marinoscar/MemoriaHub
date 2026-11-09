import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { sharingModule } from './sharing.config';
import { SharingHostModule } from './sharing-host.module';
import { OwnerAccessService } from './owner-scope';
import { RecordAccessService } from './record-access';

/**
 * Owner-scope access decisions on platform group membership (RETRO-I3, #573).
 * Every feature module that decided access through `CirclesModule`'s
 * `OwnerAccessService` imports this instead. It imports the configured
 * sharing module for `PrincipalGroupsProvider` and `AccessPolicy` (the module
 * is not global). `RecordAccessService` adds grants on `media_item` / `album`.
 */
@Module({
  imports: [PrismaModule, sharingModule, SharingHostModule],
  providers: [OwnerAccessService, RecordAccessService],
  exports: [OwnerAccessService, RecordAccessService],
})
export class OwnerAccessModule {}

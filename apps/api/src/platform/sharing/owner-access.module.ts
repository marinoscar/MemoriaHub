import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { sharingModule } from './sharing.config';
import { OwnerAccessService } from './owner-scope';

/**
 * Owner-scope access decisions on platform group membership (RETRO-I3, #573).
 * Every feature module that decided access through `CirclesModule`'s
 * `OwnerAccessService` imports this instead. It imports the configured
 * sharing module for `PrincipalGroupsProvider` (the module is not global).
 */
@Module({
  imports: [PrismaModule, sharingModule],
  providers: [OwnerAccessService],
  exports: [OwnerAccessService],
})
export class OwnerAccessModule {}

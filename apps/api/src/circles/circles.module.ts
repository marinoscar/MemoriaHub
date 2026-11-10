// The `/api/circles/*` routes, served from platform groups and personal libraries (RETRO-K1, RETRO-K2).
// A shared circle IS a sharing group of the same id (`GroupsService`, `GroupMembershipService`,
// `GroupInvitesService`); a personal circle is the caller's personal library. No circle table is left
// (RETRO-K2): every access decision is `OwnerAccessService` (`platform/sharing/owner-scope.ts`).
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { sharingModule } from '../platform/sharing/sharing.config';
import { CirclesService } from './circles.service';
import { CirclesController } from './circles.controller';
import { CircleIdentityListeners } from './identity-listeners';
import { GroupInviteEmailListener } from './group-invite-email.listener';

@Module({
  imports: [PrismaModule, OwnerAccessModule, sharingModule],
  controllers: [CirclesController],
  providers: [CirclesService, CircleIdentityListeners, GroupInviteEmailListener],
  exports: [CirclesService],
})
export class CirclesModule {}

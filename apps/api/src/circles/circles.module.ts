// PLATFORM-ADOPTION-SHIM(#562): circles and circle members stay app-owned beside the
// mounted sharing slice until RETRO-I6 replaces the `/api/circles/*` routes with
// `/api/groups`. Since RETRO-I5 (#583) circle invites ARE group invites: the invite
// routes delegate to the slice's `GroupInvitesService`, and `GroupMemberMirrorListener`
// copies the memberships the slice writes back into `circle_members`. Since RETRO-I3 (#573) no access decision is made here: every
// check is `OwnerAccessService` (`platform/sharing/owner-scope.ts`), which reads the
// caller's role from the platform's group membership (circles are mirrored into groups
// by the RETRO-I2 triggers) and answers 404 to a non-member.
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { sharingModule } from '../platform/sharing/sharing.config';
import { CirclesService } from './circles.service';
import { CirclesController } from './circles.controller';
import { CircleIdentityListeners } from './identity-listeners';
import { GroupMemberMirrorListener } from './group-member-mirror.listener';

@Module({
  imports: [PrismaModule, OwnerAccessModule, sharingModule],
  controllers: [CirclesController],
  providers: [CirclesService, CircleIdentityListeners, GroupMemberMirrorListener],
  exports: [CirclesService],
})
export class CirclesModule {}

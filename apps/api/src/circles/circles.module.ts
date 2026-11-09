// PLATFORM-ADOPTION-SHIM(#562): circles, circle members and circle invites stay app-owned
// beside the mounted sharing slice until RETRO-I5/I6 replace the `/api/circles/*` routes
// with `/api/groups`. Since RETRO-I3 (#573) no access decision is made here: every
// check is `OwnerAccessService` (`platform/sharing/owner-scope.ts`), which reads the
// caller's role from the platform's group membership (circles are mirrored into groups
// by the RETRO-I2 triggers) and answers 404 to a non-member.
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OwnerAccessModule } from '../platform/sharing/owner-access.module';
import { CirclesService } from './circles.service';
import { CirclesController } from './circles.controller';
import { CircleIdentityListeners } from './identity-listeners';

@Module({
  imports: [PrismaModule, OwnerAccessModule],
  controllers: [CirclesController],
  providers: [CirclesService, CircleIdentityListeners],
  exports: [CirclesService],
})
export class CirclesModule {}

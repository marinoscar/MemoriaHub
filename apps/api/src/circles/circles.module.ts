// PLATFORM-ADOPTION-SHIM(#562): retired by RETRO-I3/I4/I5. Circles, circle members and
// circle invites stay app-owned (and keep deciding access through CircleMemberGuard) while
// the platform sharing slice is mounted beside them; the mapping each later issue implements
// is docs/platform-adoption/circles-to-groups.md. I2 maps the data, I3 replaces the guard
// with AccessPolicy, I5 the invites.

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CircleMembershipService } from './circle-membership.service';
import { CircleMemberGuard } from './guards/circle-member.guard';
import { CirclesService } from './circles.service';
import { CirclesController } from './circles.controller';
import { CircleIdentityListeners } from './identity-listeners';

@Module({
  imports: [PrismaModule],
  controllers: [CirclesController],
  providers: [CircleMembershipService, CircleMemberGuard, CirclesService, CircleIdentityListeners],
  exports: [CircleMembershipService, CircleMemberGuard, CirclesService],
})
export class CirclesModule {}

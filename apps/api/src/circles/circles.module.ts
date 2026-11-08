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

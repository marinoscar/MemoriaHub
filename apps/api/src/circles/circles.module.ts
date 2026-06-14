import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CircleMembershipService } from './circle-membership.service';
import { CircleMemberGuard } from './guards/circle-member.guard';

@Module({
  imports: [PrismaModule],
  providers: [CircleMembershipService, CircleMemberGuard],
  exports: [CircleMembershipService, CircleMemberGuard],
})
export class CirclesModule {}

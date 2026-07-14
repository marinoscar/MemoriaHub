import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AllowlistModule } from '../allowlist/allowlist.module';
import { EmailModule } from '../email/email.module';
import { CircleMembershipService } from './circle-membership.service';
import { CircleMemberGuard } from './guards/circle-member.guard';
import { CirclesService } from './circles.service';
import { CirclesController } from './circles.controller';

@Module({
  imports: [PrismaModule, AllowlistModule, EmailModule],
  controllers: [CirclesController],
  providers: [CircleMembershipService, CircleMemberGuard, CirclesService],
  exports: [CircleMembershipService, CircleMemberGuard, CirclesService],
})
export class CirclesModule {}

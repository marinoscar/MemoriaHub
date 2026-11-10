import { Module } from '@nestjs/common';
import { InsightsModule as InsightsSliceModule } from '@marinoscar/memoriahub-api/insights';

import { PrismaModule } from '../prisma/prisma.module';
import { InsightsController } from './insights.controller';

/**
 * The web app's binding of the insights slice (RETRO-J10, #624): the slice (service, handler,
 * refresh task) lives in `@marinoscar/memoriahub-api/insights`; the controller stays here until the
 * identity-backed guard lands in the package.
 */
@Module({
  imports: [PrismaModule, InsightsSliceModule.forRoot()],
  controllers: [InsightsController],
  exports: [InsightsSliceModule],
})
export class InsightsModule {}

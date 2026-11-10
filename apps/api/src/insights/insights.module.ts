import { Module } from '@nestjs/common';
import { InsightsController, InsightsModule as InsightsSliceModule } from '@marinoscar/memoriahub-api/insights';

import { PrismaModule } from '../prisma/prisma.module';

/**
 * The web app's binding of the insights slice (RETRO-J10, #624): the slice (service, handler,
 * refresh task) lives in `@marinoscar/memoriahub-api/insights`; the controller is the slice's class,
 * mounted here (not registered by `forRoot()`, which would change the OpenAPI path order).
 */
@Module({
  imports: [PrismaModule, InsightsSliceModule.forRoot()],
  controllers: [InsightsController],
  exports: [InsightsSliceModule],
})
export class InsightsModule {}

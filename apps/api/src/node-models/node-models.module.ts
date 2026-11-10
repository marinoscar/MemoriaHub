import { Module } from '@nestjs/common';

import { NodeModelsController } from './node-models.controller';
import { NodeModelsService } from './node-models.service';

/** `GET /api/nodes/models/manifest`: the model files a worker node must hold (RETRO-C2, #581). */
@Module({
  controllers: [NodeModelsController],
  providers: [NodeModelsService],
})
export class NodeModelsModule {}

import { Module } from '@nestjs/common';

import { EmailModule } from '../../email/email.module';
import { EnrichmentModule } from '../../enrichment/enrichment.module';
import { NotificationsModule } from '../notifications.module';
import { BroadcastDeliveryService } from './broadcast-delivery.service';
import { BroadcastFailureListener } from './broadcast-failure.listener';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastChunkHandler } from './handlers/broadcast-chunk.handler';
import { BroadcastStartHandler } from './handlers/broadcast-start.handler';

/**
 * Admin notification broadcasts (epic #481, issue #488).
 *
 * A LEAF module: it imports NotificationsModule (for NotificationsService),
 * EnrichmentModule (queue + handler registry) and EmailModule. Nothing imports
 * it, and NotificationsModule still imports nothing — the edge points INTO
 * notifications exactly like MediaModule's and MemoriesModule's.
 */
@Module({
  imports: [NotificationsModule, EnrichmentModule, EmailModule],
  controllers: [BroadcastsController],
  providers: [
    BroadcastsService,
    BroadcastDeliveryService,
    BroadcastStartHandler,
    BroadcastChunkHandler,
    BroadcastFailureListener,
  ],
})
export class BroadcastsModule {}

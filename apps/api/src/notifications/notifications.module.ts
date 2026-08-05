import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Notification Center (epic #240, issue #245).
 *
 * PrismaModule is deliberately NOT imported — it is @Global, so PrismaService
 * is injectable here without it.
 *
 * NotificationsService is EXPORTED because it is the single write path for the
 * notifications table: the review-queue watcher (#246) and the event producers
 * (#247) import this module and call emit()/upsertState() rather than touching
 * Prisma directly.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

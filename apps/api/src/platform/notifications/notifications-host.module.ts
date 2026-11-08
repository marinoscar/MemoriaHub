// =============================================================================
// Host ports of the platform notifications slice (RETRO-D3, #576)
// =============================================================================
//
//   NOTIFICATIONS_EVENT_BUS -> the host's EVENT_BUS (the SSE stream fans out
//                              across replicas on it)
//   NOTIFICATIONS_METRICS   -> AppMetricsService (the delivery counter; no
//                              organization or user label)
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { AppMetricsService, EVENT_BUS, exceedsEventBusPayloadLimit, type EventBus } from '@marinoscar/platform-api/host';
import {
  NOTIFICATIONS_EVENT_BUS,
  NOTIFICATIONS_METRICS,
  type NotificationsEventBus,
} from '@marinoscar/platform-api/notifications';

@Global()
@Module({
  providers: [
    {
      provide: NOTIFICATIONS_EVENT_BUS,
      inject: [EVENT_BUS],
      useFactory: (bus: EventBus): NotificationsEventBus => ({
        publish: (channel, payload) => bus.publish(channel, payload),
        subscribe: (channel, handler) => bus.subscribe(channel, handler),
        exceedsPayloadLimit: exceedsEventBusPayloadLimit,
      }),
    },
    { provide: NOTIFICATIONS_METRICS, useExisting: AppMetricsService },
  ],
  exports: [NOTIFICATIONS_EVENT_BUS, NOTIFICATIONS_METRICS],
})
export class NotificationsHostModule {}

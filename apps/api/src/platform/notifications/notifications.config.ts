// =============================================================================
// The notifications slice's composition (RETRO-D3, #576)
// =============================================================================
//
// `NotificationsModule.forRoot` replaces MemoriaHub's own `notifications/`
// folder (epics #240 and #481): the dispatcher (`notify`, `notifyState`,
// `notifyCounted`, `notifyAddress`, `notifyPermissionHolders`), the inbox
// routes and the SSE stream under `/api/notifications`, Web Push (VAPID keys in
// the credential store, `/api/admin/push-config`), the deployment policy and
// per-user preferences, the delivery log and the two retention purges.
// `BroadcastsModule` serves `/api/admin/broadcasts` and runs the
// `admin.broadcast.start` / `admin.broadcast.chunk` jobs. Both are global.
//
// MemoriaHub's own part is data: the manifest (registered first) and the
// producers in `src/notification-producers/`.
// =============================================================================

import './notification.manifest';

import { BroadcastsModule, NotificationsModule } from '@marinoscar/platform-api/notifications';

import { emailModule } from '../email/email.config';
import { NotificationsHostModule } from './notifications-host.module';

export const notificationsModule = NotificationsModule.forRoot({
  imports: [emailModule, NotificationsHostModule],
});

export { BroadcastsModule };

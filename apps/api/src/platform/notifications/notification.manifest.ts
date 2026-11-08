// =============================================================================
// Notification registrations (RETRO-D3, #576)
// =============================================================================
//
// Registers, at import time, everything the platform notifications slice
// dispatches for MemoriaHub: the platform channels (email, browser, push), the
// platform's own events (broadcasts, the ops pair `jobs.job_failed` /
// `nodes.node_offline`) and MemoriaHub's nine events
// (`src/notifications-registry/memoriahub.notifications.ts`). Idempotent per
// process: the registries refuse a duplicate key, so this module is imported,
// never called.
//
// PLATFORM-ADOPTION-SHIM(#576): nothing at RUNTIME imports this file yet. The
// pinned platform 0.1.0-next.22 has no STATE/COUNTED inbox writes, no
// `dismissed_at` / `data` on the inbox and no dismiss routes, so mounting
// `NotificationsModule.forRoot` now would drop MemoriaHub's volume guards and
// dismissal. The manifest is validated by the `notifications` conformance suite
// and its unit test; the cutover (after the 0.1.0-next.27 bump) imports it from
// `notifications.config.ts` before `forRoot`. See
// docs/platform-adoption/local-exceptions.md.
// =============================================================================

// The platform email templates (`broadcast`, `job-failed`, `node-offline`, ...) the
// platform events bind to are registered by the email slice's `forRoot`.
import '../email/email.config';

import {
  BROADCASTS_NOTIFICATIONS,
  NODES_NOTIFICATIONS,
  OPS_NOTIFICATIONS,
  notificationEventRegistry,
  registerNotifications,
  registerPlatformNotificationChannels,
} from '@marinoscar/platform-api/notifications';

import { MEMORIAHUB_NOTIFICATIONS } from '../../notifications-registry/memoriahub.notifications';

registerPlatformNotificationChannels();
for (const group of [BROADCASTS_NOTIFICATIONS, OPS_NOTIFICATIONS, NODES_NOTIFICATIONS, MEMORIAHUB_NOTIFICATIONS]) {
  // A platform module (jobs, nodes) may already have registered its own group.
  registerNotifications(group.filter((registration) => !notificationEventRegistry.has(registration.event.key)));
}

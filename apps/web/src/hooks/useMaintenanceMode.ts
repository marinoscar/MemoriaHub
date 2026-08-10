import { useSyncExternalStore } from 'react';
import {
  getMaintenanceNotice,
  subscribeToMaintenance,
} from '../services/maintenanceState';
import type { MaintenanceNotice } from '../services/maintenanceState';

/**
 * The CLIENT-OBSERVED maintenance state (issue #348): non-null once any API
 * call has come back 503 with the stable maintenance marker, null again once a
 * health poll confirms the API is serving.
 *
 * `useSyncExternalStore` rather than a context provider because the producer is
 * `services/api.ts` — a plain module far outside the React tree — and every
 * subscriber must see the same notice the instant it lands, without the app
 * needing to thread a provider around the router.
 */
export function useMaintenanceMode(): MaintenanceNotice | null {
  return useSyncExternalStore(
    subscribeToMaintenance,
    getMaintenanceNotice,
    getMaintenanceNotice,
  );
}

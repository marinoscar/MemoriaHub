/**
 * Process-local store for the CLIENT-OBSERVED maintenance state (issue #348).
 *
 * This module deliberately imports NOTHING. `services/api.ts` is imported by
 * essentially every other module, so the 503 detector it needs has to live in
 * a leaf that cannot close an import cycle. React reads the same store through
 * `useMaintenanceMode()` via `useSyncExternalStore`.
 *
 * Two distinct notions of "maintenance state" exist in this app and they must
 * not be conflated:
 *   - THIS store: "the API just told me it is in maintenance", detected from
 *     the stable `{ error: 'maintenance', ... }` marker on a 503. It is what
 *     drives the full-screen takeover for an ordinary user.
 *   - `services/maintenance.ts` + `useMaintenance()`: the ADMIN view of the
 *     persisted setting, fetched from `GET /api/admin/maintenance`. An admin
 *     browsing with `allowAdmins: true` never sees a 503, so this store stays
 *     empty for them while that one reports active — which is exactly why the
 *     banner reads from that one and not this one.
 */

/** Stable marker the API puts in the 503 body. Must match MAINTENANCE_ERROR_MARKER
 *  in apps/api/src/common/maintenance/maintenance.guard.ts. */
export const MAINTENANCE_ERROR_MARKER = 'maintenance';

export interface MaintenanceNotice {
  /** Operator-supplied message from the 503 body. */
  message: string;
  /** ISO timestamp maintenance was enabled, when the API supplied one. */
  startedAt: string | null;
}

type Listener = () => void;

let current: MaintenanceNotice | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Snapshot for `useSyncExternalStore`. Returns the SAME object reference until
 * the state actually changes — returning a fresh object each call would make
 * React loop forever.
 */
export function getMaintenanceNotice(): MaintenanceNotice | null {
  return current;
}

export function subscribeToMaintenance(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record that the API reported a maintenance window. Idempotent: a repeated
 *  notice with identical contents does not re-render subscribers. */
export function reportMaintenance(notice: MaintenanceNotice): void {
  if (
    current &&
    current.message === notice.message &&
    current.startedAt === notice.startedAt
  ) {
    return;
  }
  current = notice;
  emit();
}

/** Clear the notice — called when a poll confirms the API is serving again. */
export function clearMaintenance(): void {
  if (current === null) return;
  current = null;
  emit();
}

/**
 * True when an error payload carries the API's stable maintenance marker.
 *
 * Kept narrow on purpose: an ordinary 503 (a crashed API, a proxy with no
 * upstream) has no `error: 'maintenance'` field and must keep flowing through
 * as a normal ApiError so the calling page renders its own error state.
 */
export function isMaintenancePayload(
  status: number,
  body: unknown,
): body is { error: string; message?: string; startedAt?: string | null } {
  if (status !== 503 || !body || typeof body !== 'object') return false;
  return (body as { error?: unknown }).error === MAINTENANCE_ERROR_MARKER;
}

import { api } from './api';

/**
 * Admin client for maintenance mode (issue #348).
 *
 * Mirrors `MaintenanceState` in
 * apps/api/src/common/maintenance/maintenance-mode.service.ts. Both routes are
 * gated on system_settings:read / system_settings:write (no new permission)
 * and are `@AllowDuringMaintenance()`, so they keep answering while the rest
 * of the API is 503ing — that exemption is what lets an admin turn maintenance
 * back OFF from the UI.
 */
export interface MaintenanceState {
  /** The effective answer: env override ?? in-memory override ?? persisted. */
  active: boolean;
  /** Operator message shown on the maintenance screen. */
  message: string;
  /** When false, even Admin-role users are blocked. */
  allowAdmins: boolean;
  /** ISO timestamp maintenance was enabled; null when off. */
  startedAt: string | null;
  /** User id that enabled maintenance; null when off / env-forced. */
  startedById: string | null;
  /** The persisted `maintenance.enabled` value, ignoring both overrides. */
  persistedEnabled: boolean;
  /** The process-local override, or null when none is set. */
  inMemoryOverride: boolean | null;
  /** The MAINTENANCE_MODE env override, or null when unset/unrecognized. */
  envOverride: boolean | null;
}

export interface UpdateMaintenanceRequest {
  enabled: boolean;
  message?: string;
  allowAdmins?: boolean;
}

export async function getMaintenanceState(): Promise<MaintenanceState> {
  return api.get<MaintenanceState>('/admin/maintenance');
}

export async function updateMaintenanceState(
  body: UpdateMaintenanceRequest,
): Promise<MaintenanceState> {
  return api.put<MaintenanceState>('/admin/maintenance', body);
}

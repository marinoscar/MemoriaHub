import { TELEMETRY_SETTINGS_DEFAULTS } from '@marinoscar/platform-api/telemetry';

// =============================================================================
// Keep an exporting deployment exporting (RETRO-T2, #625)
// =============================================================================
//
// Before the platform telemetry slice, `OTEL_ENABLED=true` alone made the API
// export. Now the export gate opens only when the `telemetry.enabled` system
// setting is on (and a store is configured), and the namespace defaults to OFF,
// so a deployment that exported would silently stop. This pure planner, run by
// `scripts/migrate-telemetry-settings.ts`, writes `telemetry` = the platform
// defaults with `enabled: true` for such a deployment.
//
// IDEMPOTENT BY CONSTRUCTION: it writes only while `telemetry` is ABSENT from the
// stored `global` row (nobody has chosen a value yet). Once written, or once an
// administrator saves the telemetry page, a re-run reports `keep`. It never
// writes when `OTEL_ENABLED` is not `true`: a deployment that never exported
// stays off until an administrator turns telemetry on.
// =============================================================================

/** The decision for the `telemetry` namespace. */
export interface TelemetrySettingsCarryOver {
  /** `write`: enabled is set; `keep`: already stored; `skip`: OTEL_ENABLED is not true. */
  readonly action: 'write' | 'keep' | 'skip';
  /** Why, in one line. */
  readonly reason: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Plans the carry-over and returns the next stored value (a copy; the input is not mutated). */
export function planTelemetrySettingsCarryOver(
  stored: unknown,
  otelEnabled: boolean,
): { change: TelemetrySettingsCarryOver; next: Record<string, unknown> } {
  const root: Record<string, unknown> = isObject(stored) ? structuredClone(stored) : {};
  if (root['telemetry'] !== undefined) {
    return { change: { action: 'keep', reason: 'telemetry is already stored' }, next: root };
  }
  if (!otelEnabled) {
    return { change: { action: 'skip', reason: 'OTEL_ENABLED is not true: telemetry stays off' }, next: root };
  }
  root['telemetry'] = { ...structuredClone(TELEMETRY_SETTINGS_DEFAULTS), enabled: true };
  return { change: { action: 'write', reason: 'OTEL_ENABLED=true: telemetry.enabled set to true' }, next: root };
}

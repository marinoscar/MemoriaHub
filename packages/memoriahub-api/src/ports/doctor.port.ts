// =============================================================================
// MEMORIAHUB_DOCTOR: the diagnostics port (RETRO-J10, #624)
// =============================================================================
//
// A slice that owns a feature owns the check that says whether it is configured and healthy
// ("is the CLIP model available", "do devices check in"). It cannot name the host's diagnostics
// registry, so it registers its checks through this port; the web edition binds it over the
// platform Doctor registry (the Admin Doctor page, its support bundle and its `dependsOn` order).
//
// A CHECK IS READ-ONLY: it never creates, repairs or deletes anything. A CHECK ID IS PERMANENT (a
// support bundle and the runbooks name it): `memoriahub.<section>.<name>`, lower kebab case.
// Optional: an unbound port is a no-op (`NOOP_MEMORIAHUB_DOCTOR` of
// `@marinoscar/memoriahub-api/core`), so a host without a diagnostics page loses only the page.
// =============================================================================

/**
 * Injection token of {@link MemoriahubDoctorPort}. The description string is permanent. Optional in
 * `MemoriahubPortsModule.forRoot`: the default registers nothing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_DOCTOR = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_DOCTOR');

/**
 * How a check ended: `pass` (ok), `warn` (works but needs attention), `fail` (broken) or `skip` (not
 * applicable, usually because the feature is off).
 *
 * @stability experimental
 */
export type MemoriahubDoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

/**
 * A value in a check's `data`: a scalar, never a secret.
 *
 * @stability experimental
 */
export type MemoriahubDoctorDataValue = string | number | boolean | null;

/**
 * What a check reports.
 *
 * @stability experimental
 */
export interface MemoriahubDoctorOutcome {
  /** How it ended. */
  status: MemoriahubDoctorStatus;
  /** One sentence saying what was found. */
  detail: string;
  /** What to do about it (a `warn` or `fail`). */
  remedy?: string;
  /** A sanitized error text, when the check itself failed. */
  error?: string;
  /** Scalar facts for the support bundle. */
  data?: Record<string, MemoriahubDoctorDataValue>;
}

/**
 * One diagnostic check.
 *
 * @stability experimental
 */
export interface MemoriahubDoctorCheck {
  /** `memoriahub.<section>.<name>`. Permanent. */
  readonly id: string;
  /** The report section (`ai`, `face`, `geo`, `android`, ...). */
  readonly category: string;
  /** The label of the row. */
  readonly label: string;
  /** The admin page that fixes it, when there is one. */
  readonly settingsPath?: string;
  /** The ceiling in milliseconds; the host default when absent. */
  readonly timeoutMs?: number;
  /** Ids of checks that must pass first. */
  readonly dependsOn?: readonly string[];
  /** Runs the check. Read-only; may throw (the host reports it as a failed check). */
  run(): Promise<MemoriahubDoctorOutcome>;
}

/**
 * The diagnostics port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubDoctorPort {
  /**
   * Registers a check. Call once per check, from `onModuleInit`.
   *
   * @param check - the check.
   * @throws Error when the host refuses it (a duplicate id).
   */
  registerCheck(check: MemoriahubDoctorCheck): void;
}

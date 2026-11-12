import type {
  MemoriahubDoctorDataValue,
  MemoriahubDoctorOutcome,
  MemoriahubSettingsPort,
} from '../ports/index.js';

// =============================================================================
// Helpers for the diagnostics a slice registers through `MEMORIAHUB_DOCTOR` (RETRO-J10, #624)
// =============================================================================
//
// Each check is a class (`@Injectable`, registers itself with the diagnostics port in
// `onModuleInit`) plus a pure `decide*` function, so the status ladder is unit-tested without Nest.
//
//   pass  everything is as configured     warn  works, needs attention
//   fail  broken                          skip  not applicable (the feature is off)
// =============================================================================

/** The check-id prefix of the product (the identity's CLI name). Permanent. @stability experimental */
export const DOCTOR_CHECK_ID_PREFIX = 'memoriahub';

/**
 * The id of a MemoriaHub check: `memoriahub.<section>.<name>`, lower kebab case.
 *
 * @param section - the report section.
 * @param name - the check's name inside it.
 * @stability experimental
 */
export function doctorCheckId(section: string, name: string): string {
  return `${DOCTOR_CHECK_ID_PREFIX}.${section}.${name}`;
}

/**
 * The per-check ceiling the checks declare (10 s): the live provider probes (AI, face, geo) outlast the
 * host's shorter default.
 *
 * @stability experimental
 */
export const DOCTOR_CHECK_TIMEOUT_MS = 10_000;

/** An outcome of `pass`. @stability experimental */
export function pass(detail: string, data?: Record<string, MemoriahubDoctorDataValue>): MemoriahubDoctorOutcome {
  return { status: 'pass', detail, ...(data ? { data } : {}) };
}

/** An outcome of `warn`. @stability experimental */
export function warn(detail: string, remedy: string, data?: Record<string, MemoriahubDoctorDataValue>): MemoriahubDoctorOutcome {
  return { status: 'warn', detail, remedy, ...(data ? { data } : {}) };
}

/** An outcome of `fail`. @stability experimental */
export function fail(detail: string, remedy: string, data?: Record<string, MemoriahubDoctorDataValue>): MemoriahubDoctorOutcome {
  return { status: 'fail', detail, remedy, ...(data ? { data } : {}) };
}

/** An outcome of `skip`. @stability experimental */
export function skip(detail: string, data?: Record<string, MemoriahubDoctorDataValue>): MemoriahubDoctorOutcome {
  return { status: 'skip', detail, ...(data ? { data } : {}) };
}

/**
 * An error's message, never its stack.
 *
 * @param err - what was thrown.
 * @stability experimental
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads the named system settings namespaces into one object shaped like the settings document
 * (`{ features: {...}, socialMedia: {...} }`), so a check's ladder reads `settings.features?.['x']`.
 * A namespace the host has none for reads as `undefined`. Read-only: it goes through the port's
 * `peekSystem` when the host binds one (the host's `readSystem` may create the settings row).
 *
 * @param settings - the settings port.
 * @param names - the namespaces to read.
 * @stability experimental
 */
export async function readSystemNamespaces<N extends string>(
  settings: MemoriahubSettingsPort,
  names: readonly N[],
): Promise<Record<N, any>> {
  // A diagnostics read never writes: the port's read-only `peekSystem` when the host has one.
  const read = <T>(name: string) => (settings.peekSystem ? settings.peekSystem<T>(name) : settings.readSystem<T>(name));
  const entries = await Promise.all(names.map(async (name) => [name, (await read<unknown>(name)).value] as const));
  return Object.fromEntries(entries) as Record<N, any>;
}

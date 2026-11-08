// =============================================================================
// Shared helpers for the MemoriaHub Doctor checks (RETRO-B1b, #602)
// =============================================================================
//
// Each check is a class (`@Injectable`, registers itself with the platform
// `DoctorCheckRegistry`) plus a pure `decide*` function so the status ladder
// can be unit-tested without Nest. These helpers keep the ports of the old
// `DoctorService` checks close to their originals:
//
//   old status  ok      warning  error  skipped
//   new status  pass    warn     fail   skip
//   old message -> `detail`, old actionItem -> `remedy`.
// =============================================================================

import { APP_SLUG } from '@app/shared';
import type { DoctorCheckOutcome, DoctorDataValue } from '@marinoscar/platform-api/doctor';

/**
 * The id of an app check: `memoriahub.<section>.<name>`, lower-case and
 * kebab-cased, which is what the platform's identity rules require.
 */
export function checkId(section: string, name: string): string {
  return `${APP_SLUG}.${section}.${name}`;
}

/**
 * The per-check ceiling the old `DoctorService` applied (10 s). The platform
 * default is 5 s, which is too short for the live provider probes (AI, face,
 * geo), so every ported check declares the old value.
 */
export const DOCTOR_CHECK_TIMEOUT_MS = 10_000;

type Data = Record<string, DoctorDataValue>;

export function pass(detail: string, data?: Data): DoctorCheckOutcome {
  return { status: 'pass', detail, ...(data ? { data } : {}) };
}

export function warn(detail: string, remedy: string, data?: Data): DoctorCheckOutcome {
  return { status: 'warn', detail, remedy, ...(data ? { data } : {}) };
}

export function fail(detail: string, remedy: string, data?: Data): DoctorCheckOutcome {
  return { status: 'fail', detail, remedy, ...(data ? { data } : {}) };
}

export function skip(detail: string, data?: Data): DoctorCheckOutcome {
  return { status: 'skip', detail, ...(data ? { data } : {}) };
}

/** An error's message, never its stack. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

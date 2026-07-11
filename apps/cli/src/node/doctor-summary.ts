/**
 * node/doctor-summary.ts — shared, pure health-classification helpers for
 * `memoriahub node doctor`.
 *
 * `node doctor` runs a 6-step sweep (API access, installed-capability
 * presence, real operational self-tests, job-type readiness, model
 * download/verify, daemon liveness) in two independent places:
 *
 *   - commands/node.ts's `doctorCmd()` — the plain CLI command, prints
 *     directly to stdout via `ui.*`.
 *   - tui/useNodeDoctorSweep.ts — a React hook driving the same sweep for two
 *     Ink screens (tui/NodeDoctor.tsx and the overlay in
 *     tui/NodeDashboard.tsx).
 *
 * Both surfaces need the same answer to "is this row healthy, and if not,
 * how bad": this module is that single source of truth. It is intentionally
 * plain TypeScript with NO React/Ink import and NO import from `../tui/*`, so
 * it can be imported symmetrically by a CLI command file and by TUI code
 * without creating a dependency from CLI-only code into the TUI layer (or
 * vice versa).
 */

import type { CapabilityStatus } from './capabilities.js';
import type { ApiAccessCheckResult } from './doctor-checks.js';

// ---------------------------------------------------------------------------
// Shared level type
// ---------------------------------------------------------------------------

export type HealthLevel = 'ok' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface CapabilityRowSummary {
  key: string;
  installed: CapabilityStatus;
  operational: CapabilityStatus;
  level: HealthLevel;
}

/**
 * Classify a single capability row.
 *
 *   - 'error' — not installed at all (the presence probe failed).
 *   - 'warn'  — installed, but the operational self-test hasn't passed yet
 *     (e.g. a model file not downloaded yet). Not an error — just not ready.
 *   - 'ok'    — installed and operational.
 */
export function capabilityRowLevel(
  installed: CapabilityStatus,
  operational: CapabilityStatus,
): HealthLevel {
  if (!installed.available) return 'error';
  if (!operational.available) return 'warn';
  return 'ok';
}

export interface CapabilitiesSummary {
  /** Every capability, in input order. */
  rows: CapabilityRowSummary[];
  /** Only rows where level !== 'ok'. */
  issues: CapabilityRowSummary[];
  okCount: number;
  totalCount: number;
}

/**
 * Merge `caps` (presence) with `operational` (self-test result) per key,
 * falling back to the presence status when a key is absent from
 * `operational` — mirrors the `operational[key] ?? status` pattern already
 * used by `printOperationalCapabilityTable` (commands/node.ts) and the TUI's
 * inline capability table.
 */
export function summarizeCapabilities(
  caps: Record<string, CapabilityStatus>,
  operational: Record<string, CapabilityStatus>,
): CapabilitiesSummary {
  const rows: CapabilityRowSummary[] = Object.entries(caps).map(([key, installed]) => {
    const op = operational[key] ?? installed;
    return {
      key,
      installed,
      operational: op,
      level: capabilityRowLevel(installed, op),
    };
  });

  const issues = rows.filter((row) => row.level !== 'ok');

  return {
    rows,
    issues,
    okCount: rows.length - issues.length,
    totalCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Job-type readiness
// ---------------------------------------------------------------------------

/**
 * Generic over the caller's row shape so this module never needs to import
 * (or re-declare) `JobReadinessRow` — that type lives in
 * `tui/useNodeDoctorSweep.ts`, and importing from `../tui/*` here would
 * create exactly the CLI→TUI dependency this module exists to avoid.
 * Structural typing on `{ ready: boolean }` is enough for the classification
 * logic; both `doctorCmd()` and the TUI hook can pass their own
 * `{ type, ready, missing }`-shaped rows directly.
 */
export interface JobReadinessSummary<T> {
  /** Only rows where !row.ready. */
  issues: T[];
  readyCount: number;
  totalCount: number;
}

export function summarizeJobReadiness<T extends { ready: boolean }>(
  rows: T[],
): JobReadinessSummary<T> {
  const issues = rows.filter((row) => !row.ready);
  return {
    issues,
    readyCount: rows.length - issues.length,
    totalCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

/**
 * Classify the overall API-access check.
 *
 *   - 'error' — auth failed (`authOk === false`). Nothing else works if the
 *     token itself is bad.
 *   - 'warn'  — auth is fine, but node-registration is explicitly invalid
 *     (`nodeRegistrationOk === false`, i.e. a definite "not found/inaccessible"
 *     answer, not merely "could not verify") or the model manifest is
 *     unreachable (`manifestOk === false`).
 *   - 'ok'    — otherwise. Notably `nodeRegistrationOk === null` (node not
 *     registered locally, or the check couldn't be performed) is 'ok', not a
 *     warning — an unregistered machine running `node doctor` before
 *     `node register` is an expected, informational state.
 */
export function apiAccessLevel(access: ApiAccessCheckResult): HealthLevel {
  if (!access.authOk) return 'error';
  if (access.nodeRegistrationOk === false || !access.manifestOk) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * Canonical URL for the worker-node dependency setup & troubleshooting guide,
 * printed by `node doctor` (CLI and TUI) so a user hitting a capability/API
 * problem has one place to go. Points at the GitHub-rendered doc, not a local
 * repo-relative path, because the standalone installed CLI (~/.memoriahub/app)
 * does not ship the docs/ folder.
 */
export const WORKER_NODE_SETUP_GUIDE_URL =
  'https://github.com/marinoscar/MemoriaHub/blob/main/docs/specs/worker-node-setup.md';

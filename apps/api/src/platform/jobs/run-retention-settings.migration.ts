import { REVIEW_RUNS_RETENTION_POLICY } from '../../review-runs/review-runs.retention';
import { WORKFLOW_RUNS_RETENTION_POLICY } from '../../workflows/runs/workflow-runs.retention';

// =============================================================================
// Carry the old run-history windows into `retention.*` (RETRO-C7, #604)
// =============================================================================
//
//   workflows.runHistoryRetentionDays  -> retention.workflowRuns.days
//   reviewRuns.runHistoryRetentionDays -> retention.reviewRuns.days
//
// A pure planner over the stored `system_settings` `global` value, run by
// `scripts/migrate-run-retention-settings.ts`.
//
// IDEMPOTENT BY CONSTRUCTION: a policy is written only while `retention.<key>`
// is ABSENT from the stored row (the platform has never stored it, so nobody has
// chosen a value there yet). Once written, or once an operator saves the
// retention settings, a re-run changes nothing. `enabled` is the policy default
// (true: the old purges always ran). The old keys are left in place; RETRO-C11
// removes them.
// =============================================================================

/** One carry-over decision. */
export interface RunRetentionCarryOver {
  /** The `retention` key. */
  readonly key: string;
  /** The legacy setting it comes from. */
  readonly from: string;
  /** `write`: the new policy is set; `keep`: retention already stored; `skip`: no legacy value. */
  readonly action: 'write' | 'keep' | 'skip';
  /** The days written (or kept), when any. */
  readonly days: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const MAPPINGS = [
  { policy: WORKFLOW_RUNS_RETENTION_POLICY, namespace: 'workflows' },
  { policy: REVIEW_RUNS_RETENTION_POLICY, namespace: 'reviewRuns' },
] as const;

/** A legacy value the policy accepts, or null. */
function legacyDays(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Plans the carry-over and returns the next stored value (a copy; the input is not mutated).
 */
export function planRunRetentionCarryOver(stored: unknown): {
  changes: RunRetentionCarryOver[];
  next: Record<string, unknown>;
} {
  const root: Record<string, unknown> = isObject(stored) ? structuredClone(stored) : {};
  const retention: Record<string, unknown> = isObject(root['retention']) ? { ...root['retention'] } : {};
  const changes: RunRetentionCarryOver[] = [];

  for (const { policy, namespace } of MAPPINGS) {
    const from = `${namespace}.runHistoryRetentionDays`;
    const ns = root[namespace];
    const days = legacyDays(isObject(ns) ? ns['runHistoryRetentionDays'] : undefined, policy.minDays ?? 1, policy.maxDays ?? 3650);
    const current = retention[policy.key];
    if (isObject(current)) {
      changes.push({ key: policy.key, from, action: 'keep', days: typeof current['days'] === 'number' ? current['days'] : null });
      continue;
    }
    if (days === null) {
      changes.push({ key: policy.key, from, action: 'skip', days: null });
      continue;
    }
    retention[policy.key] = { enabled: policy.defaultEnabled ?? false, days };
    changes.push({ key: policy.key, from, action: 'write', days });
  }

  if (changes.some((c) => c.action === 'write')) root['retention'] = retention;
  return { changes, next: root };
}

// =============================================================================
// MemoriaHubVerdictPolicy (RETRO-T3, #628)
// =============================================================================
//
// The dashboard's health verdict: the platform's (`DefaultVerdictPolicy`, every
// platform rule) plus MemoriaHub's four photo-pipeline rules
// (`memoriahub-verdict-rules.ts`). It only ever ADDS: a level is raised, never
// lowered, and `no_data` (no telemetry at all) is left alone. Bound by
// `platform/telemetry/telemetry.config.ts` (`dashboard.verdictPolicy`).
// =============================================================================

import { Injectable } from '@nestjs/common';
import {
  DefaultVerdictPolicy,
  type DashboardVerdict,
  type VerdictInput,
  type VerdictPolicy,
  type VerdictThresholds,
} from '@marinoscar/platform-api/telemetry';

import { MemoriaHubTelemetrySignals, type MemoriaHubVerdictSignals } from './memoriahub-telemetry-signals.service';
import { MEMORIAHUB_VERDICT_RULES, type MemoriaHubVerdictRules } from './memoriahub-verdict-rules';

type Level = DashboardVerdict['level'];
const RANK: Record<Level, number> = { healthy: 0, degraded: 1, critical: 2, no_data: 3 };

const pct = (value: number) => `${Math.round(value * 10) / 10} %`;
const minutes = (value: number) => (value >= 120 ? `${Math.round(value / 6) / 10} h` : `${Math.round(value)} min`);

/**
 * MemoriaHub's rules over `signals`, raised onto `verdict`. Pure: the policy's
 * whole behaviour, testable without Nest.
 */
export function applyMemoriaHubRules(
  verdict: DashboardVerdict,
  signals: MemoriaHubVerdictSignals | null,
  rules: MemoriaHubVerdictRules = MEMORIAHUB_VERDICT_RULES,
): DashboardVerdict {
  if (verdict.level === 'no_data' || !signals) return verdict;

  let level: Level = verdict.level;
  const reasons = [...verdict.reasons];
  const fire = (fired: 'degraded' | 'critical', reason: string) => {
    if (RANK[fired] > RANK[level]) level = fired;
    reasons.push(reason);
  };

  // 1. Enrichment failure ratio, per job type.
  const failure = rules.enrichmentFailurePct;
  for (const { type, succeeded, failed } of signals.settled) {
    const settled = succeeded + failed;
    if (settled < failure.minSettled) continue;
    const ratio = (failed / settled) * 100;
    if (ratio > failure.critical) {
      fire('critical', `Enrichment: ${type} failed ${pct(ratio)} of ${settled} jobs (critical above ${failure.critical} %)`);
    } else if (ratio > failure.degraded) {
      fire('degraded', `Enrichment: ${type} failed ${pct(ratio)} of ${settled} jobs (degraded above ${failure.degraded} %)`);
    }
  }

  // 2. Oldest pending upload-time job.
  const age = rules.uploadOldestPendingMinutes;
  for (const { type, ageMinutes } of signals.oldestPending) {
    if (ageMinutes > age.critical) {
      fire('critical', `Upload backlog: oldest ${type} job waiting ${minutes(ageMinutes)} (critical above ${minutes(age.critical)})`);
    } else if (ageMinutes > age.degraded) {
      fire('degraded', `Upload backlog: oldest ${type} job waiting ${minutes(ageMinutes)} (degraded above ${minutes(age.degraded)})`);
    }
  }

  // 3. Sustained processing backlog: every sample over a long-enough span.
  const backlog = rules.processingBacklog;
  const samples = signals.backlogSamples;
  if (samples.length >= 2 && samples[samples.length - 1].at - samples[0].at >= backlog.minSpanMinutes * 60_000) {
    const floor = Math.min(...samples.map((sample) => sample.processing));
    if (floor > backlog.critical) {
      fire('critical', `Media processing: at least ${floor} objects processing throughout the window (critical above ${backlog.critical})`);
    } else if (floor > backlog.degraded) {
      fire('degraded', `Media processing: at least ${floor} objects processing throughout the window (degraded above ${backlog.degraded})`);
    }
  }

  // 4. Idle fleet.
  const { fleet } = signals;
  if (fleet.registered > 0 && fleet.online === 0 && fleet.nodeEligiblePending > rules.idleFleet.minNodeEligiblePending) {
    fire(
      'degraded',
      `Worker fleet: ${fleet.nodeEligiblePending} node-eligible jobs pending and none of ${fleet.registered} registered nodes is online`,
    );
  }

  return { level, reasons };
}

@Injectable()
export class MemoriaHubVerdictPolicy implements VerdictPolicy {
  constructor(
    private readonly platform: DefaultVerdictPolicy,
    private readonly signals: MemoriaHubTelemetrySignals,
  ) {}

  compute(input: VerdictInput, thresholds: VerdictThresholds): DashboardVerdict {
    // Every platform rule first: this policy only ever adds to it.
    return applyMemoriaHubRules(this.platform.compute(input, thresholds), this.signals.verdictSignals());
  }
}

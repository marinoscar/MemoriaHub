// =============================================================================
// MemoriaHub's default alert rules (RETRO-H5, #609)
// =============================================================================
//
// The platform seeds its eight starter rules DISABLED (`AlertsSeedService`, on
// application bootstrap, create-if-absent by key). MemoriaHub wants two of them
// on in production (`nodes.offline`, `jobs.failure_spike`: operators asked to be
// told about crashed workers and failure bursts, issue #439) and adds three of
// its own:
//
//   key                              kind                         default
//   memoriahub.enrichment_failures   metric_threshold             > 5 permanent failures / 1 h per job type, for 10 min
//   memoriahub.queue_stalled         memoriahub_queue_stalled     > 500 pending and 0 succeeded in 30 min
//   memoriahub.db_backup_stale       memoriahub_db_backup_stale   last completed backup older than 2 schedule intervals
//
// HOW IT NEVER OVERWRITES AN OPERATOR EDIT: this seed only CREATES a rule whose
// key has no row, exactly like the platform's. It runs in `onModuleInit`, which
// Nest finishes for every module before any `onApplicationBootstrap`, so on a
// fresh deployment it creates the two starter rows FIRST (enabled in production)
// and the platform seed then finds them and skips them. Once a row exists,
// nothing here touches it again: an operator who disables `nodes.offline` keeps
// it disabled across every restart. A deployment whose platform seed already ran
// (alerts mounted outside production first) keeps its disabled starter rows:
// turning them on is then the operator's call, in the admin page.
//
// Outside production every rule here is seeded DISABLED (development and CI
// databases do not page anyone). Keyed rules are protected by the platform: they
// can be edited and disabled, never deleted.
//
// A failure is logged, never thrown (an unreachable database at boot is the
// health checks' problem, not a reason to stop the process).
// =============================================================================

import { Inject, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLATFORM_PRISMA } from '@marinoscar/platform-api/core';
import {
  STARTER_ALERT_RULES,
  isUniqueViolation,
  metricThresholdKind,
  parseAlertConfig,
  type AlertsPrisma,
} from '@marinoscar/platform-api/alerts';

import { MEMORIAHUB_ALERT_KIND_IDS } from './memoriahub-alert-kinds';

/** An alert severity (`ALERT_SEVERITIES` of the contract; the API workspace does not import the contract package). */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** One rule this app seeds: the platform's `StarterAlertRule['rule']` shape plus the key. */
export interface MemoriaHubSeedRule {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly config: Record<string, unknown>;
  readonly forSeconds: number;
  readonly cooldownSeconds: number;
  readonly notifyChannels: readonly string[];
  readonly webhook: boolean;
}

/** Stable keys of MemoriaHub's own rules (permanent: the seed matches on them). */
export const MEMORIAHUB_ALERT_RULE_KEYS = {
  ENRICHMENT_FAILURES: 'memoriahub.enrichment_failures',
  QUEUE_STALLED: 'memoriahub.queue_stalled',
  DB_BACKUP_STALE: 'memoriahub.db_backup_stale',
} as const;

/** The starter rules MemoriaHub turns on in production (the others stay the operator's choice). */
export const ENABLED_STARTER_RULE_KEYS: readonly string[] = ['nodes.offline', 'jobs.failure_spike'];

/**
 * Permanent job failures per hour above which one job type alerts: more than 5
 * (6 or more) in an hour. The `rate` aggregation reads a counter's increase PER
 * MINUTE, so the threshold is 5.4 / 60 (between 5/60 and 6/60, never equal to a
 * whole count).
 */
export const ENRICHMENT_FAILURES_PER_HOUR = 5;
const ENRICHMENT_FAILURES_RATE_THRESHOLD = 0.09;

const base = { notifyChannels: [] as string[], webhook: true, cooldownSeconds: 900 };

/** MemoriaHub's own rules. */
export const MEMORIAHUB_ALERT_RULES: readonly MemoriaHubSeedRule[] = [
  {
    ...base,
    key: MEMORIAHUB_ALERT_RULE_KEYS.ENRICHMENT_FAILURES,
    name: 'Enrichment failures by job type',
    description:
      `More than ${ENRICHMENT_FAILURES_PER_HOUR} jobs of one type failed permanently in the last hour ` +
      '(face detection, tagging, video, geocode, enhancement, memories, ...). One incident per job type.',
    kind: metricThresholdKind.id,
    severity: 'warning',
    forSeconds: 600,
    config: {
      metric: 'app.jobs.settled',
      aggregation: 'rate',
      windowSeconds: 3600,
      comparator: 'gt',
      threshold: ENRICHMENT_FAILURES_RATE_THRESHOLD,
      groupBy: ['job_type'],
      filters: [{ attr: 'outcome', op: 'eq', value: 'failed' }],
    },
  },
  {
    ...base,
    key: MEMORIAHUB_ALERT_RULE_KEYS.QUEUE_STALLED,
    name: 'Enrichment queue stalled',
    description: 'More than 500 jobs are waiting and none has succeeded in 30 minutes: the workers are stopped or crash-looping.',
    kind: MEMORIAHUB_ALERT_KIND_IDS.QUEUE_STALLED,
    severity: 'critical',
    forSeconds: 300,
    config: { minPending: 500, windowSeconds: 1800 },
  },
  {
    ...base,
    key: MEMORIAHUB_ALERT_RULE_KEYS.DB_BACKUP_STALE,
    name: 'Database backup stale',
    description:
      'Scheduled database backups are on, but the newest completed backup is older than two schedule intervals.',
    kind: MEMORIAHUB_ALERT_KIND_IDS.DB_BACKUP_STALE,
    severity: 'critical',
    forSeconds: 0,
    config: { intervalMultiplier: 2, cronIntervalHours: 24 },
  },
];

/** The rows this app creates when absent: the two starter rules it enables, then its own. */
export function memoriaHubSeedRules(): MemoriaHubSeedRule[] {
  const starters = STARTER_ALERT_RULES.filter(({ key }) => ENABLED_STARTER_RULE_KEYS.includes(key)).map(
    ({ key, rule }) => ({
      key,
      name: rule.name,
      description: rule.description ?? '',
      kind: rule.kind,
      severity: rule.severity,
      config: rule.config as Record<string, unknown>,
      forSeconds: rule.forSeconds,
      cooldownSeconds: rule.cooldownSeconds,
      notifyChannels: [...rule.notifyChannels],
      webhook: rule.webhook,
    }),
  );
  return [...starters, ...MEMORIAHUB_ALERT_RULES];
}

/** Whether this process seeds the rules ENABLED. */
export function seedsEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production';
}

/** Creates MemoriaHub's default rules when their keys have no row. */
@Injectable()
export class MemoriaHubAlertRulesSeedService implements OnModuleInit {
  private readonly logger = new Logger(MemoriaHubAlertRulesSeedService.name);

  constructor(
    @Inject(PLATFORM_PRISMA) private readonly prisma: AlertsPrisma,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      this.logger.warn(`Could not seed MemoriaHub's alert rules: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** @returns how many rules were created. */
  async seed(): Promise<number> {
    const enabled = seedsEnabled(this.config.get<string>('nodeEnv') ?? process.env.NODE_ENV);
    let created = 0;
    for (const rule of memoriaHubSeedRules()) {
      if (await this.prisma.alertRule.findUnique({ where: { key: rule.key } })) continue;
      try {
        await this.prisma.alertRule.create({
          data: {
            key: rule.key,
            name: rule.name,
            description: rule.description,
            enabled,
            kind: rule.kind,
            severity: rule.severity,
            config: parseAlertConfig(rule.kind, rule.config),
            forSeconds: rule.forSeconds,
            cooldownSeconds: rule.cooldownSeconds,
            notifyChannels: [...rule.notifyChannels],
            webhook: rule.webhook,
          },
        });
        created += 1;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error; // another replica seeded it first
      }
    }
    if (created > 0) {
      this.logger.log(`Seeded ${created} MemoriaHub alert rule(s), ${enabled ? 'enabled' : 'disabled (not production)'}.`);
    }
    return created;
  }
}

/** Hosts the seed. Mounted beside `AlertsModule.forRoot` by `alerts.config.ts`. */
@Module({ providers: [MemoriaHubAlertRulesSeedService] })
export class MemoriaHubAlertRulesModule {}

// MemoriaHub's default alert rules (RETRO-H5, #609): the seed (create-if-absent,
// enabled only in production, never overwriting an operator edit, ordered before
// the platform's starter seed) and the per-job-type failure rule end to end
// through the platform evaluator: a burst of permanent `auto_tagging` failures
// opens exactly ONE incident for that type and notifies the `alerts:read` holders.
import { ConfigService } from '@nestjs/config';
import {
  AlertContextService,
  AlertsDispatchService,
  AlertsEvaluationService,
  AlertsMetrics,
  AlertsSeedService,
  STARTER_ALERT_RULES,
  buildMetricThresholdSql,
  metricThresholdKind,
  resolveAlertsModuleOptions,
} from '@marinoscar/platform-api/alerts';
import { createFakeContext, createInMemoryAlertsPrisma } from '@marinoscar/platform-api/alerts/testing';

import '../../src/app-registrations/alerts';
import {
  ENABLED_STARTER_RULE_KEYS,
  MEMORIAHUB_ALERT_RULE_KEYS,
  MEMORIAHUB_ALERT_RULES,
  MemoriaHubAlertRulesSeedService,
  memoriaHubSeedRules,
  seedsEnabled,
} from '../../src/platform/alerts/memoriahub-alert-rules.seed';

const config = (nodeEnv: string) => ({ get: (key: string) => (key === 'nodeEnv' ? nodeEnv : undefined) }) as unknown as ConfigService;

describe('MemoriaHub alert rule seed', () => {
  it('enables only in production', () => {
    expect(seedsEnabled('production')).toBe(true);
    expect(seedsEnabled('development')).toBe(false);
    expect(seedsEnabled('test')).toBe(false);
    expect(seedsEnabled(undefined)).toBe(false);
  });

  it('seeds nodes.offline and jobs.failure_spike plus the three MemoriaHub rules, enabled in production', async () => {
    const prisma = createInMemoryAlertsPrisma();
    const created = await new MemoriaHubAlertRulesSeedService(prisma, config('production')).seed();
    expect(created).toBe(5);
    expect(prisma.rules.map((r) => r.key).sort()).toEqual(
      [...ENABLED_STARTER_RULE_KEYS, ...Object.values(MEMORIAHUB_ALERT_RULE_KEYS)].sort(),
    );
    expect(prisma.rules.every((r) => r.enabled)).toBe(true);
  });

  it('copies the starter rules unchanged except for enabled', () => {
    for (const key of ENABLED_STARTER_RULE_KEYS) {
      const starter = STARTER_ALERT_RULES.find((s) => s.key === key)!;
      const ours = memoriaHubSeedRules().find((r) => r.key === key)!;
      expect(ours).toMatchObject({ kind: starter.rule.kind, severity: starter.rule.severity, config: starter.rule.config });
    }
  });

  it('seeds everything disabled outside production', async () => {
    const prisma = createInMemoryAlertsPrisma();
    await new MemoriaHubAlertRulesSeedService(prisma, config('development')).seed();
    expect(prisma.rules).toHaveLength(5);
    expect(prisma.rules.some((r) => r.enabled)).toBe(false);
  });

  it('never overwrites an operator edit, and a second run creates nothing', async () => {
    const prisma = createInMemoryAlertsPrisma();
    const seed = new MemoriaHubAlertRulesSeedService(prisma, config('production'));
    await seed.seed();
    const offline = prisma.rules.find((r) => r.key === 'nodes.offline')!;
    offline.enabled = false; // the operator disabled it
    offline.forSeconds = 600;
    expect(await seed.seed()).toBe(0);
    expect(prisma.rules.find((r) => r.key === 'nodes.offline')).toMatchObject({ enabled: false, forSeconds: 600 });
  });

  it('runs before the platform seed, which then adds only the six remaining starter rules disabled', async () => {
    const prisma = createInMemoryAlertsPrisma();
    await new MemoriaHubAlertRulesSeedService(prisma, config('production')).seed();
    const platformCreated = await new AlertsSeedService(prisma, resolveAlertsModuleOptions()).seed();
    expect(platformCreated).toBe(STARTER_ALERT_RULES.length - 2);
    for (const { key } of STARTER_ALERT_RULES) {
      const row = prisma.rules.find((r) => r.key === key)!;
      expect(row.enabled).toBe(ENABLED_STARTER_RULE_KEYS.includes(key));
    }
  });

  it('logs and swallows a database failure at boot', async () => {
    const prisma = createInMemoryAlertsPrisma();
    prisma.alertRule.findUnique = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(new MemoriaHubAlertRulesSeedService(prisma, config('production')).onModuleInit()).resolves.toBeUndefined();
  });
});

describe('memoriahub.enrichment_failures (metric_threshold over app.jobs.settled)', () => {
  const rule = MEMORIAHUB_ALERT_RULES.find((r) => r.key === MEMORIAHUB_ALERT_RULE_KEYS.ENRICHMENT_FAILURES)!;
  const table = {
    name: 'app_jobs_settled_total',
    columns: new Set(['greptime_timestamp', 'greptime_value', 'job_type', 'outcome', 'executor', 'host_name']),
    tags: ['executor', 'host_name', 'job_type', 'outcome'],
  };
  const sql = {
    ident: (c: string) => `"${c}"`,
    literal: (v: string) => `'${v}'`,
    between: (c: string, from: Date, to: Date) => `"${c}" BETWEEN '${from.toISOString()}' AND '${to.toISOString()}'`,
    timestamp: (d: Date) => `'${d.toISOString()}'`,
  };
  const dialect = {
    id: 'fake',
    timestampColumn: 'greptime_timestamp',
    valueColumn: 'greptime_value',
    castText: (e: string) => `CAST(${e} AS STRING)`,
  };

  it('is a valid metric_threshold config grouped by job_type and filtered to permanent failures', () => {
    const parsed = metricThresholdKind.configSchema.parse(rule.config);
    const text = buildMetricThresholdSql(parsed, table, { sql, dialect } as never, new Date('2026-11-08T12:00:00Z'));
    expect(text).toContain(`"outcome" = 'failed'`);
    expect(text).toContain('GROUP BY "job_type"');
    expect(rule).toMatchObject({ forSeconds: 600 });
  });

  it('fires more than 5 per hour (6 or more), not exactly 5', () => {
    const threshold = (rule.config as { threshold: number }).threshold;
    expect(6 / 60).toBeGreaterThan(threshold);
    expect(5 / 60).toBeLessThan(threshold);
  });

  it('a burst of auto_tagging failures opens ONE incident for that type and notifies alerts:read holders', async () => {
    const prisma = createInMemoryAlertsPrisma();
    await new MemoriaHubAlertRulesSeedService(prisma, config('production')).seed();
    const row = prisma.rules.find((r) => r.key === MEMORIAHUB_ALERT_RULE_KEYS.ENRICHMENT_FAILURES)!;

    // The store answers one row per group: [job_type, failures per minute over the hour].
    const rows = [
      ['auto_tagging', 7 / 60],
      ['geocode', 1 / 60],
    ];
    const telemetry = {
      query: { sql, dialect, query: jest.fn(async () => ({ columns: [], rows })) },
      tables: new Map([[table.name, table]]),
    };
    let now = new Date('2026-11-08T12:00:00Z');
    const contexts = {
      create: (_signal: AbortSignal) => createFakeContext(prisma, { now, telemetry: telemetry as never }),
    } as unknown as AlertContextService;
    const notifications = { notifyPermissionHolders: jest.fn().mockResolvedValue(undefined) };
    const dispatcher = new AlertsDispatchService(new AlertsMetrics(prisma), notifications as never);
    const evaluation = new AlertsEvaluationService(prisma, contexts, dispatcher, resolveAlertsModuleOptions());

    await evaluation.evaluateRule(row, now);
    expect(prisma.incidents).toHaveLength(1);
    expect(prisma.incidents[0]).toMatchObject({ state: 'pending', labels: { job_type: 'auto_tagging' } });

    now = new Date(now.getTime() + 11 * 60_000); // past `for` (10 min)
    await evaluation.evaluateRule(row, now);
    await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.incidents).toHaveLength(1);
    expect(prisma.incidents[0].state).toBe('firing');
    expect(notifications.notifyPermissionHolders).toHaveBeenCalledTimes(1);
    expect(notifications.notifyPermissionHolders.mock.calls[0][1]).toBe('alerts:read');
  });
});

// MemoriaHub's two alert rule kinds (RETRO-H5, #609): registration, config
// validation and evaluation against an in-memory client. Both kinds are
// read-only: the doubles below expose only count / findFirst / findUnique.
import { alertRuleKindRegistry } from '@marinoscar/platform-api/alerts';
import { createFakeContext, createInMemoryAlertsPrisma } from '@marinoscar/platform-api/alerts/testing';

import '../../src/app-registrations/alerts';
import {
  MEMORIAHUB_ALERT_KIND_IDS,
  appTables,
  dbBackupStaleKind,
  queueStalledKind,
  readBackupSchedule,
} from '../../src/platform/alerts/memoriahub-alert-kinds';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const HOUR = 3_600_000;

interface Tables {
  pending?: number;
  succeeded?: number;
  settings?: unknown;
  lastCompleted?: { createdAt: Date; finishedAt: Date | null } | null;
  oldest?: { createdAt: Date; finishedAt: Date | null } | null;
}

/** The in-memory alerts client plus the three app delegates the kinds read. */
function contextWith(tables: Tables) {
  const db = createInMemoryAlertsPrisma() as unknown as Record<string, unknown>;
  const job = {
    count: jest.fn(async ({ where }: { where: { status: string } }) =>
      where.status === 'pending' ? (tables.pending ?? 0) : (tables.succeeded ?? 0),
    ),
  };
  const databaseBackupRun = {
    findFirst: jest.fn(async ({ orderBy }: { orderBy: { createdAt: 'asc' | 'desc' } }) =>
      orderBy.createdAt === 'desc' ? (tables.lastCompleted ?? null) : (tables.oldest ?? null),
    ),
  };
  const systemSettings = {
    findUnique: jest.fn(async () => (tables.settings === undefined ? null : { value: tables.settings })),
  };
  Object.assign(db, { job, databaseBackupRun, systemSettings });
  const ctx = createFakeContext(db as never, { now: NOW });
  return { ctx, job, databaseBackupRun, systemSettings };
}

function view<C>(kind: { id: string; configSchema: { parse(v: unknown): C } }, config: unknown = {}) {
  return { id: 'rule-1', key: null, name: 'Rule', severity: 'warning' as const, kind: kind.id, config: kind.configSchema.parse(config) };
}

describe('MemoriaHub alert kinds: registration', () => {
  it('registers both kinds under permanent, pattern-valid ids', () => {
    expect(MEMORIAHUB_ALERT_KIND_IDS).toEqual({
      QUEUE_STALLED: 'memoriahub_queue_stalled',
      DB_BACKUP_STALE: 'memoriahub_db_backup_stale',
    });
    for (const id of Object.values(MEMORIAHUB_ALERT_KIND_IDS)) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(id.length).toBeLessThanOrEqual(32);
      expect(alertRuleKindRegistry.has(id)).toBe(true);
    }
  });

  it('defaults and bounds the configs', () => {
    expect(queueStalledKind.configSchema.parse({})).toEqual({ minPending: 500, windowSeconds: 1800 });
    expect(queueStalledKind.configSchema.safeParse({ minPending: 0 }).success).toBe(false);
    expect(queueStalledKind.configSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(dbBackupStaleKind.configSchema.parse({})).toEqual({ intervalMultiplier: 2, cronIntervalHours: 24 });
    expect(dbBackupStaleKind.configSchema.safeParse({ intervalMultiplier: 0.5 }).success).toBe(false);
  });

  it('fails the rule clearly when the client lacks an app table', () => {
    const ctx = createFakeContext(createInMemoryAlertsPrisma(), { now: NOW });
    expect(() => appTables(ctx)).toThrow(/no "job" table/);
  });
});

describe('memoriahub_queue_stalled', () => {
  it('breaches when more than minPending claimable jobs wait and none succeeded in the window', async () => {
    const { ctx, job } = contextWith({ pending: 501, succeeded: 0 });
    const [obs] = await queueStalledKind.evaluate(ctx, view(queueStalledKind));
    expect(obs).toMatchObject({ labels: {}, value: 501, breached: true });
    expect(obs.summary).toContain('501 jobs pending and none succeeded in 30 min');
    // Claimable pending only; succeeded within the window.
    expect(job.count).toHaveBeenCalledWith({
      where: { status: 'pending', OR: [{ scheduledFor: null }, { scheduledFor: { lte: NOW } }] },
    });
    expect(job.count).toHaveBeenCalledWith({
      where: { status: 'succeeded', finishedAt: { gte: new Date(NOW.getTime() - 1800 * 1000) } },
    });
  });

  it('does not breach while jobs still succeed', async () => {
    const { ctx } = contextWith({ pending: 5000, succeeded: 1 });
    const [obs] = await queueStalledKind.evaluate(ctx, view(queueStalledKind));
    expect(obs.breached).toBe(false);
  });

  it('does not breach at or below minPending', async () => {
    const { ctx } = contextWith({ pending: 500, succeeded: 0 });
    const [obs] = await queueStalledKind.evaluate(ctx, view(queueStalledKind));
    expect(obs.breached).toBe(false);
  });
});

describe('memoriahub_db_backup_stale', () => {
  const settings = (databaseBackup: Record<string, unknown>) => ({ databaseBackup });

  it('reads the schedule defensively (absent or malformed means off)', () => {
    expect(readBackupSchedule(undefined)).toEqual({ enabled: false, frequency: 'daily' });
    expect(readBackupSchedule({ databaseBackup: { enabled: 'yes' } })).toEqual({ enabled: false, frequency: 'daily' });
    expect(readBackupSchedule(settings({ enabled: true, frequency: 'weekly' }))).toEqual({ enabled: true, frequency: 'weekly' });
  });

  it('never breaches while scheduled backups are off', async () => {
    const { ctx, databaseBackupRun } = contextWith({ settings: settings({ enabled: false }) });
    const [obs] = await dbBackupStaleKind.evaluate(ctx, view(dbBackupStaleKind));
    expect(obs).toMatchObject({ breached: false, value: null });
    expect(databaseBackupRun.findFirst).not.toHaveBeenCalled();
  });

  it('breaches a daily schedule whose last completed backup is older than 48 h', async () => {
    const at = new Date(NOW.getTime() - 49 * HOUR);
    const { ctx } = contextWith({ settings: settings({ enabled: true, frequency: 'daily' }), lastCompleted: { createdAt: at, finishedAt: at } });
    const [obs] = await dbBackupStaleKind.evaluate(ctx, view(dbBackupStaleKind));
    expect(obs).toMatchObject({ breached: true, value: 49 });
    expect(obs.summary).toContain('limit 48 h');
  });

  it('does not breach a daily schedule with a backup 30 h old', async () => {
    const at = new Date(NOW.getTime() - 30 * HOUR);
    const { ctx } = contextWith({ settings: settings({ enabled: true, frequency: 'daily' }), lastCompleted: { createdAt: at, finishedAt: at } });
    const [obs] = await dbBackupStaleKind.evaluate(ctx, view(dbBackupStaleKind));
    expect(obs.breached).toBe(false);
  });

  it('scales the limit with the frequency (weekly: 14 days) and uses cronIntervalHours for cron', async () => {
    const at = new Date(NOW.getTime() - 10 * 24 * HOUR);
    const weekly = contextWith({ settings: settings({ enabled: true, frequency: 'weekly' }), lastCompleted: { createdAt: at, finishedAt: at } });
    expect((await dbBackupStaleKind.evaluate(weekly.ctx, view(dbBackupStaleKind)))[0].breached).toBe(false);
    const cron = contextWith({ settings: settings({ enabled: true, frequency: 'cron' }), lastCompleted: { createdAt: at, finishedAt: at } });
    expect((await dbBackupStaleKind.evaluate(cron.ctx, view(dbBackupStaleKind, { cronIntervalHours: 168 })))[0].breached).toBe(false);
    expect((await dbBackupStaleKind.evaluate(cron.ctx, view(dbBackupStaleKind)))[0].breached).toBe(true);
  });

  it('waits for the first backup of a freshly enabled schedule, then breaches once the window passed', async () => {
    const fresh = contextWith({ settings: settings({ enabled: true }), lastCompleted: null, oldest: null });
    expect((await dbBackupStaleKind.evaluate(fresh.ctx, view(dbBackupStaleKind)))[0].breached).toBe(false);
    const old = new Date(NOW.getTime() - 72 * HOUR);
    const failing = contextWith({ settings: settings({ enabled: true }), lastCompleted: null, oldest: { createdAt: old, finishedAt: old } });
    const [obs] = await dbBackupStaleKind.evaluate(failing.ctx, view(dbBackupStaleKind));
    expect(obs.breached).toBe(true);
    expect(obs.summary).toContain('no backup has ever completed');
  });
});

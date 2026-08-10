import { Logger } from '@nestjs/common';

// The timezone assertion in this spec is about the ARGUMENT `nextCronDate`
// receives, not about re-testing the cron library, so the real implementation
// is kept and merely wrapped in a spy.
jest.mock('../workflows/util/cron.util', () => {
  const actual = jest.requireActual('../workflows/util/cron.util');
  return { ...actual, nextCronDate: jest.fn(actual.nextCronDate) };
});

import { nextCronDate } from '../workflows/util/cron.util';
import { DatabaseBackupScheduleTask } from './db-backup-schedule.task';
import { DatabaseBackupAlreadyRunningError } from './db-backup.errors';

const nextCronDateMock = nextCronDate as jest.MockedFunction<typeof nextCronDate>;

interface RunRow {
  id: string;
  status: string;
  startedAt: Date | null;
  lastHeartbeatAt: Date | null;
  storageProvider: string | null;
  storageKey: string | null;
  bucket: string | null;
}

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-1',
    status: 'running',
    startedAt: new Date('2026-03-10T01:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z'),
    storageProvider: 's3',
    storageKey: 'db-backups/run-1.dump',
    bucket: 'memoria',
    ...over,
  };
}

/**
 * Faithfully evaluates the `where` the task builds for its staleness sweep, so
 * "a fresh heartbeat is untouched" is proven by the real cutoff the task
 * computed from `runStaleMinutes` rather than by a hand-fed fixture list.
 */
function applyStaleWhere(rows: RunRow[], where: any): RunRow[] {
  const cutoff: Date = where.OR[0].lastHeartbeatAt.lt;
  return rows.filter(
    (r) =>
      r.status === where.status &&
      ((r.lastHeartbeatAt !== null && r.lastHeartbeatAt.getTime() < cutoff.getTime()) ||
        (r.lastHeartbeatAt === null &&
          r.startedAt !== null &&
          r.startedAt.getTime() < cutoff.getTime())),
  );
}

const DEFAULT_SETTINGS = {
  enabled: true,
  frequency: 'daily' as const,
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  runStaleMinutes: 30,
  oldDatabaseRetentionHours: 168,
};

describe('DatabaseBackupScheduleTask (issue #342)', () => {
  let prisma: any;
  let systemSettings: any;
  let runner: any;
  let retention: any;
  let providerResolver: any;
  let provider: any;
  let task: DatabaseBackupScheduleTask;

  /** Rows the staleness sweep's findMany filters over. */
  let staleCandidates: RunRow[];
  /** What findFirst (the "latest run" lookup) returns. */
  let latestRun: { id: string; startedAt: Date | null } | null;

  function build(settingsOverride: Record<string, unknown> = {}) {
    staleCandidates = [];
    latestRun = null;

    prisma = {
      databaseBackupRun: {
        findMany: jest.fn(async ({ where }: any) => applyStaleWhere(staleCandidates, where)),
        findFirst: jest.fn(async () => latestRun),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    systemSettings = {
      getSettings: jest.fn(async () => ({
        databaseBackup: { ...DEFAULT_SETTINGS, ...settingsOverride },
      })),
    };
    runner = { runBackup: jest.fn(async () => ({ runId: 'new-run' })) };
    retention = { pruneAfterSuccessfulRun: jest.fn(async () => ({ prunedByCount: 0, prunedByAge: 0, errors: 0 })) };
    provider = { delete: jest.fn(async () => undefined) };
    providerResolver = { getProviderFor: jest.fn(async () => provider) };

    task = new DatabaseBackupScheduleTask(
      prisma,
      systemSettings,
      runner,
      retention,
      providerResolver,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-10T02:05:00.000Z'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    delete process.env['DB_BACKUP_SCHEDULE_ENABLED'];
    build();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env['DB_BACKUP_SCHEDULE_ENABLED'];
  });

  // ---------------------------------------------------------------------------
  // Firing
  // ---------------------------------------------------------------------------

  describe('firing a due backup', () => {
    it('fires when the last run predates the current boundary', async () => {
      // Boundary for daily @02:00 UTC, now = 02:05Z, is today 02:00Z.
      latestRun = { id: 'old', startedAt: new Date('2026-03-09T02:00:10.000Z') };

      await task.handleTick();

      expect(runner.runBackup).toHaveBeenCalledTimes(1);
      expect(runner.runBackup).toHaveBeenCalledWith({
        trigger: 'scheduled',
        createdById: null,
      });
    });

    it('fires when there has never been a run at all', async () => {
      latestRun = null;

      await task.handleTick();

      expect(runner.runBackup).toHaveBeenCalledTimes(1);
    });

    it('prunes retention only after a successful run', async () => {
      latestRun = null;

      await task.handleTick();

      expect(retention.pruneAfterSuccessfulRun).toHaveBeenCalledTimes(1);
    });

    it('does NOT double-fire within one window — a run at/after the boundary suppresses the tick', async () => {
      latestRun = { id: 'today', startedAt: new Date('2026-03-10T02:00:05.000Z') };

      await task.handleTick();
      // A second tick 10 minutes later must still not fire.
      jest.setSystemTime(new Date('2026-03-10T02:15:00.000Z'));
      await task.handleTick();

      expect(runner.runBackup).not.toHaveBeenCalled();
      expect(retention.pruneAfterSuccessfulRun).not.toHaveBeenCalled();
    });

    it('treats a run started exactly ON the boundary as already fired', async () => {
      latestRun = { id: 'exact', startedAt: new Date('2026-03-10T02:00:00.000Z') };

      await task.handleTick();

      expect(runner.runBackup).not.toHaveBeenCalled();
    });

    it('does nothing when databaseBackup.enabled is false', async () => {
      build({ enabled: false });
      latestRun = null;

      await task.handleTick();

      expect(runner.runBackup).not.toHaveBeenCalled();
      // The staleness sweep still runs — releasing an orphaned run must not
      // depend on the schedule being switched on.
      expect(prisma.databaseBackupRun.findMany).toHaveBeenCalledTimes(1);
    });

    it('respects a weekly schedule (no fire on the wrong day)', async () => {
      // 2026-03-10 is a Tuesday; a Monday schedule last fired on the 9th.
      build({ frequency: 'weekly', dayOfWeek: 1 });
      latestRun = { id: 'mon', startedAt: new Date('2026-03-09T02:00:01.000Z') };

      await task.handleTick();

      expect(runner.runBackup).not.toHaveBeenCalled();
    });

    it('respects a monthly schedule', async () => {
      build({ frequency: 'monthly', dayOfMonth: 1 });
      latestRun = { id: 'feb', startedAt: new Date('2026-02-01T02:00:01.000Z') };

      // Boundary is 2026-03-01T02:00Z, which is after the February run.
      await task.handleTick();

      expect(runner.runBackup).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // P2002 / concurrency
  // ---------------------------------------------------------------------------

  describe('losing the single-active-run race', () => {
    it('no-ops (does not throw, does not prune) when the runner reports a run already in progress', async () => {
      latestRun = null;
      runner.runBackup.mockRejectedValue(new DatabaseBackupAlreadyRunningError('other-run'));

      await expect(task.handleTick()).resolves.toBeUndefined();

      expect(retention.pruneAfterSuccessfulRun).not.toHaveBeenCalled();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('swallows (and logs) any other runner failure without pruning', async () => {
      latestRun = null;
      runner.runBackup.mockRejectedValue(new Error('pg_dump exited 1'));

      await expect(task.handleTick()).resolves.toBeUndefined();

      expect(retention.pruneAfterSuccessfulRun).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('never throws even when settings cannot be read', async () => {
      systemSettings.getSettings.mockRejectedValue(new Error('db down'));

      await expect(task.handleTick()).resolves.toBeUndefined();
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Kill-switch + overlap guard
  // ---------------------------------------------------------------------------

  describe('DB_BACKUP_SCHEDULE_ENABLED', () => {
    it('fully disables the task when set to "false"', async () => {
      process.env['DB_BACKUP_SCHEDULE_ENABLED'] = 'false';
      latestRun = null;
      staleCandidates = [runRow({ lastHeartbeatAt: new Date('2026-03-10T00:00:00.000Z') })];

      await task.handleTick();

      expect(systemSettings.getSettings).not.toHaveBeenCalled();
      expect(prisma.databaseBackupRun.findMany).not.toHaveBeenCalled();
      expect(runner.runBackup).not.toHaveBeenCalled();
    });

    it('stays enabled for any other value', async () => {
      process.env['DB_BACKUP_SCHEDULE_ENABLED'] = 'true';
      latestRun = null;

      await task.handleTick();

      expect(runner.runBackup).toHaveBeenCalledTimes(1);
    });
  });

  it('skips a tick while a previous tick is still in flight', async () => {
    latestRun = null;
    let release: () => void = () => undefined;
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    runner.runBackup.mockImplementation(() => {
      signalEntered();
      return new Promise<void>((resolve) => { release = () => resolve(); });
    });

    const first = task.handleTick();
    await entered; // the first tick is now parked inside runBackup
    await task.handleTick(); // second tick lands mid-run

    expect(runner.runBackup).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  // ---------------------------------------------------------------------------
  // Timezone
  // ---------------------------------------------------------------------------

  describe('timezone handling', () => {
    it('passes the configured timezone to nextCronDate as its third argument', async () => {
      build({ timezone: 'America/Costa_Rica' });
      latestRun = null;

      await task.handleTick();

      expect(nextCronDateMock).toHaveBeenCalled();
      for (const call of nextCronDateMock.mock.calls) {
        expect(call[2]).toBe('America/Costa_Rica');
      }
    });

    it('fires at the correct local wall-clock time in a non-UTC zone', async () => {
      // 08:05Z is 02:05 in America/Costa_Rica (UTC-6), so the 02:00 local
      // boundary (08:00Z) has just passed and the 07:00Z run predates it.
      jest.setSystemTime(new Date('2026-03-10T08:05:00.000Z'));
      build({ timezone: 'America/Costa_Rica' });
      latestRun = { id: 'earlier', startedAt: new Date('2026-03-10T07:00:00.000Z') };

      await task.handleTick();

      expect(runner.runBackup).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire at the same instant when the zone is UTC — the zone genuinely changes the boundary', async () => {
      jest.setSystemTime(new Date('2026-03-10T08:05:00.000Z'));
      build({ timezone: 'UTC' });
      // In UTC the boundary was 02:00Z, and the 07:00Z run is after it.
      latestRun = { id: 'earlier', startedAt: new Date('2026-03-10T07:00:00.000Z') };

      await task.handleTick();

      expect(runner.runBackup).not.toHaveBeenCalled();
    });

    it('stands down rather than firing in the wrong zone when the IANA name is unknown', async () => {
      build({ timezone: 'Mars/Olympus_Mons' });
      latestRun = null;

      await expect(task.handleTick()).resolves.toBeUndefined();

      expect(runner.runBackup).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Staleness sweep
  // ---------------------------------------------------------------------------

  describe('staleness release', () => {
    it('marks a run with a stale heartbeat as terminal `stale` and deletes its partial object', async () => {
      // runStaleMinutes=30, now=02:05Z → cutoff 01:35Z.
      staleCandidates = [
        runRow({ id: 'dead', lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z') }),
      ];
      latestRun = { id: 'dead', startedAt: new Date('2026-03-10T02:00:30.000Z') };

      await task.handleTick();

      expect(prisma.databaseBackupRun.updateMany).toHaveBeenCalledTimes(1);
      const [[args]] = prisma.databaseBackupRun.updateMany.mock.calls;
      expect(args.where).toEqual({ id: 'dead', status: 'running' });
      expect(args.data.status).toBe('stale');
      expect(args.data.finishedAt).toBeInstanceOf(Date);
      expect(typeof args.data.lastError).toBe('string');

      expect(providerResolver.getProviderFor).toHaveBeenCalledWith('s3', 'memoria');
      expect(provider.delete).toHaveBeenCalledWith('db-backups/run-1.dump');
    });

    it('never requeues a stale run — it is terminal, the next boundary is the retry', async () => {
      staleCandidates = [
        runRow({ id: 'dead', lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z') }),
      ];
      latestRun = { id: 'dead', startedAt: new Date('2026-03-10T02:00:30.000Z') };

      await task.handleTick();

      const [[args]] = prisma.databaseBackupRun.updateMany.mock.calls;
      expect(args.data.status).toBe('stale');
      expect(['pending', 'running']).not.toContain(args.data.status);
      // And nothing was restarted on this tick's behalf.
      expect(runner.runBackup).not.toHaveBeenCalled();
    });

    it('leaves a run with a fresh heartbeat untouched', async () => {
      staleCandidates = [
        runRow({ id: 'alive', lastHeartbeatAt: new Date('2026-03-10T02:04:30.000Z') }),
      ];
      latestRun = { id: 'alive', startedAt: new Date('2026-03-10T02:00:30.000Z') };

      await task.handleTick();

      expect(prisma.databaseBackupRun.updateMany).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('honours a custom runStaleMinutes', async () => {
      build({ runStaleMinutes: 120 });
      // Same 01:00Z heartbeat is only 65 minutes old — still alive at 120.
      staleCandidates = [
        runRow({ id: 'slow', lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z') }),
      ];
      latestRun = { id: 'slow', startedAt: new Date('2026-03-10T02:00:30.000Z') };

      await task.handleTick();

      expect(prisma.databaseBackupRun.updateMany).not.toHaveBeenCalled();
    });

    it('ages a zombie row with no heartbeat at all by startedAt', async () => {
      staleCandidates = [
        runRow({
          id: 'zombie',
          lastHeartbeatAt: null,
          startedAt: new Date('2026-03-10T00:30:00.000Z'),
        }),
      ];
      latestRun = { id: 'zombie', startedAt: new Date('2026-03-10T02:00:30.000Z') };

      await task.handleTick();

      expect(prisma.databaseBackupRun.updateMany).toHaveBeenCalledTimes(1);
    });

    it('does not delete the object when the row was no longer `running`', async () => {
      staleCandidates = [
        runRow({ id: 'raced', lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z') }),
      ];
      latestRun = { id: 'raced', startedAt: new Date('2026-03-10T02:00:30.000Z') };
      prisma.databaseBackupRun.updateMany.mockResolvedValue({ count: 0 });

      await task.handleTick();

      expect(provider.delete).not.toHaveBeenCalled();
    });

    it('a failed object delete does not abort the tick', async () => {
      staleCandidates = [
        runRow({ id: 'dead', lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z') }),
      ];
      latestRun = null;
      provider.delete.mockRejectedValue(new Error('S3 exploded'));

      await expect(task.handleTick()).resolves.toBeUndefined();

      // The row was still released, and the schedule still fired.
      expect(prisma.databaseBackupRun.updateMany).toHaveBeenCalledTimes(1);
      expect(runner.runBackup).toHaveBeenCalledTimes(1);
    });

    it('skips object deletion for a run that never named a storage key', async () => {
      staleCandidates = [
        runRow({
          id: 'nokey',
          lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z'),
          storageProvider: null,
          storageKey: null,
        }),
      ];
      latestRun = { id: 'nokey', startedAt: new Date('2026-03-10T02:00:30.000Z') };

      await task.handleTick();

      expect(prisma.databaseBackupRun.updateMany).toHaveBeenCalledTimes(1);
      expect(providerResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('releases the stale run BEFORE attempting to fire, so the guard is free', async () => {
      staleCandidates = [
        runRow({ id: 'dead', lastHeartbeatAt: new Date('2026-03-10T01:00:00.000Z') }),
      ];
      latestRun = null;

      const order: string[] = [];
      prisma.databaseBackupRun.updateMany.mockImplementation(async () => {
        order.push('release');
        return { count: 1 };
      });
      runner.runBackup.mockImplementation(async () => {
        order.push('fire');
        return { runId: 'new-run' };
      });

      await task.handleTick();

      expect(order).toEqual(['release', 'fire']);
    });
  });
});

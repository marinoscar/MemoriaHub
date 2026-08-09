/**
 * test/backup/backup-scheduler.spec.ts — Pull-based schedule poller (issue #318).
 *
 * Covers: overdue nextRunAt at startup fires immediately (offline-at-schedule
 * self-heal); not-due / disabled / unconfigured do nothing; a due schedule is
 * skipped while a run is active; fired runs carry trigger='scheduled'; poll
 * failures log + keep polling and back off to 5 min after 5 consecutive
 * failures, resetting on success; the recurring 60s cadence (fake timers).
 */

import { jest } from '@jest/globals';
import type { NodeBackupConfigResult } from '../../src/api.js';
import type { NodeLogger } from '../../src/node/logger.js';
import {
  BackupScheduler,
  SCHEDULER_BACKOFF_INTERVAL_MS,
  SCHEDULER_FAILURE_THRESHOLD,
  SCHEDULER_POLL_INTERVAL_MS,
  type BackupSchedulerDeps,
} from '../../src/backup/backup-scheduler.js';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function stubLogger(): NodeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logPath: '(stub)',
    log: (level, fields) => lines.push(JSON.stringify({ level, ...fields })),
    info: (msg, payload) => lines.push(`info: ${msg} ${JSON.stringify(payload ?? {})}`),
    warn: (msg, payload) => lines.push(`warn: ${msg} ${JSON.stringify(payload ?? {})}`),
    error: (msg, payload) => lines.push(`error: ${msg} ${JSON.stringify(payload ?? {})}`),
    tail: (n) => lines.slice(-n),
  };
}

function config(over: Partial<{ enabled: boolean; nextRunAt: string | null }> = {}): NodeBackupConfigResult {
  return {
    config: {
      nodeId: 'node-1',
      enabled: over.enabled ?? true,
      scheduleCron: '0 3 * * *',
      timezone: 'UTC',
      nextRunAt: over.nextRunAt === undefined ? new Date(NOW - 60_000).toISOString() : over.nextRunAt,
      circleIds: [],
    },
  };
}

interface Harness {
  scheduler: BackupScheduler;
  startRun: jest.Mock<(trigger: 'scheduled') => void>;
  logger: ReturnType<typeof stubLogger>;
  getConfig: jest.Mock<(nodeId: string) => Promise<NodeBackupConfigResult>>;
}

function makeScheduler(
  results: () => Promise<NodeBackupConfigResult>,
  depsOver: Partial<BackupSchedulerDeps> = {},
): Harness {
  const startRun = jest.fn<(trigger: 'scheduled') => void>();
  const logger = stubLogger();
  const getConfig = jest.fn<(nodeId: string) => Promise<NodeBackupConfigResult>>(() => results());
  const scheduler = new BackupScheduler(
    { nodeId: 'node-1' },
    {
      api: { getNodeBackupConfig: getConfig },
      logger,
      isRunActive: () => false,
      startRun,
      now: () => NOW,
      ...depsOver,
    },
  );
  return { scheduler, startRun, logger, getConfig };
}

describe('BackupScheduler', () => {
  it('fires immediately at startup when nextRunAt is overdue (offline self-heal)', async () => {
    const h = makeScheduler(async () => config());
    h.scheduler.start();
    // start() runs an immediate tick; flush its microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    h.scheduler.stop();

    expect(h.getConfig).toHaveBeenCalledWith('node-1');
    expect(h.startRun).toHaveBeenCalledTimes(1);
    expect(h.startRun).toHaveBeenCalledWith('scheduled');
  });

  it('does nothing when nextRunAt is in the future', async () => {
    const h = makeScheduler(async () =>
      config({ nextRunAt: new Date(NOW + 3_600_000).toISOString() }),
    );
    await h.scheduler.tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('does nothing when the schedule is cleared (nextRunAt null)', async () => {
    const h = makeScheduler(async () => config({ nextRunAt: null }));
    await h.scheduler.tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('enabled:false is a kill switch — an overdue schedule never fires', async () => {
    const h = makeScheduler(async () => config({ enabled: false }));
    await h.scheduler.tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('does nothing when backup has never been configured (config null)', async () => {
    const h = makeScheduler(async () => ({ config: null }));
    await h.scheduler.tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('skips a due schedule while a local run is active', async () => {
    const h = makeScheduler(async () => config(), { isRunActive: () => true });
    await h.scheduler.tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('logs and keeps polling on failure; backs off to 5 min after 5 consecutive failures; resets on success', async () => {
    let fail = true;
    const h = makeScheduler(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return config({ nextRunAt: null });
    });

    expect(h.scheduler.nextDelayMs()).toBe(SCHEDULER_POLL_INTERVAL_MS);

    for (let i = 1; i <= SCHEDULER_FAILURE_THRESHOLD; i += 1) {
      await h.scheduler.tick();
      expect(h.scheduler.failures).toBe(i);
      expect(h.scheduler.nextDelayMs()).toBe(
        i >= SCHEDULER_FAILURE_THRESHOLD ? SCHEDULER_BACKOFF_INTERVAL_MS : SCHEDULER_POLL_INTERVAL_MS,
      );
    }
    expect(h.logger.lines.some((l) => l.includes('backup schedule poll failed'))).toBe(true);
    expect(h.logger.lines.some((l) => l.includes('ECONNREFUSED'))).toBe(true);

    // A successful poll resets the cadence.
    fail = false;
    await h.scheduler.tick();
    expect(h.scheduler.failures).toBe(0);
    expect(h.scheduler.nextDelayMs()).toBe(SCHEDULER_POLL_INTERVAL_MS);
  });

  it('a startRun that throws (busy race) is logged, never thrown out', async () => {
    const h = makeScheduler(async () => config());
    h.startRun.mockImplementation(() => {
      throw new Error('a backup run is already active on this daemon');
    });
    await expect(h.scheduler.tick()).resolves.toBeUndefined();
    expect(h.logger.lines.some((l) => l.includes('scheduled backup run failed to start'))).toBe(true);
  });

  it('polls on the 60s cadence after the immediate startup check (fake timers)', async () => {
    jest.useFakeTimers();
    try {
      const h = makeScheduler(async () => config({ nextRunAt: null }));
      h.scheduler.start();
      await jest.advanceTimersByTimeAsync(0); // immediate tick
      expect(h.getConfig).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS);
      expect(h.getConfig).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS);
      expect(h.getConfig).toHaveBeenCalledTimes(3);

      // stop() disarms the chain.
      h.scheduler.stop();
      await jest.advanceTimersByTimeAsync(SCHEDULER_POLL_INTERVAL_MS * 3);
      expect(h.getConfig).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

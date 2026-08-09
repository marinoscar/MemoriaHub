import { Logger } from '@nestjs/common';

import { DatabaseBackupRetentionService } from './database-backup-retention.service';

interface StoredRun {
  id: string;
  status: string;
  trigger: string;
  startedAt: Date;
  storageProvider: string | null;
  storageKey: string | null;
  bucket: string | null;
}

function run(
  id: string,
  startedAt: string,
  over: Partial<StoredRun> = {},
): StoredRun {
  return {
    id,
    status: 'completed',
    trigger: 'scheduled',
    startedAt: new Date(startedAt),
    storageProvider: 's3',
    storageKey: `db-backups/${id}.dump`,
    bucket: 'memoria',
    ...over,
  };
}

const DEFAULT_SETTINGS = { retentionCount: 2, oldDatabaseRetentionHours: 168 };

describe('DatabaseBackupRetentionService (issue #342)', () => {
  let rows: StoredRun[];
  let prisma: any;
  let systemSettings: any;
  let providerResolver: any;
  let provider: any;
  let service: DatabaseBackupRetentionService;
  /** Interleaved audit trail of every object delete and every row delete. */
  let order: string[];

  function build(settingsOverride: Record<string, unknown> = {}) {
    order = [];

    prisma = {
      databaseBackupRun: {
        findMany: jest.fn(async ({ where, orderBy }: any) => {
          let out = rows.filter((r) => r.status === where.status);
          if (where.trigger?.not) out = out.filter((r) => r.trigger !== where.trigger.not);
          else if (typeof where.trigger === 'string') {
            out = out.filter((r) => r.trigger === where.trigger);
          }
          if (where.startedAt?.lt) {
            out = out.filter((r) => r.startedAt.getTime() < where.startedAt.lt.getTime());
          }
          const dir = orderBy?.startedAt === 'asc' ? 1 : -1;
          return [...out]
            .sort((a, b) => dir * (a.startedAt.getTime() - b.startedAt.getTime()))
            .map((r) => ({
              id: r.id,
              storageProvider: r.storageProvider,
              storageKey: r.storageKey,
              bucket: r.bucket,
            }));
        }),
        delete: jest.fn(async ({ where }: any) => {
          order.push(`row:${where.id}`);
          rows = rows.filter((r) => r.id !== where.id);
          return {};
        }),
      },
    };

    systemSettings = {
      getSettings: jest.fn(async () => ({
        databaseBackup: { ...DEFAULT_SETTINGS, ...settingsOverride },
      })),
    };

    provider = {
      delete: jest.fn(async (key: string) => {
        order.push(`object:${key}`);
      }),
    };
    providerResolver = { getProviderFor: jest.fn(async () => provider) };

    service = new DatabaseBackupRetentionService(prisma, systemSettings, providerResolver);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-10T03:00:00.000Z'));
    rows = [];
    build();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Count-based pruning
  // ---------------------------------------------------------------------------

  describe('count-based pruning', () => {
    it('keeps the newest retentionCount runs and prunes the rest', async () => {
      rows = [
        run('oldest', '2026-03-07T02:00:00.000Z'),
        run('older', '2026-03-08T02:00:00.000Z'),
        run('newer', '2026-03-09T02:00:00.000Z'),
        run('newest', '2026-03-10T02:00:00.000Z'),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByCount).toBe(2);
      expect(rows.map((r) => r.id).sort()).toEqual(['newer', 'newest']);
    });

    it('prunes oldest-first', async () => {
      rows = [
        run('a', '2026-03-06T02:00:00.000Z'),
        run('b', '2026-03-07T02:00:00.000Z'),
        run('c', '2026-03-08T02:00:00.000Z'),
        run('d', '2026-03-09T02:00:00.000Z'),
        run('e', '2026-03-10T02:00:00.000Z'),
      ];

      await service.pruneAfterSuccessfulRun();

      const rowDeletes = order.filter((o) => o.startsWith('row:'));
      expect(rowDeletes).toEqual(['row:a', 'row:b', 'row:c']);
    });

    it('deletes the storage object BEFORE the DB row', async () => {
      rows = [
        run('victim', '2026-03-01T02:00:00.000Z'),
        run('keep1', '2026-03-09T02:00:00.000Z'),
        run('keep2', '2026-03-10T02:00:00.000Z'),
      ];

      await service.pruneAfterSuccessfulRun();

      expect(order).toEqual(['object:db-backups/victim.dump', 'row:victim']);
      expect(providerResolver.getProviderFor).toHaveBeenCalledWith('s3', 'memoria');
    });

    it('keeps the row (visible, fixable) when its object cannot be deleted', async () => {
      rows = [
        run('victim', '2026-03-01T02:00:00.000Z'),
        run('keep1', '2026-03-09T02:00:00.000Z'),
        run('keep2', '2026-03-10T02:00:00.000Z'),
      ];
      provider.delete.mockRejectedValue(new Error('S3 denied'));

      const result = await service.pruneAfterSuccessfulRun();

      expect(prisma.databaseBackupRun.delete).not.toHaveBeenCalled();
      expect(result.prunedByCount).toBe(0);
      expect(result.errors).toBeGreaterThan(0);
      expect(rows.map((r) => r.id)).toContain('victim');
    });

    it('prunes a row that never named a storage key without touching storage', async () => {
      rows = [
        run('nokey', '2026-03-01T02:00:00.000Z', { storageProvider: null, storageKey: null }),
        run('keep1', '2026-03-09T02:00:00.000Z'),
        run('keep2', '2026-03-10T02:00:00.000Z'),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByCount).toBe(1);
      expect(providerResolver.getProviderFor).not.toHaveBeenCalled();
    });

    it('does nothing when the number of completed runs is within retention', async () => {
      rows = [run('a', '2026-03-09T02:00:00.000Z'), run('b', '2026-03-10T02:00:00.000Z')];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByCount).toBe(0);
      expect(prisma.databaseBackupRun.delete).not.toHaveBeenCalled();
    });

    it('never prunes a non-completed run by count', async () => {
      rows = [
        run('failed-old', '2026-03-01T02:00:00.000Z', { status: 'failed' }),
        run('stale-old', '2026-03-02T02:00:00.000Z', { status: 'stale' }),
        run('a', '2026-03-09T02:00:00.000Z'),
        run('b', '2026-03-10T02:00:00.000Z'),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByCount).toBe(0);
      expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'failed-old', 'stale-old']);
    });

    it('counts manual runs alongside scheduled ones', async () => {
      rows = [
        run('sched-old', '2026-03-01T02:00:00.000Z'),
        run('manual', '2026-03-09T02:00:00.000Z', { trigger: 'manual' }),
        run('sched-new', '2026-03-10T02:00:00.000Z'),
      ];

      await service.pruneAfterSuccessfulRun();

      expect(rows.map((r) => r.id).sort()).toEqual(['manual', 'sched-new']);
    });
  });

  // ---------------------------------------------------------------------------
  // pre_restore exemption — the load-bearing rule
  // ---------------------------------------------------------------------------

  describe('pre_restore exemption', () => {
    it('NEVER prunes a pre_restore run by count, however many backups came after it', async () => {
      rows = [
        run('rollback', '2026-03-10T01:00:00.000Z', { trigger: 'pre_restore' }),
        run('n1', '2026-03-10T01:10:00.000Z'),
        run('n2', '2026-03-10T01:20:00.000Z'),
        run('n3', '2026-03-10T01:30:00.000Z'),
        run('n4', '2026-03-10T01:40:00.000Z'),
        run('n5', '2026-03-10T01:50:00.000Z'),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      // retentionCount=2 → n1..n3 pruned, n4/n5 kept, rollback untouched.
      expect(rows.map((r) => r.id).sort()).toEqual(['n4', 'n5', 'rollback']);
      expect(result.prunedByAge).toBe(0);
    });

    it('does not let a pre_restore run consume a retention slot', async () => {
      rows = [
        run('rollback', '2026-03-10T01:00:00.000Z', { trigger: 'pre_restore' }),
        run('a', '2026-03-10T01:10:00.000Z'),
        run('b', '2026-03-10T01:20:00.000Z'),
      ];

      await service.pruneAfterSuccessfulRun();

      // Both routine backups survive: the exempt row was never counted.
      expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'rollback']);
    });

    it('prunes a pre_restore run once it exceeds oldDatabaseRetentionHours', async () => {
      // Now = 2026-03-10T03:00Z, retention 168h → cutoff 2026-03-03T03:00Z.
      rows = [
        run('expired', '2026-03-01T02:00:00.000Z', { trigger: 'pre_restore' }),
        run('fresh', '2026-03-09T02:00:00.000Z', { trigger: 'pre_restore' }),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByAge).toBe(1);
      expect(rows.map((r) => r.id)).toEqual(['fresh']);
      expect(order).toEqual(['object:db-backups/expired.dump', 'row:expired']);
    });

    it('honours a custom oldDatabaseRetentionHours', async () => {
      build({ oldDatabaseRetentionHours: 1 });
      rows = [
        run('just-old', '2026-03-10T01:00:00.000Z', { trigger: 'pre_restore' }),
        run('very-fresh', '2026-03-10T02:45:00.000Z', { trigger: 'pre_restore' }),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByAge).toBe(1);
      expect(rows.map((r) => r.id)).toEqual(['very-fresh']);
    });

    it('does not age-prune a non-completed pre_restore run', async () => {
      rows = [
        run('failed-rollback', '2026-03-01T02:00:00.000Z', {
          trigger: 'pre_restore',
          status: 'failed',
        }),
      ];

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.prunedByAge).toBe(0);
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Robustness — pruning must never fail a successful backup
  // ---------------------------------------------------------------------------

  describe('robustness', () => {
    it('never throws when settings cannot be read', async () => {
      systemSettings.getSettings.mockRejectedValue(new Error('db down'));

      await expect(service.pruneAfterSuccessfulRun()).resolves.toEqual({
        prunedByCount: 0,
        prunedByAge: 0,
        errors: 0,
      });
    });

    it('never throws when a query fails', async () => {
      prisma.databaseBackupRun.findMany.mockRejectedValue(new Error('boom'));

      const result = await service.pruneAfterSuccessfulRun();

      expect(result.errors).toBe(2);
    });

    it('falls back to the schema defaults on garbage settings', async () => {
      build({ retentionCount: 'seven' as unknown as number });
      rows = Array.from({ length: 9 }, (_, i) =>
        run(`r${i}`, `2026-03-0${i + 1}T02:00:00.000Z`),
      );

      const result = await service.pruneAfterSuccessfulRun();

      // Default retentionCount is 7 → 2 pruned out of 9.
      expect(result.prunedByCount).toBe(2);
    });
  });
});

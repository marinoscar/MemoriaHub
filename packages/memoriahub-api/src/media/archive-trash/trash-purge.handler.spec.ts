/**
 * Unit tests for TrashPurgeHandler (moved to the media slice by RETRO-J5, #613). Host-free: the
 * ports are doubles. process() reads retentionDays from the `storage` settings namespace, computes
 * the cutoff, finds expired items and hands their ids to the purger (the batched hard delete shared
 * with the trash-empty run). The job type, label and profile are permanent.
 */
import { TrashPurgeHandler } from './trash-purge.handler.js';

describe('TrashPurgeHandler', () => {
  let handler: TrashPurgeHandler;
  let jobs: { registerHandler: jest.Mock };
  let settings: { readSystem: jest.Mock };
  let purger: { purgeMediaItemsBatched: jest.Mock };
  let prisma: { mediaItem: { findMany: jest.Mock } };

  beforeEach(() => {
    jobs = { registerHandler: jest.fn() };
    settings = { readSystem: jest.fn().mockResolvedValue({ value: { trash: { retentionDays: 30 } }, version: 1 }) };
    purger = { purgeMediaItemsBatched: jest.fn().mockResolvedValue({ deleted: 0, failedIds: [] }) };
    prisma = { mediaItem: { findMany: jest.fn().mockResolvedValue([]) } };
    handler = new TrashPurgeHandler(jobs as never, prisma as never, settings as never, purger as never);
  });

  describe('identity', () => {
    it('has the permanent type, a label and the execution profile', () => {
      expect(handler.type).toBe('trash_purge');
      expect(handler.label).toBe('Trash purge');
      expect(handler.profile).toEqual({ maxRuntimeMs: 1_800_000, maxAttempts: 2 });
    });

    it('is server-only: no node-result pair', () => {
      expect((handler as { nodeResultSchema?: unknown }).nodeResultSchema).toBeUndefined();
      expect((handler as { persistNodeResult?: unknown }).persistNodeResult).toBeUndefined();
    });

    it('registers itself through the jobs port on init, once per call', () => {
      handler.onModuleInit();
      expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
      expect(jobs.registerHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('process', () => {
    it('reads retentionDays from the storage settings namespace', async () => {
      await handler.process();
      expect(settings.readSystem).toHaveBeenCalledWith('storage');
    });

    it('uses a default of 30 days when the setting is absent', async () => {
      settings.readSystem.mockResolvedValue({ value: undefined, version: 1 });

      const before = Date.now();
      await handler.process();

      const cutoff: Date = prisma.mediaItem.findMany.mock.calls[0][0].where.deletedAt.lt;
      expect(cutoff.getTime()).toBeLessThan(before - 30 * 86_400_000 + 5000);
      expect(cutoff.getTime()).toBeGreaterThan(before - 30 * 86_400_000 - 5000);
    });

    it('queries trashed items (deletedAt not null) older than the cutoff, custom retention honoured', async () => {
      settings.readSystem.mockResolvedValue({ value: { trash: { retentionDays: 7 } }, version: 1 });

      const before = Date.now();
      await handler.process();
      const after = Date.now();

      const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
      expect(where.deletedAt.not).toBeNull();
      expect(where.deletedAt.lt.getTime()).toBeGreaterThan(before - 7 * 86_400_000 - 5000);
      expect(where.deletedAt.lt.getTime()).toBeLessThan(after - 7 * 86_400_000 + 5000);
    });

    it('does not purge when no expired items are found', async () => {
      await handler.process();
      expect(purger.purgeMediaItemsBatched).not.toHaveBeenCalled();
    });

    it('hands the ids of the expired items to the purger', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([{ id: 'item-old-1' }, { id: 'item-old-2' }]);
      purger.purgeMediaItemsBatched.mockResolvedValue({ deleted: 2, failedIds: [] });

      await handler.process();

      expect(purger.purgeMediaItemsBatched).toHaveBeenCalledWith(['item-old-1', 'item-old-2']);
    });

    it('propagates a purge failure (the queue records lastError and retries)', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([{ id: 'item-1' }]);
      purger.purgeMediaItemsBatched.mockRejectedValue(new Error('storage unavailable'));

      await expect(handler.process()).rejects.toThrow('storage unavailable');
    });

    it('propagates a read failure', async () => {
      prisma.mediaItem.findMany.mockRejectedValue(new Error('DB connection lost'));

      await expect(handler.process()).rejects.toThrow('DB connection lost');
    });
  });
});

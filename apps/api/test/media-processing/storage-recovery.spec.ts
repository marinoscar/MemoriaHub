// =============================================================================
// Storage processing recovery as queue jobs (RETRO-D1b, #567)
// =============================================================================
//
// Pins, over a small in-memory world:
//
//   * the cron only enqueues (`enqueueHousekeepingJob`), and passes the platform
//     `cron-enqueue-only` scan over `src/media-processing/` with no exemption;
//   * `media.storage.recover_stuck` (mode stuck): an orphaned object is
//     re-queued as a platform `storage.object.process` job in its organization,
//     its retry counter is persisted BEFORE the enqueue, an object with a live
//     processing job is left alone, an exhausted object is marked `failed`;
//   * mode `failed`: image objects are reset to `processing`, bookkeeping cleared;
//   * `media.storage.reprocess`: ready/failed media objects are queued at
//     background priority, statuses untouched;
//   * both handlers are server-only and satisfy the platform handler contract.
// =============================================================================

import { join } from 'node:path';
import { cronEnqueueOnlySuite } from '@marinoscar/platform-api/testing';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { findJobHandlerContractViolations } from '@marinoscar/platform-api/jobs/testing';

import { StorageRecoveryHandler } from '../../src/media-processing/recovery/storage-recovery.handler';
import { StorageRecoveryService } from '../../src/media-processing/recovery/storage-recovery.service';
import { StorageRecoveryTask } from '../../src/media-processing/recovery/storage-recovery.task';
import { StorageReprocessHandler } from '../../src/media-processing/recovery/storage-reprocess.handler';
import {
  STORAGE_RECOVER_STUCK_TYPE,
  STORAGE_REPROCESS_TYPE,
  parseRecoverPayload,
} from '../../src/media-processing/recovery/storage-recovery.constants';
import { STORAGE_PROCESSING_RECOVERY_REASON } from '../../src/app-registrations/system-access-reasons';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OLD = new Date(Date.now() - 60 * 60_000);

interface Obj {
  id: string;
  orgId: string;
  status: string;
  mimeType: string;
  storageKey: string;
  updatedAt: Date;
  metadata: Record<string, unknown> | null;
}

/** An in-memory `storage_objects` / `jobs` / `media_items` world with an event log. */
function world(objects: Obj[], opts: { liveJobFor?: string[]; mediaItems?: { id: string; circleId: string; storageObjectId: string }[] } = {}) {
  const rows = new Map(objects.map((o) => [o.id, { ...o }]));
  const log: string[] = [];
  const reasons: string[] = [];

  const matches = (o: Obj, where: Record<string, any>): boolean => {
    if (where.status !== undefined) {
      if (typeof where.status === 'string' ? o.status !== where.status : !where.status.in.includes(o.status)) return false;
    }
    if (where.updatedAt?.lt && !(o.updatedAt < where.updatedAt.lt)) return false;
    if (where.id?.gt && !(o.id > where.id.gt)) return false;
    if (where.id?.in && !where.id.in.includes(o.id)) return false;
    if (where.mimeType?.startsWith && !o.mimeType.startsWith(where.mimeType.startsWith)) return false;
    if (where.OR && !where.OR.some((w: any) => o.mimeType.startsWith(w.mimeType.startsWith))) return false;
    if (where.NOT?.storageKey?.startsWith && o.storageKey.startsWith(where.NOT.storageKey.startsWith)) return false;
    return true;
  };

  const storageObject = {
    findMany: jest.fn(async ({ where, take }: any) => {
      const found = [...rows.values()].filter((o) => matches(o, where)).sort((a, b) => a.id.localeCompare(b.id));
      return (take ? found.slice(0, take) : found).map((o) => ({ ...o }));
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.get(where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      log.push(`update:${where.id}:${JSON.stringify(data)}`);
      return { ...row };
    }),
  };
  const system = {
    asSystem: jest.fn((reason: string) => {
      reasons.push(reason);
      return { storageObject };
    }),
  };
  const items = opts.mediaItems ?? [];
  const prisma = {
    job: {
      findMany: jest.fn(async ({ where }: any) =>
        (opts.liveJobFor ?? []).filter((id) => where.subjectId.in.includes(id)).map((subjectId) => ({ subjectId })),
      ),
    },
    mediaItem: {
      findMany: jest.fn(async ({ where, take }: any) =>
        items
          .filter((i) => (!where.circleId || i.circleId === where.circleId) && (!where.id?.gt || i.id > where.id.gt))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take),
      ),
    },
  };
  const enqueued: any[] = [];
  const jobs = {
    enqueue: jest.fn(async (input: any) => {
      enqueued.push(input);
      log.push(`enqueue:${input.subjectId}`);
      return { id: `job-${enqueued.length}`, status: 'pending', priority: input.priority ?? 0 };
    }),
  };
  const service = new StorageRecoveryService(prisma as never, system as never, jobs as never);
  return { rows, log, reasons, enqueued, service, jobs, prisma };
}

function obj(id: string, over: Partial<Obj> = {}): Obj {
  return {
    id,
    orgId: ORG,
    status: 'processing',
    mimeType: 'image/jpeg',
    storageKey: `uploads/${id}.jpg`,
    updatedAt: OLD,
    metadata: {},
    ...over,
  };
}

const ENV_KEYS = ['STORAGE_PROCESSING_STUCK_MINUTES', 'STORAGE_PROCESSING_MAX_RETRIES', 'STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => ENV_KEYS.forEach((k) => ((savedEnv[k] = process.env[k]), delete process.env[k])));
afterEach(() => ENV_KEYS.forEach((k) => (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]))));

describe('StorageRecoveryTask (the cron only enqueues)', () => {
  it('queues one housekeeping job of the recovery type and does nothing else', async () => {
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1', status: 'pending' })) };
    const prisma = { job: { findFirst: jest.fn(async () => null) } };
    await new StorageRecoveryTask(jobs as never, prisma as never).enqueueRecovery();
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: STORAGE_RECOVER_STUCK_TYPE, orgId: null }));
  });

  it('skips the tick when a recovery job is already in flight', async () => {
    const jobs = { enqueue: jest.fn() };
    const prisma = { job: { findFirst: jest.fn(async () => ({ id: 'job-live', status: 'running' })) } };
    await new StorageRecoveryTask(jobs as never, prisma as never).enqueueRecovery();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('is off when STORAGE_PROCESSING_STUCK_RESET_ENABLED=false', async () => {
    process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = 'false';
    const jobs = { enqueue: jest.fn() };
    const prisma = { job: { findFirst: jest.fn(async () => null) } };
    await new StorageRecoveryTask(jobs as never, prisma as never).enqueueRecovery();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(prisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('passes the platform cron-enqueue-only scan over src/media-processing with no exemption', () => {
    const root = join(__dirname, '..', '..', 'src', 'media-processing');
    const report = cronEnqueueOnlySuite.check({ sourceRoots: [root] } as never, { exempt: [], minCronFiles: 1 });
    expect(report.scannedFiles['cronFiles']).toEqual(['recovery/storage-recovery.task.ts']);
    expect(report.findings).toEqual([]);
  });
});

describe('media.storage.recover_stuck, mode stuck', () => {
  it('re-queues an orphaned object as a storage.object.process job in its organization', async () => {
    const w = world([obj('a')]);
    const result = await w.service.recoverStuckObjects();

    expect(result).toEqual({ claimed: 1, reprocessed: 1, exhausted: 0, errors: 0 });
    expect(w.enqueued).toEqual([
      {
        type: 'storage.object.process',
        reason: 'rerun',
        subjectType: 'storage_object',
        subjectId: 'a',
        payload: { objectId: 'a', orgId: ORG },
        orgId: ORG,
        priority: 0,
      },
    ]);
    expect(w.reasons.every((r) => r === STORAGE_PROCESSING_RECOVERY_REASON)).toBe(true);
  });

  it('persists the incremented retry counter BEFORE queueing the job (crash-safe cap)', async () => {
    const w = world([obj('a', { metadata: { _processingRetryCount: 1, keep: true } })]);
    await w.service.recoverStuckObjects();

    expect(w.log[0]).toBe('update:a:{"metadata":{"_processingRetryCount":2,"keep":true}}');
    expect(w.log[1]).toBe('enqueue:a');
    expect(w.rows.get('a')!.status).toBe('processing');
  });

  it('marks an exhausted object failed instead of re-queuing it', async () => {
    process.env['STORAGE_PROCESSING_MAX_RETRIES'] = '3';
    const w = world([obj('a', { metadata: { _processingRetryCount: 3 } })]);
    const result = await w.service.recoverStuckObjects();

    expect(result).toEqual({ claimed: 1, reprocessed: 0, exhausted: 1, errors: 0 });
    expect(w.enqueued).toEqual([]);
    expect(w.rows.get('a')).toMatchObject({
      status: 'failed',
      metadata: { _processingRetryCount: 3, _processingRetryExhausted: true },
    });
  });

  it('is exhausted after STORAGE_PROCESSING_MAX_RETRIES runs', async () => {
    process.env['STORAGE_PROCESSING_MAX_RETRIES'] = '2';
    const w = world([obj('a')]);
    for (let run = 0; run < 3; run++) {
      w.rows.get('a')!.updatedAt = OLD; // the queued job died; the row aged past the threshold again
      await w.service.recoverStuckObjects();
    }
    expect(w.enqueued).toHaveLength(2);
    expect(w.rows.get('a')!.status).toBe('failed');
  });

  it('leaves alone an object whose processing job is still pending or running', async () => {
    const w = world([obj('a'), obj('b')], { liveJobFor: ['a'] });
    const result = await w.service.recoverStuckObjects();

    expect(result.claimed).toBe(1);
    expect(w.enqueued.map((e) => e.subjectId)).toEqual(['b']);
  });

  it('ignores objects younger than the threshold and objects not at processing', async () => {
    const w = world([obj('a', { updatedAt: new Date() }), obj('b', { status: 'ready' })]);
    expect(await w.service.recoverStuckObjects()).toEqual({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 });
    expect(w.enqueued).toEqual([]);
  });

  it('honours an explicit olderThanMinutes', async () => {
    const w = world([obj('a', { updatedAt: new Date(Date.now() - 5 * 60_000) })]);
    expect((await w.service.recoverStuckObjects(1)).reprocessed).toBe(1);
  });

  it('walks every keyset page', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `obj-${String(i).padStart(4, '0')}`);
    const w = world(ids.map((id) => obj(id)));
    const result = await w.service.recoverStuckObjects();
    expect(result.reprocessed).toBe(205);
    expect(new Set(w.enqueued.map((e) => e.subjectId)).size).toBe(205);
  });

  it('counts a per-object failure and carries on', async () => {
    const w = world([obj('a'), obj('b')]);
    w.jobs.enqueue.mockRejectedValueOnce(new Error('db down'));
    const result = await w.service.recoverStuckObjects();
    expect(result).toEqual({ claimed: 2, reprocessed: 1, exhausted: 0, errors: 1 });
  });
});

describe('media.storage.recover_stuck, mode failed', () => {
  it('resets failed image objects to processing, clears bookkeeping and re-queues them', async () => {
    const w = world([
      obj('a', { status: 'failed', metadata: { _processingRetryCount: 3, _processingRetryExhausted: true, x: 1 } }),
      obj('b', { status: 'failed', mimeType: 'video/mp4' }),
      obj('c', { status: 'failed', storageKey: 'thumbnails/c-abc.jpg' }),
    ]);
    const result = await w.service.recoverFailedImageObjects();

    expect(result).toEqual({ claimed: 1, reprocessed: 1, exhausted: 0, errors: 0 });
    expect(w.rows.get('a')).toMatchObject({ status: 'processing', metadata: { x: 1 } });
    expect(w.enqueued.map((e) => e.subjectId)).toEqual(['a']);
  });

  it('stops at the limit', async () => {
    const w = world(['a', 'b', 'c'].map((id) => obj(id, { status: 'failed' })));
    expect((await w.service.recoverFailedImageObjects({ limit: 2 })).reprocessed).toBe(2);
  });
});

describe('media.storage.reprocess', () => {
  it('queues ready/failed media objects of the circle at background priority, statuses untouched', async () => {
    const w = world(
      [obj('a', { status: 'ready' }), obj('b', { status: 'failed', mimeType: 'video/mp4' }), obj('c', { status: 'processing' }), obj('d', { status: 'ready' })],
      {
        mediaItems: [
          { id: 'm1', circleId: 'c1', storageObjectId: 'a' },
          { id: 'm2', circleId: 'c1', storageObjectId: 'b' },
          { id: 'm3', circleId: 'c1', storageObjectId: 'c' },
          { id: 'm4', circleId: 'c2', storageObjectId: 'd' },
        ],
      },
    );
    const result = await w.service.reprocessMediaObjects('c1');

    expect(result).toEqual({ reprocessed: 2, failed: 0 });
    expect(w.enqueued.map((e) => [e.subjectId, e.priority, e.reason])).toEqual([
      ['a', 100, 'backfill'],
      ['b', 100, 'backfill'],
    ]);
    expect(w.rows.get('a')!.status).toBe('ready');
  });
});

describe('the two handlers', () => {
  const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

  it('are server-only and satisfy the platform handler contract', () => {
    const handlers: JobHandler[] = [
      new StorageRecoveryHandler(registry, {} as never),
      new StorageReprocessHandler(registry, {} as never),
    ];
    for (const handler of handlers) {
      expect(handler.nodeResultSchema).toBeUndefined();
      expect(handler.persistNodeResult).toBeUndefined();
      expect(findJobHandlerContractViolations(handler)).toEqual([]);
    }
    expect(STORAGE_RECOVER_STUCK_TYPE).toBe('media.storage.recover_stuck');
    expect(STORAGE_REPROCESS_TYPE).toBe('media.storage.reprocess');
  });

  it('dispatch on the payload mode; a null payload (the cron) is mode stuck', async () => {
    const recovery = {
      recoverStuckObjects: jest.fn(async () => ({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 })),
      recoverFailedImageObjects: jest.fn(async () => ({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 })),
      reprocessMediaObjects: jest.fn(async () => ({ reprocessed: 0, failed: 0 })),
    };
    const recover = new StorageRecoveryHandler(registry, recovery as never);
    await recover.process({ payload: null } as unknown as Job);
    await recover.process({ payload: { mode: 'stuck', olderThanMinutes: 30 } } as unknown as Job);
    await recover.process({ payload: { mode: 'failed', limit: 5 } } as unknown as Job);
    expect(recovery.recoverStuckObjects.mock.calls).toEqual([[undefined], [30]]);
    expect(recovery.recoverFailedImageObjects).toHaveBeenCalledWith({ limit: 5 });

    const reprocess = new StorageReprocessHandler(registry, recovery as never);
    await reprocess.process({ payload: { circleId: 'c1' } } as unknown as Job);
    await reprocess.process({ payload: {} } as unknown as Job);
    expect(recovery.reprocessMediaObjects.mock.calls).toEqual([['c1'], [undefined]]);
  });

  it('degrade a malformed payload to the safe default', () => {
    expect(parseRecoverPayload({ mode: 'nope', olderThanMinutes: -1 })).toEqual({ mode: 'stuck' });
    expect(parseRecoverPayload({ mode: 'failed', limit: 'x' })).toEqual({ mode: 'failed' });
  });
});

// =============================================================================
// Webhook events follow the commit, never a rolled-back write (RETRO-H4, #603)
// =============================================================================
//
// The call sites raise their event only after the write (or the transaction)
// returned. Each case makes the write fail and proves nothing was raised, then
// makes it succeed and proves the event was raised with the committed ids.
// =============================================================================

import { BurstService } from '../../src/burst/burst.service';
import { DuplicateService } from '../../src/dedup/duplicate.service';
import { MediaService } from '../../src/media/media.service';

const GROUP = { id: 'group-1', circleId: 'circle-1' };

function webhookEvents() {
  return { mediaTrashed: jest.fn(), mediaDeleted: jest.fn(), mediaCreated: jest.fn() };
}

function prismaWithTransaction(outcome: 'commit' | 'rollback') {
  return {
    $transaction: jest.fn(async () => {
      if (outcome === 'rollback') throw new Error('serialization failure');
      return [];
    }),
    mediaItem: { updateMany: jest.fn(() => ({})) },
    burstGroup: { update: jest.fn(() => ({})) },
    duplicateGroup: { update: jest.fn(() => ({})) },
    auditEvent: { create: jest.fn(async () => ({})) },
  };
}

describe.each([
  ['burst', (prisma: unknown, events: unknown) =>
    new BurstService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, events as never)],
  ['duplicate', (prisma: unknown, events: unknown) =>
    new DuplicateService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, events as never)],
])('%s group resolution with action trash', (kind, build) => {
  const resolve = (service: unknown) =>
    kind === 'burst'
      ? (service as BurstService).resolveOneBurstGroup(GROUP, ['keep'], ['a', 'b'], 'trash', 'user-1', {
          deferDuplicateDetection: true,
        })
      : (service as DuplicateService).resolveOneDuplicateGroup(GROUP, ['keep'], ['a', 'b'], 'trash', 'user-1');

  it('raises nothing when the transaction rolls back', async () => {
    const events = webhookEvents();
    await expect(resolve(build(prismaWithTransaction('rollback'), events))).rejects.toThrow('serialization failure');
    expect(events.mediaTrashed).not.toHaveBeenCalled();
  });

  it('raises media.item.trashed for the removed items once it commits', async () => {
    const events = webhookEvents();
    await resolve(build(prismaWithTransaction('commit'), events));
    expect(events.mediaTrashed).toHaveBeenCalledWith('circle-1', ['a', 'b']);
  });

  it('raises nothing for an archive resolution', async () => {
    const events = webhookEvents();
    const service = build(prismaWithTransaction('commit'), events);
    await (kind === 'burst'
      ? (service as BurstService).resolveOneBurstGroup(GROUP, ['keep'], ['a'], 'archive', 'user-1', {
          deferDuplicateDetection: true,
        })
      : (service as DuplicateService).resolveOneDuplicateGroup(GROUP, ['keep'], ['a'], 'archive', 'user-1'));
    expect(events.mediaTrashed).not.toHaveBeenCalled();
  });
});

describe('MediaService.purgeMediaItemsBatched', () => {
  function build(deleteMany: jest.Mock, events: ReturnType<typeof webhookEvents>) {
    const prisma: Record<string, unknown> = {
      mediaItem: {
        findMany: jest.fn(async () => [
          { id: 'a', circleId: 'circle-1', storageObjectId: null, storageObject: null },
          { id: 'b', circleId: 'circle-2', storageObjectId: null, storageObject: null },
        ]),
        deleteMany,
        delete: jest.fn(async () => {
          throw new Error('row locked');
        }),
      },
      storageObject: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      // RETRO-I6 (#588): the rows and their grants are deleted in one transaction.
      grant: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma)),
    };
    const args: unknown[] = Array.from({ length: 12 }, () => ({}));
    args[0] = prisma;
    args[12] = events; // the last (optional) constructor parameter
    return new (MediaService as unknown as new (...a: unknown[]) => MediaService)(...args);
  }

  it('raises media.item.deleted for the rows removed', async () => {
    const events = webhookEvents();
    const service = build(jest.fn(async () => ({ count: 2 })), events);
    await service.purgeMediaItemsBatched(['a', 'b']);
    expect(events.mediaDeleted).toHaveBeenCalledWith([
      { id: 'a', circleId: 'circle-1' },
      { id: 'b', circleId: 'circle-2' },
    ]);
  });

  it('raises nothing for rows whose delete failed', async () => {
    const events = webhookEvents();
    const service = build(
      jest.fn(async () => {
        throw new Error('batch failed');
      }),
      events,
    );
    const result = await service.purgeMediaItemsBatched(['a', 'b']);
    expect(result.failedIds).toEqual(['a', 'b']);
    expect(events.mediaDeleted).not.toHaveBeenCalled();
  });
});

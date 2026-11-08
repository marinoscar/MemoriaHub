/**
 * Unit tests for DuplicateDetectionBatchHandler.
 *
 * Covers:
 *  - Registers itself with the platform JobHandlerRegistry on module init
 *  - Label and the 30-minute, three-attempt profile; server-only (no node pair)
 *  - A circle gone since the job was queued settles as a no-op
 *  - Processes all ids in the chunk sequentially, calling
 *    DuplicateDetectionService.processMediaItem once per id
 *  - Per-item failures are collected rather than aborting the chunk early
 *  - Throws at the end (worker retry signal) when any item in the chunk failed
 *  - Does NOT throw when every item in the chunk succeeded
 *  - No-op (warn + return) when the job payload has no mediaItemIds
 */

import type { Job, JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import { DuplicateDetectionBatchHandler } from './duplicate-detection-batch.handler';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { PrismaService } from '../prisma/prisma.service';
import { circleJob, subjectPrisma } from '../../test/helpers/platform-job';

function makeJob(overrides: Partial<Job> = {}): Job {
  return circleJob('duplicate_detection_batch', 'circle-1', {
    id: 'batch-job-1',
    reason: 'backfill',
    priority: 100,
    payload: { mediaItemIds: ['media-1', 'media-2', 'media-3'] },
    ...overrides,
  });
}

describe('DuplicateDetectionBatchHandler', () => {
  let handler: DuplicateDetectionBatchHandler;
  let mockRegistry: { register: jest.Mock };
  let mockDuplicateDetectionService: { processMediaItem: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockDuplicateDetectionService = { processMediaItem: jest.fn().mockResolvedValue(undefined) };

    handler = new DuplicateDetectionBatchHandler(
      mockRegistry as unknown as JobHandlerRegistry,
      subjectPrisma() as unknown as PrismaService,
      mockDuplicateDetectionService as unknown as DuplicateDetectionService,
    );
  });

  it('registers itself with the platform registry on module init', () => {
    handler.onModuleInit();

    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it('exposes type "duplicate_detection_batch", its label and profile, and no node pair', () => {
    expect(handler.type).toBe('duplicate_detection_batch');
    expect(handler.label).toBe('Duplicate detection (batch)');
    expect(handler.profile).toEqual({ maxRuntimeMs: 1_800_000, maxAttempts: 3 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('settles as a no-op when the circle no longer exists', async () => {
    await expect(
      handler.process(circleJob('duplicate_detection_batch', 'gone-circle', { payload: { mediaItemIds: ['media-1'] } })),
    ).resolves.toBeUndefined();
    expect(mockDuplicateDetectionService.processMediaItem).not.toHaveBeenCalled();
  });

  it('ignores non-string ids in the payload', async () => {
    await handler.process(makeJob({ payload: { mediaItemIds: ['media-1', 7, null, ''] } }));
    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenCalledTimes(1);
    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenCalledWith('media-1');
  });

  it('processes every id in the chunk sequentially via processMediaItem', async () => {
    const job = makeJob({ payload: { mediaItemIds: ['media-1', 'media-2', 'media-3'] } });

    await handler.process(job);

    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenCalledTimes(3);
    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenNthCalledWith(1, 'media-1');
    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenNthCalledWith(2, 'media-2');
    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenNthCalledWith(3, 'media-3');
  });

  it('does not throw when every item in the chunk succeeds', async () => {
    const job = makeJob({ payload: { mediaItemIds: ['media-1', 'media-2'] } });

    await expect(handler.process(job)).resolves.toBeUndefined();
  });

  it('collects per-item failures rather than aborting the chunk on the first error', async () => {
    const job = makeJob({ payload: { mediaItemIds: ['media-1', 'media-2', 'media-3'] } });
    mockDuplicateDetectionService.processMediaItem
      .mockResolvedValueOnce(undefined) // media-1 succeeds
      .mockRejectedValueOnce(new Error('boom-1')) // media-2 fails
      .mockResolvedValueOnce(undefined); // media-3 still gets processed

    await expect(handler.process(job)).rejects.toThrow();

    // All three ids were attempted despite the failure in the middle
    expect(mockDuplicateDetectionService.processMediaItem).toHaveBeenCalledTimes(3);
  });

  it('throws at the end summarizing failures when any item in the chunk failed', async () => {
    const job = makeJob({ payload: { mediaItemIds: ['media-1', 'media-2'] } });
    mockDuplicateDetectionService.processMediaItem
      .mockRejectedValueOnce(new Error('failure-a'))
      .mockRejectedValueOnce(new Error('failure-b'));

    await expect(handler.process(job)).rejects.toThrow(/2\/2 item\(s\) failed/);
  });

  it('is a no-op (does not call processMediaItem) when payload has no mediaItemIds', async () => {
    const job = makeJob({ payload: {} });

    await expect(handler.process(job)).resolves.toBeUndefined();
    expect(mockDuplicateDetectionService.processMediaItem).not.toHaveBeenCalled();
  });

  it('is a no-op when payload is null', async () => {
    const job = makeJob({ payload: null });

    await expect(handler.process(job)).resolves.toBeUndefined();
    expect(mockDuplicateDetectionService.processMediaItem).not.toHaveBeenCalled();
  });

  it('is a no-op when mediaItemIds is an empty array', async () => {
    const job = makeJob({ payload: { mediaItemIds: [] } });

    await expect(handler.process(job)).resolves.toBeUndefined();
    expect(mockDuplicateDetectionService.processMediaItem).not.toHaveBeenCalled();
  });
});

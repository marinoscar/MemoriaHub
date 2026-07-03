/**
 * Unit tests for DuplicateDetectionBatchHandler.
 *
 * Covers:
 *  - Registers itself with the EnrichmentHandlerRegistry on module init
 *  - Processes all ids in the chunk sequentially, calling
 *    DuplicateDetectionService.processMediaItem once per id
 *  - Per-item failures are collected rather than aborting the chunk early
 *  - Throws at the end (worker retry signal) when any item in the chunk failed
 *  - Does NOT throw when every item in the chunk succeeded
 *  - No-op (warn + return) when the job payload has no mediaItemIds
 */

import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { DuplicateDetectionBatchHandler } from './duplicate-detection-batch.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { DuplicateDetectionService } from './duplicate-detection.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'batch-job-1',
    type: 'duplicate_detection_batch',
    mediaItemId: null,
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.backfill,
    priority: 100,
    providerKey: null,
    modelVersion: null,
    payload: { mediaItemIds: ['media-1', 'media-2', 'media-3'] },
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

describe('DuplicateDetectionBatchHandler', () => {
  let handler: DuplicateDetectionBatchHandler;
  let mockRegistry: { register: jest.Mock };
  let mockDuplicateDetectionService: { processMediaItem: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockDuplicateDetectionService = { processMediaItem: jest.fn().mockResolvedValue(undefined) };

    handler = new DuplicateDetectionBatchHandler(
      mockRegistry as unknown as EnrichmentHandlerRegistry,
      mockDuplicateDetectionService as unknown as DuplicateDetectionService,
    );
  });

  it('registers itself with the EnrichmentHandlerRegistry on module init', () => {
    handler.onModuleInit();

    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it('exposes type "duplicate_detection_batch"', () => {
    expect(handler.type).toBe('duplicate_detection_batch');
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

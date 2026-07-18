/**
 * Unit tests for LocationBulkAcceptHandler.
 *
 * Covers:
 *  - Registers itself with the EnrichmentHandlerRegistry on module init.
 *  - Exposes type 'location_bulk_accept'.
 *  - job.circleId null -> warns and returns without calling the service.
 *  - job.payload missing / minConfidence not a number / requestedById falsy
 *    -> warns and returns without calling the service.
 *  - Valid job -> calls processBulkAccept(circleId, minConfidence, requestedById)
 *    with values read from job.payload.
 */

import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { LocationBulkAcceptHandler } from './location-bulk-accept.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { LocationSuggestionService } from './location-suggestion.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'location_bulk_accept',
    mediaItemId: null,
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.rerun,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: { minConfidence: 0.7, requestedById: 'user-1' },
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    claimedByNodeId: null,
    leaseExpiresAt: null,
    executor: null,
    createdAt: new Date(),
    ...overrides,
  } as EnrichmentJob;
}

describe('LocationBulkAcceptHandler', () => {
  let handler: LocationBulkAcceptHandler;
  let mockRegistry: { register: jest.Mock };
  let mockLocationSuggestionService: { processBulkAccept: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockLocationSuggestionService = {
      processBulkAccept: jest.fn().mockResolvedValue(0),
    };

    handler = new LocationBulkAcceptHandler(
      mockRegistry as unknown as EnrichmentHandlerRegistry,
      mockLocationSuggestionService as unknown as LocationSuggestionService,
    );
  });

  it('registers itself with the EnrichmentHandlerRegistry on module init', () => {
    handler.onModuleInit();

    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it("exposes type 'location_bulk_accept'", () => {
    expect(handler.type).toBe('location_bulk_accept');
  });

  it('warns and returns without calling the service when job.circleId is null', async () => {
    const job = makeJob({ circleId: null });

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(mockLocationSuggestionService.processBulkAccept).not.toHaveBeenCalled();
  });

  it('warns and returns when job.payload is null', async () => {
    const job = makeJob({ payload: null });

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(mockLocationSuggestionService.processBulkAccept).not.toHaveBeenCalled();
  });

  it('warns and returns when payload.minConfidence is not a number', async () => {
    const job = makeJob({ payload: { minConfidence: '0.7', requestedById: 'user-1' } as any });

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(mockLocationSuggestionService.processBulkAccept).not.toHaveBeenCalled();
  });

  it('warns and returns when payload.requestedById is missing', async () => {
    const job = makeJob({ payload: { minConfidence: 0.7 } as any });

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(mockLocationSuggestionService.processBulkAccept).not.toHaveBeenCalled();
  });

  it('calls processBulkAccept(circleId, minConfidence, requestedById) with values from job.payload when valid', async () => {
    const job = makeJob({
      circleId: 'circle-xyz',
      payload: { minConfidence: 0.85, requestedById: 'user-42' },
    });

    await handler.process(job);

    expect(mockLocationSuggestionService.processBulkAccept).toHaveBeenCalledWith(
      'circle-xyz',
      0.85,
      'user-42',
    );
  });
});

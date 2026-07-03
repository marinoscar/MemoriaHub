/**
 * Unit tests for LocationInferenceHandler.
 *
 * Covers:
 *  - Registers itself with the EnrichmentHandlerRegistry on module init
 *  - Exposes type 'location_inference'
 *  - job.mediaItemId set + reason='upload' -> inferForItem(mediaItemId, false)
 *  - job.mediaItemId set + reason='rerun' -> inferForItem(mediaItemId, true)
 *  - job.mediaItemId null + circleId set -> sweepCircle(circleId, {from,to,force})
 *    read from job.payload (circleId always comes from job.circleId)
 *  - job.mediaItemId null + circleId null -> warns and does NOT call sweepCircle
 */

import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { LocationInferenceHandler } from './location-inference.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { LocationInferenceService } from './location-inference.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'location_inference',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
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

describe('LocationInferenceHandler', () => {
  let handler: LocationInferenceHandler;
  let mockRegistry: { register: jest.Mock };
  let mockLocationInferenceService: { inferForItem: jest.Mock; sweepCircle: jest.Mock };

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockLocationInferenceService = {
      inferForItem: jest.fn().mockResolvedValue(undefined),
      sweepCircle: jest.fn().mockResolvedValue({ targets: 0, autoApplied: 0, pending: 0, skipped: 0, elapsedMs: 0 }),
    };

    handler = new LocationInferenceHandler(
      mockRegistry as unknown as EnrichmentHandlerRegistry,
      mockLocationInferenceService as unknown as LocationInferenceService,
    );
  });

  it('registers itself with the EnrichmentHandlerRegistry on module init', () => {
    handler.onModuleInit();

    expect(mockRegistry.register).toHaveBeenCalledWith(handler);
  });

  it('exposes type "location_inference"', () => {
    expect(handler.type).toBe('location_inference');
  });

  it('mediaItemId set + reason=upload -> inferForItem(mediaItemId, false)', async () => {
    const job = makeJob({ mediaItemId: 'media-1', reason: JobReason.upload });

    await handler.process(job);

    expect(mockLocationInferenceService.inferForItem).toHaveBeenCalledWith('media-1', false);
    expect(mockLocationInferenceService.sweepCircle).not.toHaveBeenCalled();
  });

  it('mediaItemId set + reason=rerun -> inferForItem(mediaItemId, true) — forces past the rejected-skip rule', async () => {
    const job = makeJob({ mediaItemId: 'media-1', reason: JobReason.rerun });

    await handler.process(job);

    expect(mockLocationInferenceService.inferForItem).toHaveBeenCalledWith('media-1', true);
  });

  it('mediaItemId null + circleId set -> sweepCircle(circleId, {from,to,force}) read from job.payload', async () => {
    const job = makeJob({
      mediaItemId: null,
      circleId: 'circle-xyz',
      payload: { mode: 'sweep', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', force: true },
    });

    await handler.process(job);

    expect(mockLocationInferenceService.sweepCircle).toHaveBeenCalledWith('circle-xyz', {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      force: true,
    });
    expect(mockLocationInferenceService.inferForItem).not.toHaveBeenCalled();
  });

  it('circleId always comes from job.circleId, not from a circleId field inside the payload', async () => {
    const job = makeJob({
      mediaItemId: null,
      circleId: 'circle-from-job',
      payload: { mode: 'sweep', circleId: 'circle-from-payload-should-be-ignored' } as any,
    });

    await handler.process(job);

    expect(mockLocationInferenceService.sweepCircle).toHaveBeenCalledWith('circle-from-job', expect.anything());
  });

  it('mediaItemId null + circleId null -> warns and does not call sweepCircle', async () => {
    const job = makeJob({ mediaItemId: null, circleId: null });

    await expect(handler.process(job)).resolves.toBeUndefined();

    expect(mockLocationInferenceService.sweepCircle).not.toHaveBeenCalled();
    expect(mockLocationInferenceService.inferForItem).not.toHaveBeenCalled();
  });
});

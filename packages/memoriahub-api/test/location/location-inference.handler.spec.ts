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

import { LocationInferenceHandler } from '../../src/location/inference/location-inference.handler.js';
import type { LocationInferenceService } from '../../src/location/inference/location-inference.service.js';
import { circleJob, mediaItemJob, subjectPrisma, subjectScopes, systemJob } from '../helpers/job-fixtures.js';

describe('LocationInferenceHandler', () => {
  let handler: LocationInferenceHandler;
  let mockRegistry: { registerHandler: jest.Mock };
  let mockLocationInferenceService: { inferForItem: jest.Mock; sweepCircle: jest.Mock };

  beforeEach(() => {
    mockRegistry = { registerHandler: jest.fn() };
    mockLocationInferenceService = {
      inferForItem: jest.fn().mockResolvedValue(undefined),
      sweepCircle: jest.fn().mockResolvedValue({ targets: 0, autoApplied: 0, pending: 0, skipped: 0, elapsedMs: 0 }),
    };

    handler = new LocationInferenceHandler(
      mockRegistry as never,
      subjectPrisma({ mediaItems: { 'media-1': 'circle-1' } }) as never,
      subjectScopes(['circle-1', 'circle-xyz', 'circle-from-job']) as never,
      mockLocationInferenceService as unknown as LocationInferenceService,
    );
  });

  it('registers itself with the jobs port on module init', () => {
    handler.onModuleInit();

    expect(mockRegistry.registerHandler).toHaveBeenCalledWith(handler);
  });

  it('exposes type "location_inference", a label and the 15-minute profile; it is server-only (no node pair)', () => {
    expect(handler.type).toBe('location_inference');
    expect(handler.label).toBe('Location inference');
    expect(handler.profile).toEqual({ maxRuntimeMs: 900_000, maxAttempts: 3 });
    expect((handler as { nodeResultSchema?: unknown }).nodeResultSchema).toBeUndefined();
    expect((handler as { persistNodeResult?: unknown }).persistNodeResult).toBeUndefined();
  });

  it('media item subject + reason=upload -> inferForItem(mediaItemId, false)', async () => {
    await handler.process(mediaItemJob('location_inference', 'media-1', 'circle-1', { reason: 'upload' }));

    expect(mockLocationInferenceService.inferForItem).toHaveBeenCalledWith('media-1', false);
    expect(mockLocationInferenceService.sweepCircle).not.toHaveBeenCalled();
  });

  it('media item subject + reason=rerun -> inferForItem(mediaItemId, true) — forces past the rejected-skip rule', async () => {
    await handler.process(mediaItemJob('location_inference', 'media-1', 'circle-1', { reason: 'rerun' }));

    expect(mockLocationInferenceService.inferForItem).toHaveBeenCalledWith('media-1', true);
  });

  it('a media item deleted since the job was queued settles as a no-op', async () => {
    await handler.process(mediaItemJob('location_inference', 'media-gone', 'circle-1'));

    expect(mockLocationInferenceService.inferForItem).not.toHaveBeenCalled();
  });

  it('circle subject -> sweepCircle(circleId, {from,to,force}) read from job.payload', async () => {
    await handler.process(
      circleJob('location_inference', 'circle-xyz', {
        reason: 'backfill',
        payload: { mode: 'sweep', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', force: true },
      }),
    );

    expect(mockLocationInferenceService.sweepCircle).toHaveBeenCalledWith('circle-xyz', {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      force: true,
    });
    expect(mockLocationInferenceService.inferForItem).not.toHaveBeenCalled();
  });

  it('the circle always comes from the job subject, not from a circleId field inside the payload', async () => {
    await handler.process(
      circleJob('location_inference', 'circle-from-job', {
        payload: { mode: 'sweep', circleId: 'circle-from-payload-should-be-ignored' },
      }),
    );

    expect(mockLocationInferenceService.sweepCircle).toHaveBeenCalledWith('circle-from-job', expect.anything());
  });

  it('a circle deleted since the sweep was queued settles as a no-op', async () => {
    await handler.process(circleJob('location_inference', 'circle-gone'));

    expect(mockLocationInferenceService.sweepCircle).not.toHaveBeenCalled();
  });

  it('a job with no subject warns and calls nothing', async () => {
    await expect(handler.process(systemJob('location_inference'))).resolves.toBeUndefined();

    expect(mockLocationInferenceService.sweepCircle).not.toHaveBeenCalled();
    expect(mockLocationInferenceService.inferForItem).not.toHaveBeenCalled();
  });
});

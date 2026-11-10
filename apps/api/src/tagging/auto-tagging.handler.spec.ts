/**
 * Unit tests for AutoTaggingHandler (native platform JobHandler, RETRO-C4 #590).
 *
 * The handler is SERVER-ONLY (AI rule 3): no node pair, a 3-minute / 3-attempt
 * profile, the shared `tagging` throttle gate, and every provider throttle
 * (HTTP 429/529) reaches the queue as the platform RateLimitError (a deferral,
 * not a consumed attempt).
 */

import { RateLimitError as PlatformRateLimitError } from '@marinoscar/platform-api/jobs';
import { AutoTaggingHandler } from './auto-tagging.handler';
import { RateLimitError as LegacyRateLimitError } from '../enrichment/rate-limit.error';
import { mediaItemJob, subjectPrisma } from '../../test/helpers/platform-job';

describe('AutoTaggingHandler', () => {
  let registry: { register: jest.Mock };
  let throttle: { registerProviderKey: jest.Mock };
  let service: { processMediaItem: jest.Mock };
  let handler: AutoTaggingHandler;

  beforeEach(() => {
    registry = { register: jest.fn() };
    throttle = { registerProviderKey: jest.fn() };
    service = { processMediaItem: jest.fn().mockResolvedValue(undefined) };
    handler = new AutoTaggingHandler(
      registry as never,
      throttle as never,
      subjectPrisma({ mediaItems: { 'media-1': 'circle-1' } }) as never,
      service as never,
    );
  });

  it("has the permanent type 'auto_tagging', a label and the 3-minute profile", () => {
    expect(handler.type).toBe('auto_tagging');
    expect(handler.label).toBe('Auto-tagging');
    expect(handler.profile).toEqual({ maxRuntimeMs: 180_000, maxAttempts: 3 });
  });

  it('is server-only: no node pair (AI rule 3)', () => {
    expect((handler as unknown as Record<string, unknown>)['nodeResultSchema']).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>)['persistNodeResult']).toBeUndefined();
  });

  it('registers with the JobHandlerRegistry and the shared `tagging` throttle gate', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(throttle.registerProviderKey).toHaveBeenCalledWith('auto_tagging', 'tagging');
  });

  it('delegates to AutoTaggingService.processMediaItem with the media-item context', async () => {
    await handler.process(mediaItemJob('auto_tagging', 'media-1', 'circle-1', { id: 'job-9' }));
    expect(service.processMediaItem).toHaveBeenCalledWith({
      id: 'job-9',
      mediaItemId: 'media-1',
      circleId: 'circle-1',
    });
  });

  it('settles as a no-op when the media item was deleted after the job was queued', async () => {
    await handler.process(mediaItemJob('auto_tagging', 'gone', 'circle-1'));
    expect(service.processMediaItem).not.toHaveBeenCalled();
  });

  it('rethrows a legacy RateLimitError as the platform RateLimitError, keeping retryAfterMs', async () => {
    service.processMediaItem.mockRejectedValue(new LegacyRateLimitError('slow down', 7_000, 'anthropic'));
    const error = await handler.process(mediaItemJob('auto_tagging', 'media-1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRateLimitError);
    expect(error).toMatchObject({ message: 'slow down', retryAfterMs: 7_000 });
  });

  it.each([429, 529])('classifies an HTTP %i from the provider SDK as a rate limit', async (status) => {
    service.processMediaItem.mockRejectedValue(Object.assign(new Error('Overloaded'), { status }));
    await expect(handler.process(mediaItemJob('auto_tagging', 'media-1'))).rejects.toBeInstanceOf(
      PlatformRateLimitError,
    );
  });

  it('lets any other failure through unchanged (the queue retries it)', async () => {
    const boom = new Error('boom');
    service.processMediaItem.mockRejectedValue(boom);
    await expect(handler.process(mediaItemJob('auto_tagging', 'media-1'))).rejects.toBe(boom);
  });
});

/**
 * Unit tests for AutoTaggingHandler (a job handler registered through the jobs port,
 * RETRO-C4 #590, RETRO-J7 #618).
 *
 * The handler is SERVER-ONLY (AI rule 3): no node pair, `usesAi`, a 3-minute / 3-attempt
 * profile, the shared `tagging` throttle gate, and every provider throttle
 * (HTTP 429/529) reaches the queue as a MemoriahubRateLimitError (a deferral,
 * not a consumed attempt).
 */

import { MemoriahubAiError, MemoriahubRateLimitError } from '../ports/index.js';
import { mediaItemJob, subjectPrisma } from '../../test/helpers/job-rows.js';
import { AutoTaggingHandler } from './auto-tagging.handler.js';

describe('AutoTaggingHandler', () => {
  let jobs: { registerHandler: jest.Mock };
  let service: { processMediaItem: jest.Mock };
  let handler: AutoTaggingHandler;

  beforeEach(() => {
    jobs = { registerHandler: jest.fn() };
    service = { processMediaItem: jest.fn().mockResolvedValue(undefined) };
    handler = new AutoTaggingHandler(
      jobs as never,
      subjectPrisma({ mediaItems: { 'media-1': 'circle-1' } }) as never,
      service as never,
    );
  });

  it("has the permanent type 'auto_tagging', a label and the 3-minute profile", () => {
    expect(handler.type).toBe('auto_tagging');
    expect(handler.label).toBe('Auto-tagging');
    expect(handler.profile).toEqual({ maxRuntimeMs: 180_000, maxAttempts: 3 });
  });

  it('is server-only: declares usesAi and no node pair (AI rule 3)', () => {
    expect(handler.usesAi).toBe(true);
    expect((handler as unknown as Record<string, unknown>)['nodeResultSchema']).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>)['persistNodeResult']).toBeUndefined();
  });

  it('registers through the jobs port with the shared `tagging` throttle gate', () => {
    handler.onModuleInit();
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    expect(handler.throttleKey).toBe('tagging');
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

  it('keeps a MemoriahubRateLimitError as it is, with its retryAfterMs', async () => {
    service.processMediaItem.mockRejectedValue(new MemoriahubRateLimitError('tagging', 7_000, 'slow down'));
    const error = await handler.process(mediaItemJob('auto_tagging', 'media-1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoriahubRateLimitError);
    expect(error).toMatchObject({ message: 'slow down', retryAfterMs: 7_000, throttleKey: 'tagging' });
  });

  it('turns an AI rate_limit failure into the deferral', async () => {
    service.processMediaItem.mockRejectedValue(new MemoriahubAiError('rate_limit', 'busy', 3_000));
    const error = await handler.process(mediaItemJob('auto_tagging', 'media-1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoriahubRateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 3_000 });
  });

  it.each([429, 529])('classifies an HTTP %i from the provider SDK as a rate limit', async (status) => {
    service.processMediaItem.mockRejectedValue(Object.assign(new Error('Overloaded'), { status }));
    await expect(handler.process(mediaItemJob('auto_tagging', 'media-1'))).rejects.toBeInstanceOf(
      MemoriahubRateLimitError,
    );
  });

  it('lets any other failure through unchanged (the queue retries it)', async () => {
    const boom = new Error('boom');
    service.processMediaItem.mockRejectedValue(boom);
    await expect(handler.process(mediaItemJob('auto_tagging', 'media-1'))).rejects.toBe(boom);
  });
});

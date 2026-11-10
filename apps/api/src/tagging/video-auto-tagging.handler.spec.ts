/**
 * Unit tests for VideoAutoTaggingHandler (epic #452; native platform JobHandler
 * since RETRO-C4 #590). Server-only (AI rule 3): no node pair; ffmpeg reads the
 * video on the API host.
 */

import { RateLimitError as PlatformRateLimitError } from '@marinoscar/platform-api/jobs';
import { VideoAutoTaggingHandler } from './video-auto-tagging.handler';
import { RateLimitError as LegacyRateLimitError } from '../enrichment/rate-limit.error';
import { mediaItemJob, subjectPrisma } from '../../test/helpers/platform-job';

describe('VideoAutoTaggingHandler', () => {
  let registry: { register: jest.Mock };
  let throttle: { registerProviderKey: jest.Mock };
  let videoService: { processMediaItem: jest.Mock };
  let handler: VideoAutoTaggingHandler;

  beforeEach(() => {
    registry = { register: jest.fn() };
    throttle = { registerProviderKey: jest.fn() };
    videoService = { processMediaItem: jest.fn().mockResolvedValue(undefined) };
    handler = new VideoAutoTaggingHandler(
      registry as never,
      throttle as never,
      subjectPrisma({ mediaItems: { 'media-1': 'circle-1' } }) as never,
      videoService as never,
    );
  });

  it('registers under a job type DISTINCT from auto_tagging, sharing its `tagging` gate', () => {
    handler.onModuleInit();
    expect(handler.type).toBe('video_auto_tagging');
    expect(handler.type).not.toBe('auto_tagging');
    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(throttle.registerProviderKey).toHaveBeenCalledWith('video_auto_tagging', 'tagging');
  });

  it('declares the 20-minute video profile (duration-independent ceiling)', () => {
    expect(handler.profile).toEqual({ maxRuntimeMs: 1_200_000, maxAttempts: 3 });
  });

  it('is server-only: no node pair (AI rule 3)', () => {
    expect((handler as unknown as Record<string, unknown>)['nodeResultSchema']).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>)['persistNodeResult']).toBeUndefined();
  });

  it('delegates process() to VideoAutoTaggingService with the media-item context', async () => {
    await handler.process(mediaItemJob('video_auto_tagging', 'media-1', 'circle-1', { id: 'job-3' }));
    expect(videoService.processMediaItem).toHaveBeenCalledWith({
      id: 'job-3',
      mediaItemId: 'media-1',
      circleId: 'circle-1',
    });
  });

  it('settles as a no-op for a media item that no longer exists', async () => {
    await handler.process(mediaItemJob('video_auto_tagging', 'gone'));
    expect(videoService.processMediaItem).not.toHaveBeenCalled();
  });

  it('defers on a provider throttle through the platform RateLimitError', async () => {
    videoService.processMediaItem.mockRejectedValue(new LegacyRateLimitError('busy', 4_000, 'openai'));
    const error = await handler.process(mediaItemJob('video_auto_tagging', 'media-1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 4_000 });
  });
});

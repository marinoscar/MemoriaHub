/**
 * Unit tests for VideoAutoTaggingHandler (epic #452; a job handler registered through the
 * jobs port since RETRO-J7 #618). Server-only (AI rule 3): no node pair; ffmpeg reads the
 * video on the API host.
 */

import { MemoriahubRateLimitError } from '../ports/index.js';
import { mediaItemJob, subjectPrisma } from '../../test/helpers/job-rows.js';
import { VideoAutoTaggingHandler } from './video-auto-tagging.handler.js';

describe('VideoAutoTaggingHandler', () => {
  let jobs: { registerHandler: jest.Mock };
  let videoService: { processMediaItem: jest.Mock };
  let handler: VideoAutoTaggingHandler;

  beforeEach(() => {
    jobs = { registerHandler: jest.fn() };
    videoService = { processMediaItem: jest.fn().mockResolvedValue(undefined) };
    handler = new VideoAutoTaggingHandler(
      jobs as never,
      subjectPrisma({ mediaItems: { 'media-1': 'circle-1' } }) as never,
      videoService as never,
    );
  });

  it('registers under a job type DISTINCT from auto_tagging, sharing its `tagging` gate', () => {
    handler.onModuleInit();
    expect(handler.type).toBe('video_auto_tagging');
    expect(handler.type).not.toBe('auto_tagging');
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    expect(handler.throttleKey).toBe('tagging');
  });

  it('declares the 20-minute video profile (duration-independent ceiling)', () => {
    expect(handler.profile).toEqual({ maxRuntimeMs: 1_200_000, maxAttempts: 3 });
  });

  it('is server-only: declares usesAi and no node pair (AI rule 3)', () => {
    expect(handler.usesAi).toBe(true);
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

  it('defers on a provider throttle through MemoriahubRateLimitError', async () => {
    videoService.processMediaItem.mockRejectedValue(Object.assign(new Error('busy'), { status: 429, headers: { 'retry-after': '4' } }));
    const error = await handler.process(mediaItemJob('video_auto_tagging', 'media-1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoriahubRateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 4_000 });
  });
});

import type { MemoriahubJob } from '../../../src/ports/index.js';

/** A job about one media item, as `FaceJobs.enqueue` queues it: the circle rides in the payload. */
export function mediaItemJob(
  type: string,
  mediaItemId = 'media-1',
  circleId: string | null = 'circle-1',
  overrides: Partial<MemoriahubJob> = {},
): MemoriahubJob {
  return {
    id: 'job-1',
    type,
    subjectType: 'media_item',
    subjectId: mediaItemId,
    payload: circleId ? { circleId } : null,
    attempts: 1,
    orgId: '00000000-0000-4000-8000-0000000000aa',
    ...overrides,
  };
}

/** A job about one circle (a per-circle sweep). */
export function circleJob(type: string, circleId = 'circle-1', overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  return {
    id: 'job-1',
    type,
    subjectType: 'circle',
    subjectId: circleId,
    payload: null,
    attempts: 1,
    orgId: '00000000-0000-4000-8000-0000000000aa',
    ...overrides,
  };
}

/** A database double answering the media-item subject lookup of `resolveMediaItemJob`. */
export function subjectPrisma(existing: { mediaItems?: Record<string, string> } = { mediaItems: { 'media-1': 'circle-1' } }) {
  const mediaItems = existing.mediaItems ?? {};
  return {
    mediaItem: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id in mediaItems ? { id: where.id, circleId: mediaItems[where.id] } : null,
      ),
    },
  };
}

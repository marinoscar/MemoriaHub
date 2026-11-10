import type { MemoriahubJob } from '../../src/ports/index.js';

// Job rows and a subject lookup for handler unit tests (RETRO-J7, #618).

/** A job about one media item, as the enqueue stores it (`payload.circleId`). */
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
    attempts: 0,
    orgId: '00000000-0000-4000-8000-0000000000aa',
    status: 'running',
    ...overrides,
  };
}

/** A database double answering the media-item subject lookup of `resolveMediaItemJob`. */
export function subjectPrisma(
  existing: { mediaItems?: Record<string, string> } = { mediaItems: { 'media-1': 'circle-1' } },
) {
  const mediaItems = existing.mediaItems ?? {};
  return {
    mediaItem: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id in mediaItems ? { id: where.id, circleId: mediaItems[where.id] } : null,
      ),
    },
  };
}

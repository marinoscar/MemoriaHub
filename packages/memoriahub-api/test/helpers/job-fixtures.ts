// =============================================================================
// Job fixtures for the slice specs that moved out of the web app
// =============================================================================
//
// The domain job a handler is given (`MemoriahubJob`) and the doubles of the two subject lookups
// (`resolveMediaItemJob`, `resolveCircleJob`) that handlers use.
// =============================================================================

import type { MemoriahubJob } from '../../src/ports/index.js';

const TEST_ORG_ID = '00000000-0000-4000-8000-0000000000a1';

let counter = 0;

/** A job with the defaults of a freshly claimed row. */
export function domainJob(overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  counter += 1;
  return { id: `job-${counter}`, type: 'example', subjectType: null, subjectId: null, payload: null, reason: 'upload', attempts: 1, orgId: null, ...overrides };
}

/** A job about one media item. */
export function mediaItemJob(type: string, mediaItemId = 'media-1', circleId: string | null = 'circle-1', overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  return domainJob({ type, subjectType: 'media_item', subjectId: mediaItemId, payload: circleId ? { circleId } : null, orgId: TEST_ORG_ID, ...overrides });
}

/** A job about one circle (a per-circle sweep). */
export function circleJob(type: string, circleId = 'circle-1', overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  return domainJob({ type, subjectType: 'circle', subjectId: circleId, orgId: TEST_ORG_ID, ...overrides });
}

/** A global (system) job: no subject, no organization. */
export function systemJob(type: string, overrides: Partial<MemoriahubJob> = {}): MemoriahubJob {
  return domainJob({ type, ...overrides });
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

/** The access double the `circle` job resolver reads (`scopeExists`). */
export function subjectScopes(circles: string[] = ['circle-1']) {
  const known = new Set(circles);
  return { scopeExists: jest.fn(async (id: string) => known.has(id)) };
}

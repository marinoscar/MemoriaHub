/**
 * Unit tests for MediaEnrichmentService (moved to the media slice by RETRO-J5, #613). Host-free: the
 * ports are plain doubles.
 *
 *  - the post-detection video fan-out releases `video_face_detection` and `video_auto_tagging` behind
 *    their own, independent gates (feature flag, sub-feature flag, environment kill switch)
 *  - priority follows the reason (rerun 0, upload 20, backfill 100)
 *  - a deleted item and a photo enqueue nothing; a failure never rethrows
 *  - the rerun helpers route by media type, enqueue at priority 0 and mark the status pending
 *  - the storage-object backstop resolves the item and delegates to the registry fan-out
 */

import { MediaEnrichmentService } from './media-enrichment.service.js';

const video = { id: 'media-v1', type: 'video', circleId: 'circle-1', deletedAt: null as Date | null };
const photo = { id: 'media-p1', type: 'photo', circleId: 'circle-1', deletedAt: null as Date | null };

function setup(opts: { face?: boolean; videoFace?: boolean; tagging?: boolean; videoTagging?: boolean } = {}) {
  const { face = true, videoFace = true, tagging = true, videoTagging = true } = opts;
  const namespaces: Record<string, unknown> = {
    features: { faceRecognition: face, autoTagging: tagging },
    face: { video: { enabled: videoFace } },
    autoTagging: { video: { enabled: videoTagging } },
  };
  const settings = { readSystem: jest.fn(async (name: string) => ({ value: namespaces[name], version: 1 })) };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1', deduplicated: false })) };
  const prisma = {
    mediaFaceStatus: { upsert: jest.fn(async () => ({})) },
    mediaTagStatus: { upsert: jest.fn(async () => ({})) },
    mediaItem: { findUnique: jest.fn() },
  };
  const upload = { enqueueUploadEnrichment: jest.fn(async () => undefined) };
  const service = new MediaEnrichmentService(prisma as never, jobs as never, settings as never, upload as never);
  const types = () => (jobs.enqueue.mock.calls as unknown as Array<[{ type: string }]>).map(([input]) => input.type);
  return { service, settings, jobs, prisma, upload, types };
}

describe('MediaEnrichmentService', () => {
  afterEach(() => {
    delete process.env['FACE_AUTO_DETECT'];
    delete process.env['AUTO_TAG_ENABLED'];
  });

  describe('enqueueVideoPostDetectionEnrichment', () => {
    it('releases both video jobs at priority 20 for an upload, as media-item jobs carrying the circle', async () => {
      const { service, jobs, prisma, types } = setup();

      await service.enqueueVideoPostDetectionEnrichment(video, 'upload');

      expect(types().sort()).toEqual(['video_auto_tagging', 'video_face_detection']);
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'video_face_detection',
          reason: 'upload',
          priority: 20,
          subjectType: 'media_item',
          subjectId: 'media-v1',
          payload: { circleId: 'circle-1' },
        }),
      );
      expect(prisma.mediaFaceStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { mediaItemId: 'media-v1' }, update: { status: 'pending' } }),
      );
      expect(prisma.mediaTagStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ circleId: 'circle-1', status: 'pending' }) }),
      );
    });

    it.each([
      ['rerun', 0],
      ['upload', 20],
      ['backfill', 100],
    ])('maps the %s reason to priority %i', async (reason, priority) => {
      const { service, jobs } = setup();

      await service.enqueueVideoPostDetectionEnrichment(video, reason);

      for (const [input] of jobs.enqueue.mock.calls as unknown as Array<[{ priority: number }]>) {
        expect(input.priority).toBe(priority);
      }
    });

    it('keeps the two gates independent', async () => {
      const faceOnly = setup({ videoTagging: false });
      await faceOnly.service.enqueueVideoPostDetectionEnrichment(video, 'upload');
      expect(faceOnly.types()).toEqual(['video_face_detection']);

      const tagOnly = setup({ face: false });
      await tagOnly.service.enqueueVideoPostDetectionEnrichment(video, 'upload');
      expect(tagOnly.types()).toEqual(['video_auto_tagging']);
    });

    it('treats an absent face.video.enabled as on, but needs autoTagging.video.enabled explicitly', async () => {
      const s = setup();
      s.settings.readSystem.mockImplementation(async (name: string) => ({
        value: name === 'features' ? { faceRecognition: true, autoTagging: true } : undefined,
        version: 1,
      }));
      await s.service.enqueueVideoPostDetectionEnrichment(video, 'upload');
      expect(s.types()).toEqual(['video_face_detection']);
    });

    it('honours the FACE_AUTO_DETECT and AUTO_TAG_ENABLED kill switches', async () => {
      process.env['FACE_AUTO_DETECT'] = 'false';
      process.env['AUTO_TAG_ENABLED'] = 'false';
      const { service, jobs } = setup();

      await service.enqueueVideoPostDetectionEnrichment(video, 'upload');

      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues nothing for a deleted video or a photo, and never rethrows', async () => {
      const a = setup();
      await a.service.enqueueVideoPostDetectionEnrichment({ ...video, deletedAt: new Date() }, 'upload');
      await a.service.enqueueVideoPostDetectionEnrichment(photo, 'upload');
      expect(a.jobs.enqueue).not.toHaveBeenCalled();

      const b = setup();
      b.jobs.enqueue.mockRejectedValue(new Error('queue down'));
      await expect(b.service.enqueueVideoPostDetectionEnrichment(video, 'upload')).resolves.toBeUndefined();
    });
  });

  describe('rerun helpers', () => {
    it('routes the tagging rerun by media type and reads the type from the row when absent', async () => {
      const a = setup();
      await a.service.enqueueTagRerun({ id: 'm1', circleId: 'c1', type: 'video' });
      expect(a.types()).toEqual(['video_auto_tagging']);

      const b = setup();
      b.prisma.mediaItem.findUnique.mockResolvedValue({ type: 'photo' });
      await b.service.enqueueTagRerun({ id: 'm2', circleId: 'c1' });
      expect(b.types()).toEqual(['auto_tagging']);
      expect(b.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rerun', priority: 0 }));
      expect(b.prisma.mediaTagStatus.upsert).toHaveBeenCalledTimes(1);
    });

    it('routes the face rerun by media type and marks the face status pending', async () => {
      const a = setup();
      await a.service.enqueueFaceRerun({ id: 'm1', circleId: 'c1', type: 'video' });
      await a.service.enqueueFaceRerun({ id: 'm2', circleId: 'c1', type: 'photo' });
      expect(a.types()).toEqual(['video_face_detection', 'face_detection']);
      expect(a.prisma.mediaFaceStatus.upsert).toHaveBeenCalledTimes(2);
    });

    it('queues thumbnail_regen with no status table', async () => {
      const a = setup();
      await a.service.enqueueThumbnailRerun({ id: 'm1', circleId: 'c1' });
      expect(a.types()).toEqual(['thumbnail_regen']);
    });

    it('does not check the feature flags (the handlers do)', async () => {
      const a = setup({ face: false, tagging: false });
      await a.service.enqueueFaceRerun({ id: 'm1', circleId: 'c1', type: 'photo' });
      await a.service.enqueueTagRerun({ id: 'm1', circleId: 'c1', type: 'photo' });
      expect(a.types()).toEqual(['face_detection', 'auto_tagging']);
    });
  });

  describe('enqueueForStorageObject', () => {
    it('does nothing when no media item has the object', async () => {
      const a = setup();
      a.prisma.mediaItem.findUnique.mockResolvedValue(null);
      await a.service.enqueueForStorageObject('obj-1');
      expect(a.upload.enqueueUploadEnrichment).not.toHaveBeenCalled();
    });

    it('delegates the registry fan-out for the item it finds', async () => {
      const a = setup();
      a.prisma.mediaItem.findUnique.mockResolvedValue(photo);
      await a.service.enqueueForStorageObject('obj-1');
      expect(a.upload.enqueueUploadEnrichment).toHaveBeenCalledWith(photo);
    });
  });
});

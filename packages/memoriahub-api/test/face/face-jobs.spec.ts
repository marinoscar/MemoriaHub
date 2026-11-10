import { FaceJobs } from '../../src/face/host/face-jobs.js';
import { FaceBackfillService } from '../../src/face/face-backfill.service.js';
import { VideoFaceDetectionHandler } from '../../src/face/video-face-detection.handler.js';
import { FakeMemoriahubJobs } from '../../src/testing/index.js';

describe('FaceJobs', () => {
  it('queues a media-item job about the item, with the circle in the payload', async () => {
    const jobs = new FakeMemoriahubJobs();
    const face = new FaceJobs(jobs);

    const { id } = await face.enqueue({ type: 'face_detection', mediaItemId: 'item-1', circleId: 'circle-1', reason: 'upload' });

    const row = jobs.jobs.find((r) => r.id === id)!;
    expect(row).toMatchObject({
      type: 'face_detection',
      subjectType: 'media_item',
      subjectId: 'item-1',
      payload: { circleId: 'circle-1' },
    });
  });

  it('queues a circle sweep about the circle and skips the dedup when asked', async () => {
    const jobs = new FakeMemoriahubJobs();
    const face = new FaceJobs(jobs);

    await face.enqueue({ type: 'face_auto_archive_sweep', circleId: 'circle-1', reason: 'backfill', skipDedup: true });
    await face.enqueue({ type: 'face_auto_archive_sweep', circleId: 'circle-1', reason: 'backfill', skipDedup: true });

    expect(jobs.jobs.filter((r) => r.type === 'face_auto_archive_sweep')).toHaveLength(2);
    expect(jobs.jobs[0]).toMatchObject({ subjectType: 'circle', subjectId: 'circle-1' });
  });

  it('names the circles that already have an active sweep', async () => {
    const jobs = new FakeMemoriahubJobs();
    const face = new FaceJobs(jobs);
    await face.enqueue({ type: 'face_auto_archive_sweep', circleId: 'circle-1', reason: 'backfill', skipDedup: true });

    const busy = await face.circlesWithActive('face_auto_archive_sweep', ['circle-1', 'circle-2']);

    expect([...busy]).toEqual(['circle-1']);
    expect((await face.circlesWithActive('face_auto_archive_sweep', [])).size).toBe(0);
  });

  it('records the provider and model a job ran on', async () => {
    const jobs = new FakeMemoriahubJobs();

    await new FaceJobs(jobs).recordModel('job-9', 'compreface', 'mobilenet');

    expect(jobs.providers.get('job-9')).toEqual({ provider: 'compreface', model: 'mobilenet' });
  });
});

describe('FaceBackfillService.autoArchiveBackfillAllCircles', () => {
  it('queues one sweep per circle with archived faces and skips a circle already being swept', async () => {
    const queued: Array<Record<string, unknown>> = [];
    const prisma = {
      face: {
        groupBy: async () => [
          { circleId: 'circle-1', _count: 4 },
          { circleId: 'circle-2', _count: 1 },
          { circleId: 'circle-3', _count: 0 },
        ],
      },
    };
    const jobs = {
      circlesWithActive: async () => new Set(['circle-2']),
      enqueue: async (input: Record<string, unknown>) => {
        queued.push(input);
        return { id: 'job-1' };
      },
    };

    const service = new FaceBackfillService(prisma as never, jobs as never, {} as never);
    const result = await service.autoArchiveBackfillAllCircles();

    expect(result).toEqual({ enqueued: 1, circles: 2 });
    expect(queued).toEqual([
      { type: 'face_auto_archive_sweep', mediaItemId: null, circleId: 'circle-1', reason: 'backfill', priority: 100, skipDedup: true },
    ]);
  });
});

describe('VideoFaceDetectionHandler profile', () => {
  const build = (options?: { videoJobTimeoutMs?: number }) =>
    new VideoFaceDetectionHandler({} as never, {} as never, {} as never, options);

  it('defaults to a twenty minute budget and three attempts', () => {
    expect(build().profile).toEqual({ maxRuntimeMs: 1_200_000, maxAttempts: 3 });
  });

  it('takes the budget the host configured', () => {
    expect(build({ videoJobTimeoutMs: 60_000 }).profile).toEqual({ maxRuntimeMs: 60_000, maxAttempts: 3 });
  });
});

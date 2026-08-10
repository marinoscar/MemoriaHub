import { JobReason } from '@prisma/client';
import { LocationGroupRebuildService } from './location-group-rebuild.service';

describe('LocationGroupRebuildService', () => {
  let enqueue: jest.Mock;
  let service: LocationGroupRebuildService;

  beforeEach(() => {
    enqueue = jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' });
    service = new LocationGroupRebuildService({ enqueue } as never);
  });

  it('enqueues a global location_group_rebuild job at background priority', async () => {
    await service.enqueueRebuild();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0][0];

    expect(arg.type).toBe('location_group_rebuild');
    expect(arg.mediaItemId).toBeNull();
    expect(arg.circleId).toBeNull();
    expect(arg.priority).toBe(100);
    expect(arg.reason).toBe(JobReason.backfill);
  });

  // ---------------------------------------------------------------------------
  // ⚠️ THE TRAP. Assert the flag's ABSENCE, not merely that it is falsy.
  //
  // EnrichmentJobService.enqueue dedups global jobs on (type, mediaItemId IS
  // NULL). That default is exactly RIGHT here — a burst of admin edits must
  // collapse into ONE rebuild — and exactly WRONG for
  // LocationInferenceBackfillService, which enqueues one global job per circle
  // and therefore MUST pass skipDedup: true. Same mechanism, opposite
  // requirement: copying the flag across from that call site would make every
  // circle but the first silently lose its job.
  // ---------------------------------------------------------------------------
  it('does NOT pass skipDedup — the default dedup is the desired behavior', async () => {
    await service.enqueueRebuild();

    const arg = enqueue.mock.calls[0][0];
    expect(arg).not.toHaveProperty('skipDedup');
    expect(Object.keys(arg)).not.toContain('skipDedup');
  });

  it('does NOT pass skipDedup for a scoped rebuild either', async () => {
    await service.enqueueRebuild({ circleId: 'circle-1', groupIds: ['g1', 'g2'] });

    const arg = enqueue.mock.calls[0][0];
    expect(arg).not.toHaveProperty('skipDedup');
  });

  it('forwards the payload verbatim', async () => {
    await service.enqueueRebuild({ circleId: 'circle-1', groupIds: ['g1'] });

    expect(enqueue.mock.calls[0][0].payload).toEqual({
      circleId: 'circle-1',
      groupIds: ['g1'],
    });
  });

  it('sends an empty payload when called with no arguments', async () => {
    await service.enqueueRebuild();
    expect(enqueue.mock.calls[0][0].payload).toEqual({});
  });

  it('returns the enqueued job', async () => {
    const job = await service.enqueueRebuild();
    expect(job).toEqual({ id: 'job-1', status: 'pending' });
  });
});

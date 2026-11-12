import { ENRICHMENT_FAILED_EVENT_KEY, EnrichmentFailureNotificationListener } from './enrichment-failure-notification.listener.js';

type Settled = Parameters<EnrichmentFailureNotificationListener['handleJobSettled']>[0];

const event = (over: Partial<Settled> = {}): Settled => ({
  jobId: 'job-1',
  type: 'auto_tagging',
  status: 'failed',
  subjectType: null,
  subjectId: null,
  payload: {},
  lastError: 'boom',
  ...over,
});

function build(admins: readonly string[] | Error = ['admin-1', 'admin-2']) {
  const jobs = { onSettled: jest.fn() };
  const identity: { adminUserIds?: jest.Mock } = {
    adminUserIds: jest.fn(async () => {
      if (admins instanceof Error) throw admins;
      return admins;
    }),
  };
  const notify = { notifyCounted: jest.fn() };
  const listener = new EnrichmentFailureNotificationListener(jobs as never, identity as never, notify as never);
  return { jobs, identity, notify, listener };
}

describe('EnrichmentFailureNotificationListener (epic #240, issue #247; RETRO-J10)', () => {
  it('keeps the permanent event key and subscribes through the jobs port', () => {
    const { jobs, listener } = build();
    expect(ENRICHMENT_FAILED_EVENT_KEY).toBe('media.enrichment_failed');
    listener.onModuleInit();
    expect(jobs.onSettled).toHaveBeenCalledTimes(1);
  });

  it('a succeeded settlement raises nothing and asks nobody', async () => {
    const { listener, notify, identity } = build();
    await listener.handleJobSettled(event({ status: 'succeeded' }));
    expect(notify.notifyCounted).not.toHaveBeenCalled();
    expect(identity.adminUserIds).not.toHaveBeenCalled();
  });

  it('raises ONE counted row per administrator, partitioned by job type with no window', async () => {
    const { listener, notify } = build();
    await listener.handleJobSettled(event());
    expect(notify.notifyCounted).toHaveBeenCalledTimes(2);
    expect(notify.notifyCounted.mock.calls.map((c) => c[1]).sort()).toEqual(['admin-1', 'admin-2']);
    for (const [key, , data, options] of notify.notifyCounted.mock.calls) {
      expect(key).toBe('media.enrichment_failed');
      expect(data).toEqual({ jobType: 'auto_tagging', lastError: 'boom' });
      expect(options).toEqual({ scopeId: null, match: { jobType: 'auto_tagging' } });
      expect(options.windowMs).toBeUndefined();
    }
  });

  it('two job types are two partitions', async () => {
    const { listener, notify } = build(['admin-1']);
    await listener.handleJobSettled(event({ type: 'auto_tagging' }));
    await listener.handleJobSettled(event({ type: 'geocode' }));
    expect(notify.notifyCounted.mock.calls.map((c) => c[3].match.jobType)).toEqual(['auto_tagging', 'geocode']);
  });

  it('truncates lastError to 500 characters and passes a null through', async () => {
    const { listener, notify } = build(['admin-1']);
    await listener.handleJobSettled(event({ lastError: 'x'.repeat(1000) }));
    await listener.handleJobSettled(event({ lastError: null }));
    expect(notify.notifyCounted.mock.calls[0]![2].lastError).toHaveLength(500);
    expect(notify.notifyCounted.mock.calls[1]![2]).toHaveProperty('lastError', null);
  });

  it('caches the administrator ids across settlements', async () => {
    const { listener, identity } = build();
    await listener.handleJobSettled(event({ jobId: 'a' }));
    await listener.handleJobSettled(event({ jobId: 'b' }));
    expect(identity.adminUserIds).toHaveBeenCalledTimes(1);
  });

  it('raises nothing when there are no administrators or the host cannot name them', async () => {
    const none = build([]);
    await none.listener.handleJobSettled(event());
    expect(none.notify.notifyCounted).not.toHaveBeenCalled();

    const unbound = build();
    delete unbound.identity.adminUserIds;
    await unbound.listener.handleJobSettled(event());
    expect(unbound.notify.notifyCounted).not.toHaveBeenCalled();
  });

  it('never throws when the administrator lookup fails', async () => {
    const { listener, notify } = build(new Error('db down'));
    await expect(listener.handleJobSettled(event())).resolves.toBeUndefined();
    expect(notify.notifyCounted).not.toHaveBeenCalled();
  });
});

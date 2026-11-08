import { SharingNotifierAdapter } from './sharing-notifier.adapter';

// =============================================================================
// SharingNotifierAdapter (RETRO-I1, #562)
// =============================================================================
//
// The adapter between the platform sharing slice and the platform dispatcher.
// Asserted: the absolute URLs the slice leaves to the app (sign-in, and the
// record for a root-relative `path`), the actor's time zone as the render hint,
// and that a failed zone read never blocks the notification.
// =============================================================================

const KEY = 'sharing.shared_with_you';

function build(appUrl: string | undefined = 'https://app.example.test/', zone: string | null | Error = null) {
  const notifications = {
    notify: jest.fn().mockResolvedValue(undefined),
    notifyAddress: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn(() => appUrl) };
  const settings = {
    resolveUserTimeZone: jest.fn(async () => {
      if (zone instanceof Error) throw zone;
      return zone;
    }),
  };

  return {
    adapter: new SharingNotifierAdapter(notifications as never, config as never, settings as never),
    notifications,
    settings,
  };
}

const share = (overrides: Record<string, unknown> = {}) => ({
  resourceType: 'album',
  resourceId: 'a-1',
  role: 'viewer',
  title: 'Summer trip',
  path: '/albums/a-1',
  sharedBy: 'Person A',
  ...overrides,
});

describe('SharingNotifierAdapter', () => {
  it('adds the record URL and the sign-in URL, rooted at APP_URL without a trailing slash', async () => {
    const { adapter, notifications } = build();

    await adapter.notify(KEY, 'user-1', share());

    expect(notifications.notify).toHaveBeenCalledWith(
      KEY,
      'user-1',
      { ...share(), openUrl: 'https://app.example.test/albums/a-1', signInUrl: 'https://app.example.test/login' },
      undefined,
    );
  });

  it('adds no URL without APP_URL, and no record URL for a path that is not root-relative', async () => {
    const none = build('');
    await none.adapter.notify(KEY, 'user-1', share());
    expect(none.notifications.notify).toHaveBeenCalledWith(KEY, 'user-1', share(), undefined);

    const odd = build();
    await odd.adapter.notify(KEY, 'user-1', share({ path: '//elsewhere.test/x' }));
    expect(odd.notifications.notify.mock.calls[0][2]).not.toHaveProperty('openUrl');
  });

  it("passes the actor's time zone as the render hint", async () => {
    const { adapter, notifications, settings } = build(undefined, 'America/Costa_Rica');

    await adapter.notifyAddress('groups.invitation', 'a@example.test', { groupName: 'Org Alpha' }, { actorUserId: 'u-2' });

    expect(settings.resolveUserTimeZone).toHaveBeenCalledWith('u-2');
    expect(notifications.notifyAddress).toHaveBeenCalledWith(
      'groups.invitation',
      'a@example.test',
      { groupName: 'Org Alpha', signInUrl: 'https://app.example.test/login' },
      { timeZone: 'America/Costa_Rica' },
    );
  });

  it('still notifies, without a zone, when the zone read fails or there is no actor', async () => {
    const failing = build(undefined, new Error('settings unavailable'));
    await failing.adapter.notify(KEY, 'user-1', share(), { actorUserId: 'u-2' });
    expect(failing.notifications.notify.mock.calls[0][3]).toBeUndefined();

    const noActor = build(undefined, 'UTC');
    await noActor.adapter.notify(KEY, 'user-1', share(), { actorUserId: null });
    expect(noActor.settings.resolveUserTimeZone).not.toHaveBeenCalled();
  });
});

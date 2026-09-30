import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { buildServiceWorkerOptions } from '../../../pwa/service-worker';

// -----------------------------------------------------------------------------
// notificationclick, push and pushsubscriptionchange (issue #482,
// epic #481) — the parts of `sw.ts` that CAN be executed under jsdom, with
// their side-effecting dependencies (workbox, and the real
// `self.clients`/`self.registration`) replaced.
//
// The suite below (`describe('service worker build output', ...)`) cannot
// import `src/sw.ts` at all: unmocked, it calls `clientsClaim()` and registers
// routes against workbox internals that assume a real
// `ServiceWorkerGlobalScope`, which jsdom does not provide. Mocking
// `workbox-core`/`workbox-precaching`/`workbox-routing` to no-ops removes
// every one of those calls' real side effects, which is enough for the module
// to load — the three handlers it registers with `self.addEventListener` are
// then just plain functions, captured below by spying on `addEventListener`
// and invoked directly with hand-built fake events, bypassing jsdom's lack of
// real `NotificationEvent`/`PushEvent`/`PushSubscriptionChangeEvent` types
// entirely.
//
// ONE shared import, ONE shared spy —
//
// ES module imports are cached, so a SECOND `await import('../../sw')` in a
// later `beforeAll` would resolve without re-running the module body, and
// that block's own `addEventListenerSpy.mock.calls` would come back empty —
// its "did not register a listener" checks would throw not because `sw.ts` is
// broken, but because the test harness never gave it a second chance to
// register anything. That is why every handler exercised in this file is
// captured from the SAME import, in the SAME `beforeAll`, off the SAME spy.
// -----------------------------------------------------------------------------

vi.mock('workbox-core', () => ({ clientsClaim: vi.fn() }));
vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => vi.fn()),
  precacheAndRoute: vi.fn(),
}));
vi.mock('workbox-routing', () => ({
  NavigationRoute: vi.fn(),
  registerRoute: vi.fn(),
}));

// =============================================================================
// The service worker  (issue #482, epic #481)
// =============================================================================
//
// WHAT THIS SUITE CAN AND CANNOT DO
//
// It cannot execute `src/sw.ts`. That module is written for a
// ServiceWorkerGlobalScope — it calls `clientsClaim()` and registers fetch
// routes at import time, against a `self` jsdom does not provide — so merely
// importing it here would throw, and a mock complete enough to make it run
// would be a mock of the thing under test. The genuinely load-bearing
// behaviour (does a `push` handler fire, does `showNotification` work on
// Android) is a real-device question that no unit test settles.
//
// What IS checkable, and is checked here, are the two build-time invariants
// that would silently break the feature and that nothing else enforces:
//
//   1. `sw.js` is emitted at the ROOT of the build output. A service worker's
//      scope is capped by the directory it is served from, so a worker at
//      `/assets/sw.js` can only ever control `/assets/*` — it would register
//      without error, then never control a single page of the app, and never
//      be able to show a notification for one.
//
//   2. NOTHING under `/api` enters the precache. Cache Storage is origin-scoped
//      and survives logout, and it is not partitioned per account, so an
//      authenticated JSON response cached here is readable by the next person
//      to sign in on a shared device. Today `dist/` simply contains no API
//      responses — but that is a property of what the build emits, not a rule
//      anyone wrote down, so it is asserted rather than assumed.
//
// The build below is a real `vite build` into a temporary directory, which
// takes ~1.5s. That is affordable precisely because it is ONE build shared by
// every case in the file — do not add a second.
// =============================================================================

const webRoot = resolve(__dirname, '..', '..', '..');

let outDir: string;
/** Every file emitted at the top level of the build output. */
let rootEntries: string[];
/** The bundled service worker's source text. */
let swSource: string;
/** Every URL in the injected precache manifest, in build order. */
let precachedUrls: string[];

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'web-sw-build-'));

  await build({
    root: webRoot,
    // The suite asserts on the emitted files, never on the log, and a full
    // Rollup report in the middle of a test run is just noise.
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      // Sourcemaps are ~4x the byte volume of this build and nothing here
      // reads them.
      sourcemap: false,
    },
  });

  rootEntries = readdirSync(outDir);
  swSource = readFileSync(join(outDir, 'sw.js'), 'utf-8');
  // vite-plugin-pwa substitutes `self.__WB_MANIFEST` with a literal array of
  // `{ revision, url }` records, so the emitted worker carries its own precache
  // list in plain text. Reading it back is the only way to see what the build
  // ACTUALLY decided to cache, as opposed to what the glob patterns intended.
  precachedUrls = [...swSource.matchAll(/"url":\s*"([^"]*)"/g)].map((match) => match[1]);
}, 120_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('service worker build output', () => {
  it('emits sw.js at the root of the output, which is what gives it root scope', () => {
    // A worker served from a subdirectory is scope-capped to that
    // subdirectory. `/sw.js` is the only path that can control `/`.
    expect(rootEntries).toContain('sw.js');
    expect(existsSync(join(outDir, 'assets', 'sw.js'))).toBe(false);
  });

  it('precaches nothing under /api', () => {
    // Both spellings: a root-relative `api/...` entry (what a file emitted into
    // `dist/api/` would look like) and an absolute `/api/...` one.
    const leaked = precachedUrls.filter(
      (url) => /^\/?api\//.test(url) || url.includes('/api/'),
    );

    expect(
      leaked,
      `precache entries under /api — authenticated data in Cache Storage outlives logout: ${leaked.join(', ')}`,
    ).toEqual([]);
  });

  it('precaches the app shell it needs to load offline', () => {
    // The point of the precache. `index.html` is what the NavigationRoute in
    // `sw.ts` serves for every client-side route.
    expect(precachedUrls).toContain('index.html');
    expect(precachedUrls.some((url) => url.endsWith('.js'))).toBe(true);
    expect(precachedUrls.some((url) => url.endsWith('.css'))).toBe(true);
    expect(precachedUrls).toContain('manifest.webmanifest');
  });

  it('emits the generated web manifest, linked exactly once from index.html', () => {
    // It replaced the static `public/site.webmanifest`. Without it the app is
    // not installable, and on iOS that removes Web Push from every iPhone.
    expect(rootEntries).toContain('manifest.webmanifest');
    expect(rootEntries).not.toContain('site.webmanifest');

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.webmanifest'), 'utf-8'));
    expect(manifest.display).toBe('standalone');

    // VitePWA injects the link itself; a hand-written one would duplicate it.
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html.match(/<link rel="manifest"[^>]*>/g)).toEqual([
      expect.stringContaining('href="/manifest.webmanifest"'),
    ]);
  });

  it('registers the worker from the React tree, not from index.html', () => {
    // Registration lives in `components/pwa/UpdatePrompt.tsx` (`useRegisterSW`),
    // so `injectRegister` is `null` and no `registerSW.js` is injected. Both
    // halves are asserted: an app that never
    // registers its worker has no notifications on Android at all, and one that
    // registers TWICE has a hook whose state does not describe the registration
    // the user is on.
    const html = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(html).not.toMatch(/registerSW\.js/);

    const bundled = readdirSync(join(outDir, 'assets'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(outDir, 'assets', file), 'utf-8'));

    expect(
      bundled.some((source) => source.includes('serviceWorker.register')),
      'no emitted chunk registers a service worker — the PWA is inert',
    ).toBe(true);
  });
});

describe('buildServiceWorkerOptions', () => {
  it('uses injectManifest so the worker can host the push handlers', () => {
    // `generateSW` cannot host `push` / `notificationclick` /
    // `pushsubscriptionchange`, which on Android Chrome are the only way a
    // notification can be shown at all. Switching this back would leave the
    // build green and the feature dead on that platform.
    expect(buildServiceWorkerOptions().strategies).toBe('injectManifest');
  });

  it('points at a service worker source file that exists', () => {
    const { srcDir, filename } = buildServiceWorkerOptions();

    expect(filename).toBe('sw.ts');
    expect(existsSync(resolve(webRoot, srcDir!, filename!))).toBe(true);
  });

  it('waits for the page rather than activating under a live session', () => {
    // `prompt`, not `autoUpdate`: an activation mid-session leaves the loaded
    // page requesting asset filenames the new revision has rotated away, and
    // `autoUpdate`'s reload discards every unsaved form in the app. The UI half
    // that makes `prompt` reach the user is `components/pwa/UpdatePrompt.tsx`.
    expect(buildServiceWorkerOptions().registerType).toBe('prompt');
  });

  it('leaves registration to the React tree', () => {
    // `null`, not `'auto'`. With `'auto'` the plugin injects its
    // own `registerSW.js`, so the worker is registered a second time from a
    // script `useRegisterSW` cannot observe — and the update prompt then
    // reports on a registration that is not the live one.
    expect(buildServiceWorkerOptions().injectRegister).toBeNull();
  });

  it('serves the manifest and the worker from the dev server too', () => {
    // Without this, `sw.ts` is only ever exercised by a production build, and
    // DevTools' Application panel is blank against `npm run dev`.
    const { devOptions } = buildServiceWorkerOptions();

    expect(devOptions?.enabled).toBe(true);
    // ESM in dev: the un-bundled worker keeps its `workbox-*` imports, which a
    // classic worker cannot load.
    expect(devOptions?.type).toBe('module');
    // Without a dev navigateFallback the injection point becomes `[]` and
    // `createHandlerBoundToURL('/index.html')` throws `non-precached-url` on
    // activation — in dev only.
    expect(devOptions?.navigateFallback).toBe('index.html');
  });
});

describe('src/sw.ts', () => {
  const source = readFileSync(resolve(webRoot, 'src', 'sw.ts'), 'utf-8');

  it('denylists /api on the navigation route', () => {
    // Read the source rather than the bundle: the point is that the rule is
    // written down where a reviewer edits it.
    expect(source).toMatch(/denylist:\s*\[\s*\/\^\\\/api\\\/\//);
  });

  it('exposes the SKIP_WAITING handshake UpdatePrompt calls', () => {
    // Under `registerType: 'prompt'` a worker with no listener here can never
    // be told to activate, so it sits in `waiting` forever and users never
    // receive an update.
    expect(source).toMatch(/'SKIP_WAITING'/);
  });

  it('has no top-level skipWaiting (registerType prompt waits for the user)', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const skipCalls = [...code.matchAll(/skipWaiting\(\)/g)];
    // Exactly one call, inside the SKIP_WAITING message listener.
    expect(skipCalls).toHaveLength(1);
    expect(code).toMatch(/SKIP_WAITING'\)\s*\{\s*void self\.skipWaiting\(\)/);
  });

  it('never calls the API', () => {
    // The access token is memory-only and the refresh cookie is one-shot and
    // rotated, so a worker that fetched `/api` would spend the page's refresh
    // token and log the user out. There is no legitimate reason for this file
    // to name an API path outside a comment.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/fetch\s*\(/);
    expect(code).not.toMatch(/['"`]\/api\//);
  });
});

describe('sw.ts event handlers (push, notificationclick, pushsubscriptionchange, message)', () => {
  type Handler<E> = (event: E) => void;
  type WaitUntil = { waitUntil: (promise: Promise<unknown>) => void };
  type FakeClickEvent = WaitUntil & { notification: { close: () => void; data: unknown } };
  type FakePushEvent = WaitUntil & { data: { json: () => unknown } | undefined };
  type FakeChangeEvent = WaitUntil & {
    oldSubscription: { options?: { applicationServerKey?: unknown } } | null;
  };

  let clickHandler: Handler<FakeClickEvent>;
  let pushHandler: Handler<FakePushEvent>;
  let changeHandler: Handler<FakeChangeEvent>;
  let messageHandler: Handler<{ data: unknown }>;

  let clientsMatchAll: ReturnType<typeof vi.fn>;
  let clientsOpenWindow: ReturnType<typeof vi.fn>;
  let showNotification: ReturnType<typeof vi.fn>;
  let pushManagerSubscribe: ReturnType<typeof vi.fn>;
  let skipWaiting: ReturnType<typeof vi.fn>;

  const PAYLOAD = {
    id: 'notif-1',
    title: '3 duplicate groups ready to review',
    body: 'In Familia',
    link: '/duplicates',
    type: 'review_queue_duplicates',
    circleId: 'circle-1',
  };
  const EXPECTED_OPTIONS = {
    body: 'In Familia',
    tag: 'notif-1',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: {
      id: 'notif-1',
      link: '/duplicates',
      type: 'review_queue_duplicates',
      circleId: 'circle-1',
    },
  };

  beforeAll(async () => {
    clientsMatchAll = vi.fn();
    clientsOpenWindow = vi.fn();
    showNotification = vi.fn();
    pushManagerSubscribe = vi.fn();
    skipWaiting = vi.fn();

    // `self` in jsdom IS `window` — install what `sw.ts` reaches for beyond
    // the (mocked) workbox calls.
    const scope = self as unknown as Record<string, unknown>;
    scope.__WB_MANIFEST = [];
    scope.clients = { matchAll: clientsMatchAll, openWindow: clientsOpenWindow };
    scope.registration = { showNotification, pushManager: { subscribe: pushManagerSubscribe } };
    scope.skipWaiting = skipWaiting;

    // Capture the real listeners `sw.ts` registers at import time, from ONE
    // import off ONE spy (ES modules are cached — see the file header).
    const spy = vi.spyOn(self, 'addEventListener');
    await import('../../sw');
    const find = (type: string) => {
      const call = spy.mock.calls.find(([t]) => t === type);
      if (!call) throw new Error(`sw.ts did not register a ${type} listener`);
      return call[1] as never;
    };
    clickHandler = find('notificationclick');
    pushHandler = find('push');
    changeHandler = find('pushsubscriptionchange');
    messageHandler = find('message');
    spy.mockRestore();
  });

  beforeEach(() => {
    clientsMatchAll.mockReset().mockResolvedValue([]);
    clientsOpenWindow.mockReset().mockResolvedValue(undefined);
    showNotification.mockReset().mockResolvedValue(undefined);
    pushManagerSubscribe.mockReset().mockResolvedValue(undefined);
    skipWaiting.mockReset();
  });

  /** Invokes a handler with a fake event and returns the `waitUntil` promise (never rejecting). */
  function fire<E extends WaitUntil>(handler: Handler<E>, fields: Omit<E, 'waitUntil'>) {
    let waited: Promise<unknown> = Promise.resolve();
    handler({ ...fields, waitUntil: (p: Promise<unknown>) => (waited = p) } as E);
    return waited;
  }
  const firePush = (data: FakePushEvent['data']) => fire(pushHandler, { data });
  const fireClick = (data: unknown) => {
    const close = vi.fn();
    const settled = fire(clickHandler, { notification: { close, data } });
    return { close, settled };
  };
  const windowClient = (url: string, visible = false, focused = false) => ({
    url,
    visibilityState: visible ? 'visible' : 'hidden',
    focused,
    focus: vi.fn().mockResolvedValue(undefined),
    postMessage: vi.fn(),
  });

  describe('message', () => {
    it('activates the waiting worker only on SKIP_WAITING', () => {
      messageHandler({ data: { type: 'OTHER' } });
      messageHandler({ data: null });
      expect(skipWaiting).not.toHaveBeenCalled();

      messageHandler({ data: { type: 'SKIP_WAITING' } });
      expect(skipWaiting).toHaveBeenCalledTimes(1);
    });
  });

  describe('push: well-formed payload', () => {
    it('shows the notification with title/body/tag/icon/badge/data when no window is open', async () => {
      await firePush({ json: () => PAYLOAD });

      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(showNotification).toHaveBeenCalledWith(PAYLOAD.title, EXPECTED_OPTIONS);
    });

    it('ALWAYS shows it — even with a visible, focused client — and posts nothing to the page', async () => {
      // Suppressing a push for a focused tab is the "silent push" Chrome
      // penalises, and leaves the focused user with no alert at all.
      const focused = windowClient('http://localhost:3000/', true, true);
      clientsMatchAll.mockResolvedValue([focused]);

      await firePush({ json: () => PAYLOAD });

      expect(showNotification).toHaveBeenCalledWith(PAYLOAD.title, EXPECTED_OPTIONS);
      expect(focused.postMessage).not.toHaveBeenCalled();
    });

    it('honours an explicit tag and same-origin icon/badge from the payload', async () => {
      await firePush({
        json: () => ({ ...PAYLOAD, tag: 'dupes-circle-1', icon: '/icons/icon-512.png', badge: '/b.png' }),
      });

      expect(showNotification).toHaveBeenCalledWith(
        PAYLOAD.title,
        expect.objectContaining({ tag: 'dupes-circle-1', icon: '/icons/icon-512.png', badge: '/b.png' }),
      );
    });

    it('ignores an off-origin icon/badge and falls back to the app icons', async () => {
      await firePush({
        json: () => ({ ...PAYLOAD, icon: 'https://tracker.example/p.png', badge: '//evil/b.png' }),
      });

      expect(showNotification).toHaveBeenCalledWith(
        PAYLOAD.title,
        expect.objectContaining({ icon: '/icons/icon-192.png', badge: '/icons/badge-72.png' }),
      );
    });

    it('fills safe defaults for missing optional fields', async () => {
      await firePush({ json: () => ({ title: 'Hi' }) });

      expect(showNotification).toHaveBeenCalledWith('Hi', {
        body: '',
        tag: undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        data: { id: '', link: '/', type: null, circleId: null },
      });
    });
  });

  describe('push: malformed or missing payload — never silently skipped', () => {
    const FALLBACK = {
      body: 'You have a new notification',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'push-fallback',
    };

    it('shows the generic fallback when event.data.json() throws', async () => {
      await firePush({
        json: () => {
          throw new Error('not json');
        },
      });

      expect(showNotification).toHaveBeenCalledWith('New notification', FALLBACK);
      expect(clientsMatchAll).not.toHaveBeenCalled();
    });

    it('shows the generic fallback when event.data is missing', async () => {
      await firePush(undefined);
      expect(showNotification).toHaveBeenCalledWith('New notification', FALLBACK);
    });

    it('shows the generic fallback when the JSON is not an object', async () => {
      await firePush({ json: () => 'just a string' });
      expect(showNotification).toHaveBeenCalledWith('New notification', FALLBACK);
    });
  });

  describe('push: test payload (test: true)', () => {
    const TEST_PAYLOAD = {
      id: 'push-test-1',
      title: 'Test push',
      body: 'It works',
      link: '/settings',
      test: true,
    };

    it('shows the notification even with a focused client, then acks EVERY window client', async () => {
      const focused = windowClient('http://localhost:3000/settings', true, true);
      const background = windowClient('http://localhost:3000/');
      clientsMatchAll.mockResolvedValue([focused, background]);

      await firePush({ json: () => TEST_PAYLOAD });

      expect(clientsMatchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
      expect(showNotification).toHaveBeenCalledWith('Test push', {
        body: 'It works',
        tag: 'push-test-1',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        data: { id: '', link: '/settings', type: null, circleId: null, test: true },
      });
      for (const client of [focused, background]) {
        expect(client.postMessage).toHaveBeenCalledTimes(1);
        expect(client.postMessage).toHaveBeenCalledWith({
          type: 'push-test-received',
          id: 'push-test-1',
          receivedAt: expect.any(Number),
          shown: true,
          hadFocusedClient: true,
        });
      }
    });

    it('acks shown:false with the error when showNotification throws, without rejecting', async () => {
      const client = windowClient('http://localhost:3000/');
      clientsMatchAll.mockResolvedValue([client]);
      const error = new Error('no permission');
      error.name = 'TypeError';
      showNotification.mockRejectedValue(error);

      await expect(firePush({ json: () => TEST_PAYLOAD })).resolves.toBeUndefined();

      expect(client.postMessage).toHaveBeenCalledWith({
        type: 'push-test-received',
        id: 'push-test-1',
        receivedAt: expect.any(Number),
        shown: false,
        hadFocusedClient: false,
        error: 'TypeError: no permission',
      });
    });

    it('keeps acking the other clients when one postMessage throws', async () => {
      const broken = windowClient('http://localhost:3000/');
      broken.postMessage.mockImplementation(() => {
        throw new Error('detached');
      });
      const ok = windowClient('http://localhost:3000/');
      clientsMatchAll.mockResolvedValue([broken, ok]);

      await firePush({ json: () => TEST_PAYLOAD });

      expect(ok.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('notificationclick', () => {
    it('focuses the window already on the link path and posts the click to it', async () => {
      const other = windowClient('http://localhost:3000/albums');
      const matching = windowClient('http://localhost:3000/duplicates');
      clientsMatchAll.mockResolvedValue([other, matching]);

      const { close, settled } = fireClick({ id: 'n-1', link: '/duplicates', circleId: 'c-1' });
      await settled;

      expect(close).toHaveBeenCalledTimes(1);
      expect(clientsMatchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
      expect(matching.focus).toHaveBeenCalledTimes(1);
      expect(matching.postMessage).toHaveBeenCalledWith({
        type: 'notification-click',
        id: 'n-1',
        link: '/duplicates',
        circleId: 'c-1',
      });
      expect(other.focus).not.toHaveBeenCalled();
      expect(clientsOpenWindow).not.toHaveBeenCalled();
    });

    it('falls back to the first window when none is on the link path', async () => {
      const first = windowClient('http://localhost:3000/albums');
      const second = windowClient('http://localhost:3000/people');
      clientsMatchAll.mockResolvedValue([first, second]);

      const { settled } = fireClick({ id: 'n-2', link: '/bursts' });
      await settled;

      expect(first.postMessage).toHaveBeenCalledWith({
        type: 'notification-click',
        id: 'n-2',
        link: '/bursts',
        circleId: null,
      });
      expect(second.focus).not.toHaveBeenCalled();
    });

    it('cold-opens the link with ?n=<id> when no window is open', async () => {
      const { settled } = fireClick({ id: 'n-3', link: '/duplicates' });
      await settled;
      expect(clientsOpenWindow).toHaveBeenCalledWith('/duplicates?n=n-3');
    });

    it('carries the circle as &c=<circleId> on a cold open, URL-encoded', async () => {
      const { settled } = fireClick({ id: 'n-4', link: '/bursts', circleId: 'c 2' });
      await settled;
      expect(clientsOpenWindow).toHaveBeenCalledWith(
        `/bursts?n=n-4&c=${encodeURIComponent('c 2')}`,
      );
    });

    it('appends &n=<id> when the link already has a query string, URL-encoding the id', async () => {
      const { settled } = fireClick({ id: 'id with spaces', link: '/admin/settings/jobs?status=failed' });
      await settled;
      expect(clientsOpenWindow).toHaveBeenCalledWith(
        `/admin/settings/jobs?status=failed&n=${encodeURIComponent('id with spaces')}`,
      );
    });

    it.each([
      ['an absolute URL', 'https://evil.example.com/phish'],
      ['a protocol-relative URL', '//evil.example.com'],
      ['a backslash host', '/\\evil.example.com'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a bare relative path', 'duplicates'],
    ])('re-validates the link: %s falls back to "/"', async (_label, link) => {
      const { settled } = fireClick({ id: 'n-5', link });
      await settled;

      expect(clientsOpenWindow).toHaveBeenCalledWith('/?n=n-5');
      expect(clientsOpenWindow).not.toHaveBeenCalledWith(expect.stringContaining('evil'));
    });

    it('re-validates the link before posting it to an open page too', async () => {
      const client = windowClient('http://localhost:3000/');
      clientsMatchAll.mockResolvedValue([client]);

      const { settled } = fireClick({ id: 'n-6', link: '//evil.example.com' });
      await settled;

      expect(client.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'notification-click', link: '/' }),
      );
    });

    it.each([[undefined], [null], [{ id: 42, link: { not: 'a string' } }]])(
      'does not throw on missing or malformed data (%j)',
      async (data) => {
        const { close, settled } = fireClick(data);
        await expect(settled).resolves.toBeUndefined();
        expect(close).toHaveBeenCalledTimes(1);
        expect(clientsOpenWindow).toHaveBeenCalledWith('/?n=');
      },
    );
  });

  describe('pushsubscriptionchange', () => {
    const fireChange = (oldSubscription: FakeChangeEvent['oldSubscription']) =>
      fire(changeHandler, { oldSubscription });

    it('re-subscribes with the old applicationServerKey and tells open pages to re-sync', async () => {
      const client = windowClient('http://localhost:3000/');
      clientsMatchAll.mockResolvedValue([client]);
      const applicationServerKey = new Uint8Array([1, 2, 3]);

      await fireChange({ options: { applicationServerKey } });

      expect(pushManagerSubscribe).toHaveBeenCalledWith({
        applicationServerKey,
        userVisibleOnly: true,
      });
      expect(client.postMessage).toHaveBeenCalledWith({
        type: 'push-subscription-change',
        resubscribed: true,
      });
    });

    it('still tells pages to re-sync when there is no old subscription to reuse', async () => {
      const client = windowClient('http://localhost:3000/');
      clientsMatchAll.mockResolvedValue([client]);

      await expect(fireChange(null)).resolves.toBeUndefined();

      expect(pushManagerSubscribe).not.toHaveBeenCalled();
      expect(client.postMessage).toHaveBeenCalledWith({
        type: 'push-subscription-change',
        resubscribed: false,
      });
    });

    it('does not throw when subscribe rejects — best-effort, the page re-syncs', async () => {
      pushManagerSubscribe.mockRejectedValue(new Error('permission revoked'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(
        fireChange({ options: { applicationServerKey: new Uint8Array([1]) } }),
      ).resolves.toBeUndefined();
      warn.mockRestore();
    });
  });
});

import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { server } from './mocks/server';

// Set base URL for fetch
const BASE_URL = 'http://localhost:3000';
if (typeof global !== 'undefined') {
  (global as any).BASE_URL = BASE_URL;
}

// Mock location for testing
Object.defineProperty(window, 'location', {
  writable: true,
  value: {
    href: BASE_URL,
    origin: BASE_URL,
    protocol: 'http:',
    host: 'localhost:3000',
    hostname: 'localhost',
    port: '3000',
    pathname: '/',
    search: '',
    hash: '',
    reload: vi.fn(),
    assign: vi.fn(),
    replace: vi.fn(),
  },
});

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ---------------------------------------------------------------------------
// Notification / navigator.serviceWorker mocks (issue #482, epic #481)
//
// jsdom implements neither API. These give every test a NEUTRAL BASELINE —
// the least eventful thing each API can report — so PWA/push code that probes
// for them does not crash on `undefined`, and reinstall them FRESH before
// every test so one test's mutation never leaks into the next. A test that
// needs a specific state (permission 'denied', a rejecting getRegistration())
// just reassigns them: both are `configurable: true, writable: true`.
//   - `Notification.permission` is 'default'; `requestPermission()` resolves
//     'default' without prompting.
//   - `navigator.serviceWorker.getRegistration()` resolves `undefined` (no
//     worker yet); `.ready` resolves a registration whose
//     `showNotification`/`getNotifications`/`pushManager` are harmless spies.
// ---------------------------------------------------------------------------

function createDefaultNotificationMock() {
  const ctor = vi.fn(function (
    this: { onclick: (() => void) | null; close: () => void },
    _title: string,
    _options?: unknown,
  ) {
    this.onclick = null;
    this.close = vi.fn();
  });
  Object.assign(ctor, {
    permission: 'default' as NotificationPermission,
    requestPermission: vi.fn().mockResolvedValue('default' as NotificationPermission),
  });
  return ctor;
}

function createDefaultServiceWorkerRegistrationMock() {
  return {
    showNotification: vi.fn().mockResolvedValue(undefined),
    getNotifications: vi.fn().mockResolvedValue([]),
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockRejectedValue(new Error('push not supported in tests')),
    },
  };
}

function installNotificationMocks(): void {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: createDefaultNotificationMock(),
  });
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: {
      controller: null,
      getRegistration: vi.fn().mockResolvedValue(undefined),
      ready: Promise.resolve(createDefaultServiceWorkerRegistrationMock()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

installNotificationMocks();
beforeEach(() => {
  installNotificationMocks();
});

// Mock window.scrollTo
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock ResizeObserver as a class
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = ResizeObserverMock;

// Mock IntersectionObserver as a class
class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  root = null;
  rootMargin = '';
  thresholds = [];
}
global.IntersectionObserver = IntersectionObserverMock as any;

// Setup MSW server
beforeAll(() => {
  server.listen({
    onUnhandledRequest: 'warn' // Changed from 'error' to 'warn' for debugging
  });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

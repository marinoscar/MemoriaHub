/**
 * Shared harness for the shell binding tests (RETRO-F1, #571).
 *
 * The packaged shell surfaces read permissions through
 * `@marinoscar/platform-web/identity/headless`'s `usePermissions`, which falls
 * back to the PLATFORM HOST's `viewer` when no platform `AuthContext` is
 * mounted (the test wrapper mounts only the app's own `AuthContext`). They read
 * the rail's collapse preference through the host `api` (`GET /user-settings`).
 * `renderShell` therefore wraps the app's ordinary test providers in a
 * `PlatformHostProvider` whose viewer answers from the mock user's permissions.
 *
 * `setViewportWidth` evaluates the REAL `min-width` / `max-width` in each
 * compiled MUI query against `px` (issue #402's lesson: a helper that hard-codes
 * `matches` cannot tell a 600px gate from a 900px one).
 */
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import type { PlatformApiClient, PlatformWebHost } from '@marinoscar/platform-web/core';
import { mockAdminUser, mockUser, renderWithProviders, type MockUser } from './test-utils';

export function setViewportWidth(px: number): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const min = query.match(/min-width:\s*([\d.]+)px/);
      const max = query.match(/max-width:\s*([\d.]+)px/);
      let matches = !query.includes('prefers-');
      if (min) matches = matches && px >= parseFloat(min[1]);
      if (max) matches = matches && px <= parseFloat(max[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

export interface RenderShellOptions {
  route?: string;
  width?: number;
  admin?: boolean;
  user?: MockUser;
  /** What `GET /user-settings` answers (the rail's collapse preference). */
  userSettings?: Record<string, unknown>;
}

export function createShellTestHost(user: MockUser, userSettings: Record<string, unknown> = {}) {
  const api: PlatformApiClient = {
    get: vi.fn(async () => userSettings) as unknown as PlatformApiClient['get'],
    post: vi.fn(async () => ({})) as unknown as PlatformApiClient['post'],
    put: vi.fn(async () => ({})) as unknown as PlatformApiClient['put'],
    patch: vi.fn(async () => ({})) as unknown as PlatformApiClient['patch'],
    delete: vi.fn(async () => ({})) as unknown as PlatformApiClient['delete'],
  };
  const host: PlatformWebHost = {
    api,
    viewer: {
      userId: user.id,
      hasPermission: (permission: string) => user.permissions.includes(permission),
      isFeatureEnabled: () => false,
    },
  };
  return host;
}

export function renderShell(ui: ReactElement, options: RenderShellOptions = {}) {
  const user = options.user ?? (options.admin ? mockAdminUser : mockUser);
  setViewportWidth(options.width ?? 1280);
  const host = createShellTestHost(user, options.userSettings);
  const view = renderWithProviders(<PlatformHostProvider host={host}>{ui}</PlatformHostProvider>, {
    wrapperOptions: { route: options.route ?? '/', user },
  });
  return { ...view, host };
}

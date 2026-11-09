/**
 * Wraps a tree in a `PlatformHostProvider` whose API client is the app's REAL
 * `appPlatformApi` (so MSW handlers answer the packaged hooks exactly as they
 * answer the app's own services) and whose viewer is a fixed permission set.
 * For components that read the platform host (`@marinoscar/platform-web/android-app`'s
 * hooks, RETRO-D5) but are rendered without the full app shell.
 */
import type { ReactElement } from 'react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import type { PlatformWebHost } from '@marinoscar/platform-web/core';

import { appPlatformApi } from '../../platform/platformHost';

export function withAppHost(ui: ReactElement, permissions: readonly string[] = []): ReactElement {
  const host: PlatformWebHost = {
    api: appPlatformApi,
    viewer: {
      userId: 'test-user',
      hasPermission: (permission: string) => permissions.includes(permission),
      isFeatureEnabled: () => false,
    },
  };
  return <PlatformHostProvider host={host}>{ui}</PlatformHostProvider>;
}

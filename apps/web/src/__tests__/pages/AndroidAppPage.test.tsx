/**
 * Admin → Settings → Android app (`/admin/settings/android`): MemoriaHub's binding of the platform
 * page (RETRO-D5, #586). The page itself is tested in its package; this proves the binding reads
 * MemoriaHub's API through the app's platform host: the trusted keys, the apps the Media Sync device
 * source reports, the assetlinks preview and the releases, with writes gated on
 * `system_settings:write` exactly as the API enforces.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import { server } from '../mocks/server';
import { render, flushPendingAsyncWork } from '../utils/test-utils';
import { withAppHost } from '../utils/app-host';
import AndroidAppPage from '../../platform/android-app/AndroidAppPage';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');
const PKG = 'memoriahub.marin.cr';

function serveAdmin() {
  server.use(
    http.get('*/api/admin/android-app', () =>
      HttpResponse.json({
        data: {
          trustedApps: [{ packageName: PKG, sha256: SHA }],
          reportedApps: [
            { packageName: `${PKG}.debug`, sha256: SHA, deviceCount: 2, lastSeenAt: null, trusted: false },
          ],
          assetLinks: [
            {
              relation: ['delegate_permission/common.handle_all_urls'],
              target: { namespace: 'android_app', package_name: PKG, sha256_cert_fingerprints: [SHA] },
            },
          ],
          pushSubscriptions: { androidApp: 0, browser: 1, androidAppUsers: 0 },
        },
      }),
    ),
    http.get('*/api/admin/android-app/releases', () =>
      HttpResponse.json({
        data: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            packageName: PKG,
            versionName: '2.1.0',
            versionCode: 110,
            fileSha256: 'a'.repeat(64),
            sizeBytes: '10485760',
            notes: null,
            createdAt: '2026-10-01T00:00:00.000Z',
            signingSha256: SHA,
            isCurrent: true,
            storageProvider: 's3',
            uploadedBy: null,
          },
        ],
      }),
    ),
  );
}

afterEach(async () => {
  await flushPendingAsyncWork();
});

describe('AndroidAppPage (platform binding)', () => {
  it('shows the trusted keys, the reported apps, the assetlinks preview and the releases', async () => {
    serveAdmin();
    render(withAppHost(<AndroidAppPage />, ['system_settings:read', 'system_settings:write']));

    expect(await screen.findByRole('heading', { level: 1, name: 'Android app' })).toBeInTheDocument();
    const trusted = await screen.findByRole('list', { name: 'Trusted apps' });
    expect(within(trusted).getByText(PKG)).toBeInTheDocument();
    const reported = await screen.findByRole('list', { name: 'Reported apps' });
    expect(within(reported).getByText(`${PKG}.debug (2 devices)`)).toBeInTheDocument();
    expect(screen.getByTestId('assetlinks-preview')).toHaveTextContent('delegate_permission/common.handle_all_urls');
    const releases = await screen.findByRole('list', { name: 'Releases' });
    expect(within(releases).getByText(/2\.1\.0 \(110\)/)).toBeInTheDocument();
  });

  it('is read-only without system_settings:write', async () => {
    serveAdmin();
    render(withAppHost(<AndroidAppPage />, ['system_settings:read']));

    expect(await screen.findByText(/You can view these settings/)).toBeInTheDocument();
  });
});

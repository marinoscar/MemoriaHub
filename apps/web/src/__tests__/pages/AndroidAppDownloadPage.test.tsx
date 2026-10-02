/** `/settings/android-app` and DownloadApkButton (issue #515). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../mocks/server';
import { render, mockUser, mockAdminUser, flushPendingAsyncWork } from '../utils/test-utils';
import AndroidAppDownloadPage, { NO_RELEASE_MESSAGE } from '../../pages/AndroidAppDownloadPage';
import { DownloadApkButton } from '../../components/settings/androidApp/DownloadApkButton';
import { downloadNavigator } from '../../services/androidApp';
import { captureTwaLaunch } from '../../utils/twa';
import { makeRelease } from '../fixtures/mediaSync';

const release = makeRelease();

function serveRelease() {
  server.use(http.get('*/api/android-app/releases/latest', () => HttpResponse.json({ data: release })));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(async () => {
  await flushPendingAsyncWork();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('DownloadApkButton', () => {
  it('mints a download link, then navigates to it (never fetches the APK)', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`*/api/android-app/releases/${release.id}/download-link`, () => {
        calls.push('download-link');
        return HttpResponse.json({ data: { url: '/api/android-app/download/tok123', expiresAt: '2026-10-02T00:10:00Z' } });
      }),
    );
    const assign = vi.spyOn(downloadNavigator, 'assign').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<DownloadApkButton release={release} />);
    await userEvent.click(screen.getByRole('button', { name: /download apk 2\.1\.0/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/android-app/download/tok123'));
    expect(calls).toEqual(['download-link']);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/android-app/download/'))).toBe(false);
  });

  it('shows an error when the link cannot be minted', async () => {
    server.use(
      http.post(`*/api/android-app/releases/${release.id}/download-link`, () =>
        HttpResponse.json({ message: 'Release not found' }, { status: 404 }),
      ),
    );
    const assign = vi.spyOn(downloadNavigator, 'assign').mockImplementation(() => undefined);

    render(<DownloadApkButton release={release} />);
    await userEvent.click(screen.getByRole('button', { name: /download apk/i }));

    expect(await screen.findByText('Release not found')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('AndroidAppDownloadPage', () => {
  it('shows the no-release state without an admin link for a regular user', async () => {
    render(<AndroidAppDownloadPage />, { wrapperOptions: { user: mockUser } });
    expect(await screen.findByTestId('no-release')).toHaveTextContent(NO_RELEASE_MESSAGE);
    expect(screen.queryByRole('link', { name: /publish a release/i })).not.toBeInTheDocument();
  });

  it('links admins to the releases admin page when nothing is published', async () => {
    render(<AndroidAppDownloadPage />, { wrapperOptions: { user: mockAdminUser } });
    const link = await screen.findByRole('link', { name: /publish a release/i });
    expect(link).toHaveAttribute('href', '/admin/settings/android');
  });

  it('shows the release, checksum, install steps and the legacy-app note', async () => {
    serveRelease();
    render(<AndroidAppDownloadPage />);

    expect(await screen.findByRole('heading', { name: 'Version 2.1.0' })).toBeInTheDocument();
    expect(screen.getByText(/15\.0 MB · build 110/)).toBeInTheDocument();
    expect(screen.getByText('Faster uploads.')).toBeInTheDocument();
    expect(screen.getByTestId('release-sha256')).toHaveTextContent('a'.repeat(64));
    expect(screen.getByTestId('legacy-app-step')).toHaveTextContent('cr.marin.memoriahub');
    expect(screen.getByTestId('server-origin')).toHaveTextContent(window.location.origin);
    expect(screen.getByRole('button', { name: /download apk 2\.1\.0/i })).toBeInTheDocument();
    // Outside the TWA there is no installed-version verdict.
    expect(screen.queryByTestId('installed-up-to-date')).not.toBeInTheDocument();
    expect(screen.queryByTestId('installed-update-available')).not.toBeInTheDocument();
  });

  it("says \"You're up to date\" inside the TWA when the installed build is current", async () => {
    serveRelease();
    captureTwaLaunch('?source=twa&appVersion=2.1.0&appVersionCode=110');
    render(<AndroidAppDownloadPage />);
    expect(await screen.findByTestId('installed-up-to-date')).toHaveTextContent("You're up to date (2.1.0)");
  });

  it('says "Update available" inside the TWA when the installed build is older', async () => {
    serveRelease();
    captureTwaLaunch('?source=twa&appVersion=2.0.0&appVersionCode=100');
    render(<AndroidAppDownloadPage />);
    expect(await screen.findByTestId('installed-update-available')).toHaveTextContent(/Update available: 2\.1\.0/);
  });
});

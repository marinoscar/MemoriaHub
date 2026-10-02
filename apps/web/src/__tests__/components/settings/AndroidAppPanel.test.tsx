/** The "Android app" card on /settings (issue #515). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { server } from '../../mocks/server';
import { render, mockUser, flushPendingAsyncWork, type MockUser } from '../../utils/test-utils';
import { AndroidAppPanel } from '../../../components/settings/AndroidAppPanel';
import { GET_APP_TITLE } from '../../../components/settings/mediaSync/GetAndroidApp';
import { DEVICE_ID, makeDevice } from '../../fixtures/mediaSync';

const reader: MockUser = { ...mockUser, permissions: [...mockUser.permissions, 'media:read'] };

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(async () => {
  await flushPendingAsyncWork();
  window.sessionStorage.clear();
});

describe('AndroidAppPanel', () => {
  it('offers the app when no phone is paired', async () => {
    render(<AndroidAppPanel />, { wrapperOptions: { user: reader } });
    expect(await screen.findByTestId('get-android-app')).toHaveTextContent(GET_APP_TITLE);
  });

  it('does not ask for devices without media:read', async () => {
    const calls = { count: 0 };
    server.use(
      http.get('*/api/media-sync/devices', () => {
        calls.count += 1;
        return HttpResponse.json({ data: [] });
      }),
    );
    render(<AndroidAppPanel />, { wrapperOptions: { user: mockUser } });
    expect(await screen.findByTestId('get-android-app')).toBeInTheDocument();
    await flushPendingAsyncWork();
    expect(calls.count).toBe(0);
  });

  it('lists paired phones with compact counts and a Manage link', async () => {
    server.use(http.get('*/api/media-sync/devices', () => HttpResponse.json({ data: [makeDevice()] })));
    render(<AndroidAppPanel />, { wrapperOptions: { user: reader } });

    const list = await screen.findByRole('list', { name: 'Paired phones' });
    expect(within(list).getByText('Pixel 9')).toBeInTheDocument();
    expect(screen.getByTestId(`panel-counts-${DEVICE_ID}`)).toHaveTextContent(/Synced 100 \/ Missing 24/);
    expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/settings/media-sync');
  });

  it('hides unpaired phones', async () => {
    server.use(
      http.get('*/api/media-sync/devices', () => HttpResponse.json({ data: [makeDevice({ status: 'revoked' })] })),
    );
    render(<AndroidAppPanel />, { wrapperOptions: { user: reader } });
    expect(await screen.findByTestId('get-android-app')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Paired phones' })).not.toBeInTheDocument();
  });

  it('shows the "on this phone" links only inside the app (TWA)', async () => {
    const { unmount } = render(<AndroidAppPanel />, { wrapperOptions: { user: reader } });
    await screen.findByTestId('get-android-app');
    expect(screen.queryByRole('link', { name: 'Open Media sync on this phone' })).not.toBeInTheDocument();
    unmount();

    window.sessionStorage.setItem('memoriahub.twa', '1');
    render(<AndroidAppPanel />, { wrapperOptions: { user: reader } });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Open Media sync on this phone' })).toHaveAttribute(
        'href',
        'memoriahub://media-sync',
      ),
    );
    expect(screen.getByRole('link', { name: 'Diagnostics on this phone' })).toHaveAttribute(
      'href',
      'memoriahub://media-sync/diagnostics',
    );
  });
});

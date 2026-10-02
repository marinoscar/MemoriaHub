/** AndroidUpdateBanner (issue #515): TWA-only, compares versionCodes, per-release dismissal. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server';
import { render, flushPendingAsyncWork } from '../../utils/test-utils';
import {
  ANDROID_UPDATE_DISMISSED_KEY,
  AndroidUpdateBanner,
} from '../../../components/common/AndroidUpdateBanner';
import { captureTwaLaunch } from '../../../utils/twa';
import { makeRelease } from '../../fixtures/mediaSync';

const release = makeRelease(); // versionCode 110, versionName 2.1.0

/** Serves the latest release and counts requests to it. */
function serveRelease(body = release) {
  const calls = { count: 0 };
  server.use(
    http.get('*/api/android-app/releases/latest', () => {
      calls.count += 1;
      return HttpResponse.json({ data: body });
    }),
  );
  return calls;
}

function launchFromApp(versionCode: number, versionName = '2.0.0') {
  captureTwaLaunch(`?source=twa&appVersion=${versionName}&appVersionCode=${versionCode}`);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.removeItem(ANDROID_UPDATE_DISMISSED_KEY);
});

afterEach(async () => {
  await flushPendingAsyncWork();
  window.sessionStorage.clear();
  window.localStorage.removeItem(ANDROID_UPDATE_DISMISSED_KEY);
});

describe('AndroidUpdateBanner', () => {
  it('renders nothing and asks nothing of the API in an ordinary browser tab', async () => {
    const calls = serveRelease();
    const { container } = render(<AndroidUpdateBanner />);
    await flushPendingAsyncWork();
    expect(container).toBeEmptyDOMElement();
    expect(calls.count).toBe(0);
  });

  it('shows the update banner when the installed build is older than the release', async () => {
    launchFromApp(100);
    serveRelease();
    render(<AndroidUpdateBanner />);

    const banner = await screen.findByTestId('android-update-banner');
    expect(banner).toHaveTextContent('2.1.0');
    expect(screen.getByRole('link', { name: 'Update' })).toHaveAttribute('href', '/settings/android-app');
  });

  it('stays hidden when the installed build is current', async () => {
    launchFromApp(110, '2.1.0');
    const calls = serveRelease();
    render(<AndroidUpdateBanner />);
    await waitFor(() => expect(calls.count).toBe(1));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
  });

  it('stays hidden when no release is published (404 NO_RELEASE)', async () => {
    launchFromApp(100);
    // The default handler answers 404 NO_RELEASE.
    const { container } = render(<AndroidUpdateBanner />);
    await flushPendingAsyncWork();
    expect(container).toBeEmptyDOMElement();
  });

  it('is not shown on the Android app page itself', async () => {
    launchFromApp(100);
    const calls = serveRelease();
    render(<AndroidUpdateBanner />, { wrapperOptions: { route: '/settings/android-app' } });
    await waitFor(() => expect(calls.count).toBe(1));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
  });

  it('remembers a dismissal for that release only', async () => {
    launchFromApp(100);
    serveRelease();
    const first = render(<AndroidUpdateBanner />);

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ANDROID_UPDATE_DISMISSED_KEY)).toBe('110');
    first.unmount();

    // Same release on the next launch: still dismissed.
    const calls = serveRelease();
    const second = render(<AndroidUpdateBanner />);
    await waitFor(() => expect(calls.count).toBe(1));
    expect(screen.queryByTestId('android-update-banner')).not.toBeInTheDocument();
    second.unmount();

    // A newer release raises it again.
    serveRelease(makeRelease({ versionCode: 120, versionName: '2.2.0' }));
    render(<AndroidUpdateBanner />);
    expect(await screen.findByTestId('android-update-banner')).toHaveTextContent('2.2.0');
  });
});

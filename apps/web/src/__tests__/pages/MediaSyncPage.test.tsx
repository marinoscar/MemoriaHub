/** `/settings/media-sync` (issue #515): device cards, counts, commands, TWA links, unpair, empty state. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../mocks/server';
import { render, mockUser, flushPendingAsyncWork, type MockUser } from '../utils/test-utils';
import MediaSyncPage from '../../pages/MediaSyncPage';
import { CONFIG_PENDING_MESSAGE, type MediaSyncDevice } from '../../services/mediaSync';
import { COMMAND_APPLIES_LATER } from '../../components/settings/mediaSync/DeviceControls';
import { GET_APP_TITLE } from '../../components/settings/mediaSync/GetAndroidApp';
import { DEVICE_ID, makeCircle, makeDevice, makeRun } from '../fixtures/mediaSync';

const writer: MockUser = { ...mockUser, permissions: [...mockUser.permissions, 'media:read', 'media:write'] };
const reader: MockUser = { ...mockUser, permissions: [...mockUser.permissions, 'media:read'] };

function serveDevices(devices: MediaSyncDevice[]) {
  server.use(http.get('*/api/media-sync/devices', () => HttpResponse.json({ data: devices })));
}

function renderPage(user: MockUser = writer) {
  return render(<MediaSyncPage />, {
    wrapperOptions: { user, route: '/settings/media-sync', activeCircle: makeCircle() },
  });
}

async function findCard() {
  return screen.findByTestId(`device-card-${DEVICE_ID}`);
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(async () => {
  await flushPendingAsyncWork();
  window.sessionStorage.clear();
});

describe('MediaSyncPage', () => {
  it('shows the "Get the app" card when no phone is paired', async () => {
    // Default handler: no devices.
    renderPage();
    expect(await screen.findByTestId('get-android-app')).toHaveTextContent(GET_APP_TITLE);
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', '/settings/android-app');
  });

  it('renders a device card with the synced and missing counts', async () => {
    serveDevices([makeDevice()]);
    renderPage();
    const card = await findCard();

    expect(within(card).getByRole('heading', { name: 'Pixel 9' })).toBeInTheDocument();
    // synced = uploaded 90 + deduplicated 10; missing = pending 15 + uploading 1 + failed 6 + blocked 2.
    expect(within(card).getByTestId('count-synced')).toHaveTextContent('100');
    expect(within(card).getByTestId('count-missing')).toHaveTextContent('24');
    expect(within(card).getByTestId('sync-counts')).toHaveTextContent(/100 of 124 files synced \(81%\)/);
  });

  it('shows the "changes pending" line when the phone has not applied the latest config', async () => {
    serveDevices([makeDevice({ configVersion: 4, appliedConfigVersion: 3, configPending: true })]);
    renderPage();
    const card = await findCard();
    expect(within(card).getByTestId('status-config_pending')).toHaveTextContent(CONFIG_PENDING_MESSAGE);
    // Outside the app there is no "Apply now on this phone" action.
    expect(within(card).queryByRole('link', { name: 'Apply now on this phone' })).not.toBeInTheDocument();
  });

  it('sends Stop syncing as a pause command and explains when it applies', async () => {
    serveDevices([makeDevice()]);
    const bodies: unknown[] = [];
    server.use(
      http.post(`*/api/media-sync/devices/${DEVICE_ID}/commands`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ data: { config: { ...makeDevice().config, paused: true }, configVersion: 4 } });
      }),
    );
    renderPage();
    const card = await findCard();

    expect(within(card).getAllByText(COMMAND_APPLIES_LATER).length).toBeGreaterThan(0);
    await userEvent.click(within(card).getByRole('button', { name: 'Stop syncing' }));

    await waitFor(() => expect(bodies).toEqual([{ action: 'pause' }]));
    expect(await within(card).findByText(/Syncing stopped\./)).toBeInTheDocument();
  });

  it('offers no "on this phone" links outside the app', async () => {
    serveDevices([makeDevice()]);
    renderPage();
    const card = await findCard();
    expect(within(card).queryByTestId('on-this-phone')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Media sync on this phone' })).not.toBeInTheDocument();
  });

  it('offers deep links into the native screen inside the app (TWA)', async () => {
    window.sessionStorage.setItem('memoriahub.twa', '1');
    serveDevices([makeDevice({ configVersion: 4, appliedConfigVersion: 3, configPending: true })]);
    renderPage();
    const card = await findCard();

    expect(screen.getByRole('link', { name: 'Open Media sync on this phone' })).toHaveAttribute(
      'href',
      'memoriahub://media-sync',
    );
    const row = within(card).getByTestId('on-this-phone');
    expect(within(row).getByRole('link', { name: 'Sync now on this phone' })).toHaveAttribute(
      'href',
      'memoriahub://media-sync?action=sync',
    );
    expect(within(card).getByTestId('status-config_pending')).toContainElement(
      within(within(card).getByTestId('status-config_pending')).getByRole('link', { name: 'Apply now on this phone' }),
    );
    expect(within(card).queryByText(COMMAND_APPLIES_LATER)).not.toBeInTheDocument();
  });

  it('lists the last run\'s failed files when the section is opened', async () => {
    serveDevices([makeDevice()]);
    server.use(http.get(`*/api/media-sync/devices/${DEVICE_ID}/runs`, () => HttpResponse.json({ data: [makeRun()] })));
    renderPage();
    const card = await findCard();

    await userEvent.click(within(card).getByRole('button', { name: 'Failed files' }));
    expect(await within(card).findByText('IMG_0001.HEIC')).toBeInTheDocument();
  });

  it('unpairs a phone after confirmation', async () => {
    let devices = [makeDevice()];
    server.use(http.get('*/api/media-sync/devices', () => HttpResponse.json({ data: devices })));
    const deletes: string[] = [];
    server.use(
      http.delete(`*/api/media-sync/devices/${DEVICE_ID}`, () => {
        deletes.push(DEVICE_ID);
        devices = [makeDevice({ status: 'revoked' })];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();
    const card = await findCard();

    await userEvent.click(within(card).getByRole('button', { name: 'Unpair Pixel 9' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unpair Pixel 9?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unpair' }));

    await waitFor(() => expect(deletes).toEqual([DEVICE_ID]));
    expect(await screen.findByText('Pixel 9 was unpaired.')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId(`device-card-${DEVICE_ID}`)).getByText('Unpaired')).toBeInTheDocument());
  });

  it('is read-only without media:write', async () => {
    serveDevices([makeDevice()]);
    renderPage(reader);
    const card = await findCard();

    expect(screen.getByText('You can see your phones but not change how they sync.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Stop syncing' })).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'Unpair Pixel 9' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

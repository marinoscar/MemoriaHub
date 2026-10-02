/** The Media Sync config editor (issue #515): PATCH body, folders from inventory, field errors. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../../mocks/server';
import { render, flushPendingAsyncWork } from '../../utils/test-utils';
import {
  MediaSyncConfigEditor,
  NO_INVENTORY_MESSAGE,
  buildConfigPatch,
} from '../../../components/settings/mediaSync/MediaSyncConfigEditor';
import { CIRCLE_ID, DEVICE_ID, OTHER_CIRCLE_ID, makeDevice } from '../../fixtures/mediaSync';
import type { MediaSyncDevice } from '../../../services/mediaSync';

const circles = [
  { id: CIRCLE_ID, name: 'Family' },
  { id: OTHER_CIRCLE_ID, name: 'Trips' },
];

function capturePatch(respond?: (body: unknown) => Response) {
  const bodies: unknown[] = [];
  server.use(
    http.patch(`*/api/media-sync/devices/${DEVICE_ID}/config`, async ({ request }) => {
      const body = await request.json();
      bodies.push(body);
      if (respond) return respond(body);
      const device = makeDevice();
      return HttpResponse.json({
        data: { config: { ...device.config, ...(body as object) }, configVersion: device.configVersion + 1 },
      });
    }),
  );
  return bodies;
}

function renderEditor(device: MediaSyncDevice = makeDevice(), canWrite = true) {
  const onSaved = vi.fn();
  render(<MediaSyncConfigEditor device={device} circles={circles} canWrite={canWrite} onSaved={onSaved} />);
  return { onSaved };
}

afterEach(async () => {
  await flushPendingAsyncWork();
});

describe('buildConfigPatch', () => {
  const device = makeDevice();
  const draft = {
    targetCircleId: device.config.targetCircleId,
    folderIds: ['b-camera'],
    includePhotos: true,
    includeVideos: true,
    network: 'wifi' as const,
    requireCharging: false,
    uploadExisting: 'all' as const,
  };

  it('is empty when nothing changed (folder order does not matter)', () => {
    expect(buildConfigPatch(device.config, draft, device.inventory)).toEqual({});
  });

  it('contains only the changed fields, with folder names from the inventory', () => {
    expect(
      buildConfigPatch(
        device.config,
        { ...draft, folderIds: ['b-whatsapp', 'b-camera'], network: 'any', uploadExisting: 'from_pairing' },
        device.inventory,
      ),
    ).toEqual({
      folders: [
        { bucketId: 'b-whatsapp', name: 'WhatsApp Images' },
        { bucketId: 'b-camera', name: 'Camera' },
      ],
      network: 'any',
      uploadExisting: 'from_pairing',
    });
  });
});

describe('MediaSyncConfigEditor', () => {
  it('lists folders from the inventory with photo/video counts', () => {
    renderEditor();
    const list = screen.getByRole('list', { name: 'Phone folders' });
    expect(within(list).getByRole('checkbox', { name: /Camera/ })).toBeChecked();
    expect(within(list).getByRole('checkbox', { name: /WhatsApp Images/ })).not.toBeChecked();
    expect(within(list).getByText(/120 photos · 4 videos/)).toBeInTheDocument();
  });

  it('shows the empty state when the phone reported no folders', () => {
    renderEditor(makeDevice({ inventory: null }));
    expect(screen.getByTestId('no-inventory')).toHaveTextContent(NO_INVENTORY_MESSAGE);
  });

  it('Save is disabled until something changes', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends only the network change when the radio flips to Wi-Fi and mobile data', async () => {
    const bodies = capturePatch();
    const { onSaved } = renderEditor();

    await userEvent.click(screen.getByRole('radio', { name: 'Wi-Fi and mobile data' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bodies).toEqual([{ network: 'any' }]);
    expect(await screen.findByText(/applies it the next time it checks in/)).toBeInTheDocument();
  });

  it('sends the selected folders, charging and upload-existing changes', async () => {
    const bodies = capturePatch();
    renderEditor();

    await userEvent.click(screen.getByRole('checkbox', { name: /WhatsApp Images/ }));
    await userEvent.click(screen.getByRole('switch', { name: /Only while charging/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'Only new from now on' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      folders: [
        { bucketId: 'b-camera', name: 'Camera' },
        { bucketId: 'b-whatsapp', name: 'WhatsApp Images' },
      ],
      requireCharging: true,
      uploadExisting: 'from_pairing',
    });
  });

  it('Select all / None act on the search results', async () => {
    const bodies = capturePatch();
    renderEditor();

    await userEvent.type(screen.getByLabelText('Search folders'), 'screen');
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await userEvent.clear(screen.getByLabelText('Search folders'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as { folders: Array<{ bucketId: string }> }).folders.map((f) => f.bucketId)).toEqual([
      'b-camera',
      'b-screens',
    ]);
  });

  it('maps 400 UNKNOWN_FOLDER to the folders field', async () => {
    capturePatch(() =>
      HttpResponse.json(
        { message: 'Unknown folder', details: { reason: 'UNKNOWN_FOLDER', bucketIds: ['b-gone'] } },
        { status: 400 },
      ) as unknown as Response,
    );
    const base = makeDevice();
    renderEditor(
      makeDevice({
        config: { ...base.config, folders: [...base.config.folders, { bucketId: 'b-gone', name: 'Old SD card' }] },
      }),
    );

    await userEvent.click(screen.getByRole('checkbox', { name: /WhatsApp Images/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/no longer reports this folder: Old SD card/)).toBeInTheDocument();
    expect(screen.getByTestId('missing-folders')).toHaveTextContent('Old SD card (no longer on the phone)');
  });

  it('maps 403 TARGET_CIRCLE_FORBIDDEN to the circle field', async () => {
    capturePatch(() =>
      HttpResponse.json(
        { message: 'Forbidden', details: { reason: 'TARGET_CIRCLE_FORBIDDEN', circleId: OTHER_CIRCLE_ID } },
        { status: 403 },
      ) as unknown as Response,
    );
    renderEditor();

    await userEvent.click(screen.getByRole('combobox', { name: 'Upload into circle' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Trips' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/only sync into a circle where you are a collaborator/)).toBeInTheDocument();
  });

  it('is read-only without media:write', () => {
    renderEditor(makeDevice(), false);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Wi-Fi only' })).toBeDisabled();
  });
});

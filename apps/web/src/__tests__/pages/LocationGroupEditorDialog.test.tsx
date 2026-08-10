/**
 * Unit tests for LocationGroupEditorDialog (Admin > Location Groups, #375).
 *
 * Mocking strategy matches the sibling page spec: services are module-mocked
 * and driven through `vi.mocked()` handles; local `makeX(overrides)` factories
 * build the API payloads.
 *
 * The case this file exists for is the `409`: adding a raw value another group
 * already claims must name that group, and the name is read from
 * **`details.groupName`** — the API's HttpExceptionFilter drops any top-level
 * custom key, so a client reading a top-level `groupName` would silently render
 * "undefined" forever.
 *
 * `LocationPickerMap` is stubbed out: the Area block only needs to prove the
 * centre/radius reach the save payload, and Leaflet in jsdom is beside the
 * point (and expensive).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: ({
    onChange,
    radiusMeters,
  }: {
    onChange: (v: { lat: number; lng: number }) => void;
    radiusMeters?: number | null;
  }) => (
    <button
      type="button"
      data-testid="picker-map"
      data-radius-meters={radiusMeters == null ? '' : String(radiusMeters)}
      onClick={() => onChange({ lat: 10, lng: -84 })}
    >
      pick
    </button>
  ),
}));

vi.mock('../../services/media', () => ({
  listMedia: vi.fn(),
}));

vi.mock('../../services/locationGroups', async () => {
  const actual = await vi.importActual<typeof import('../../services/locationGroups')>(
    '../../services/locationGroups',
  );
  return {
    ...actual,
    getLocationGroup: vi.fn(),
    listLocationValues: vi.fn(),
    addLocationGroupMembers: vi.fn(),
    removeLocationGroupMembers: vi.fn(),
    createLocationGroup: vi.fn(),
    updateLocationGroup: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import LocationGroupEditorDialog from '../../pages/Admin/LocationGroupEditorDialog';
import { ApiError } from '../../services/api';
import { listMedia } from '../../services/media';
import {
  addLocationGroupMembers,
  createLocationGroup,
  getLocationGroup,
  listLocationValues,
  removeLocationGroupMembers,
  updateLocationGroup,
} from '../../services/locationGroups';
import type { LocationGroupDetail, LocationValue } from '../../services/locationGroups';

const mockListMedia = vi.mocked(listMedia);
const mockGetGroup = vi.mocked(getLocationGroup);
const mockListValues = vi.mocked(listLocationValues);
const mockAddMembers = vi.mocked(addLocationGroupMembers);
const mockRemoveMembers = vi.mocked(removeLocationGroupMembers);
const mockCreateGroup = vi.mocked(createLocationGroup);
const mockUpdateGroup = vi.mocked(updateLocationGroup);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeDetail(overrides: Partial<LocationGroupDetail> = {}): LocationGroupDetail {
  return {
    id: 'group-1',
    level: 'locality',
    canonicalName: 'Heredia',
    normalizedName: 'heredia',
    countryCode: 'CR',
    memberCount: 1,
    itemCount: 1204,
    coverMediaItemId: null,
    coverThumbnailUrl: null,
    centerLat: null,
    centerLng: null,
    radiusKm: null,
    enabled: true,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    aliases: [
      {
        id: 'alias-1',
        rawValue: 'Provincia de Heredia',
        normalizedValue: 'provincia de heredia',
        countryCode: 'CR',
        itemCount: 104,
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function makeValue(overrides: Partial<LocationValue> = {}): LocationValue {
  return {
    value: 'Heredia Province',
    countryCode: 'CR',
    itemCount: 300,
    groupId: null,
    groupCanonicalName: null,
    ...overrides,
  };
}

function makeMediaItem(id: string) {
  return {
    id,
    originalFilename: `${id}.jpg`,
    thumbnailUrl: `https://example.test/${id}.jpg`,
  };
}

function renderDialog(props: Partial<React.ComponentProps<typeof LocationGroupEditorDialog>> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <LocationGroupEditorDialog
      open
      groupId={null}
      level="locality"
      maxRadiusKm={25}
      onClose={onClose}
      onSaved={onSaved}
      {...props}
    />,
    { wrapperOptions: { user: mockAdminUser } },
  );
  return { onSaved, onClose };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocationGroupEditorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListValues.mockResolvedValue({
      items: [makeValue()],
      meta: { total: 1, limit: 50 },
    });
    mockListMedia.mockResolvedValue({ items: [], meta: {} } as any);
    mockGetGroup.mockResolvedValue(makeDetail());
    mockAddMembers.mockResolvedValue({ added: 1 });
    mockRemoveMembers.mockResolvedValue({ removed: 1 });
    mockCreateGroup.mockResolvedValue(makeDetail());
    mockUpdateGroup.mockResolvedValue(makeDetail());
  });

  // -------------------------------------------------------------------------
  describe('create mode', () => {
    it('accumulates members locally and submits them in one POST', async () => {
      const user = userEvent.setup();
      const { onSaved } = renderDialog();

      await user.type(await screen.findByLabelText(/canonical name/i), 'Heredia');
      await user.click(screen.getByLabelText(/add a raw location value/i));
      await user.click(await screen.findByText('Heredia Province'));

      // Chosen value becomes a chip and NOT an immediate API call.
      expect(mockAddMembers).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /create group/i }));

      await waitFor(() => {
        expect(mockCreateGroup).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'locality',
            canonicalName: 'Heredia',
            memberValues: ['Heredia Province'],
          }),
        );
      });
      expect(onSaved).toHaveBeenCalled();
    });

    it('shows the owning group next to a value already claimed', async () => {
      mockListValues.mockResolvedValue({
        items: [makeValue({ groupId: 'g-owner', groupCanonicalName: 'Heredia' })],
        meta: { total: 1, limit: 50 },
      });

      const user = userEvent.setup();
      renderDialog();

      await user.click(await screen.findByLabelText(/add a raw location value/i));

      expect(await screen.findByText(/in group "Heredia"/i)).toBeInTheDocument();
    });

    it('sends the area centre and radius when the Area block is enabled', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.type(await screen.findByLabelText(/canonical name/i), 'Heredia');
      await user.click(screen.getByLabelText(/define a capture area/i));
      await user.click(await screen.findByTestId('picker-map'));
      await user.click(screen.getByRole('button', { name: /create group/i }));

      await waitFor(() => {
        expect(mockCreateGroup).toHaveBeenCalledWith(
          expect.objectContaining({
            center: { lat: 10, lng: -84 },
            radiusKm: expect.any(Number),
          }),
        );
      });
    });

    it('caps the radius slider at the loaded maxRadiusKm setting', async () => {
      const user = userEvent.setup();
      renderDialog({ maxRadiusKm: 12 });

      await user.click(await screen.findByLabelText(/define a capture area/i));

      const slider = await screen.findByLabelText(/capture radius in kilometres/i);
      expect(slider).toHaveAttribute('aria-valuemax', '12');
      expect(screen.getByText(/global maximum capture radius \(12 km\)/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('edit mode', () => {
    it('loads the group and renders its aliases as chips', async () => {
      renderDialog({ groupId: 'group-1' });

      expect(await screen.findByText('Provincia de Heredia')).toBeInTheDocument();
      expect(mockGetGroup).toHaveBeenCalledWith('group-1');
    });

    it('adds a member immediately via POST /members', async () => {
      const user = userEvent.setup();
      renderDialog({ groupId: 'group-1' });

      await screen.findByText('Provincia de Heredia');
      await user.click(screen.getByLabelText(/add a raw location value/i));
      await user.click(await screen.findByText('Heredia Province'));

      await waitFor(() => {
        expect(mockAddMembers).toHaveBeenCalledWith('group-1', ['Heredia Province']);
      });
      expect(await screen.findByText('Heredia Province')).toBeInTheDocument();
    });

    it('removes a member immediately via DELETE /members', async () => {
      const user = userEvent.setup();
      renderDialog({ groupId: 'group-1' });

      const chipLabel = await screen.findByText('Provincia de Heredia');
      const deleteIcon = chipLabel
        .closest('.MuiChip-root')
        ?.querySelector('.MuiChip-deleteIcon') as HTMLElement;
      await user.click(deleteIcon);

      await waitFor(() => {
        expect(mockRemoveMembers).toHaveBeenCalledWith('group-1', ['Provincia de Heredia']);
        expect(screen.queryByText('Provincia de Heredia')).not.toBeInTheDocument();
      });
    });

    it('selects a cover photo and sends it on save', async () => {
      mockListMedia.mockResolvedValue({
        items: [makeMediaItem('media-1'), makeMediaItem('media-2')],
        meta: {},
      } as any);

      const user = userEvent.setup();
      renderDialog({ groupId: 'group-1' });

      await user.click(await screen.findByTestId('cover-candidate-media-2'));
      await user.click(screen.getByRole('button', { name: /save group/i }));

      await waitFor(() => {
        expect(mockUpdateGroup).toHaveBeenCalledWith(
          'group-1',
          expect.objectContaining({ coverMediaItemId: 'media-2' }),
        );
      });
    });

    it('names the owning group when adding a value hits a 409 (details.groupName)', async () => {
      mockAddMembers.mockRejectedValue(
        new ApiError('"heredia province" is already a member of "Heredia Centro"', 409, undefined, {
          groupId: 'g-owner',
          groupName: 'Heredia Centro',
        }),
      );

      const user = userEvent.setup();
      renderDialog({ groupId: 'group-1' });

      await screen.findByText('Provincia de Heredia');
      await user.click(screen.getByLabelText(/add a raw location value/i));
      await user.click(await screen.findByText('Heredia Province'));

      expect(await screen.findByText(/already in group "Heredia Centro"/i)).toBeInTheDocument();
      // The chip must NOT appear — the value was rejected, not adopted.
      expect(
        screen.queryByText('Heredia Province', { selector: '.MuiChip-label' }),
      ).not.toBeInTheDocument();
    });
  });
});

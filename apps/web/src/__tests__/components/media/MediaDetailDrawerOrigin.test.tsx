/**
 * MediaDetailDrawer — "Origin" section tests (issue #163).
 *
 * Covers:
 *   - Origin section does NOT render for a live item (not archived, not trashed)
 *     even if it has a burstGroupId/duplicateGroupId
 *   - Origin section does NOT render for an archived/trashed item when both
 *     group ids are null
 *   - Renders "Burst review" + "View group" (-> /bursts/:id) for an archived
 *     item with a burstGroupId
 *   - Renders "Duplicate review" + "View group" (-> /duplicates/:id) for a
 *     trashed item with a duplicateGroupId (burstGroupId null)
 *   - Burst takes precedence over duplicate when both ids are set
 *   - The trashed-item caveat caption only appears when deletedAt is set AND
 *     burstGroupId is set (not for archived-only, not for a duplicate group)
 *   - Clicking "View group" navigates to the correct route
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaDetailDrawer } from '../../../components/media/MediaDetailDrawer';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Mock react-router-dom's useNavigate (keep everything else real).
// ---------------------------------------------------------------------------
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// ---------------------------------------------------------------------------
// Mock media service — mirrors MediaDetailDrawerArchive.test.tsx's set.
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  patchMedia: vi.fn(),
  getMedia: vi.fn(),
  bulkArchive: vi.fn(),
  bulkUnarchive: vi.fn(),
  bulkDelete: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
}));

import { getMedia } from '../../../services/media';

const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Mock face service (avoids hook fetches failing in jsdom)
// ---------------------------------------------------------------------------
vi.mock('../../../services/face', () => ({
  getMediaFaces: vi.fn().mockResolvedValue([]),
  getMediaFaceStatus: vi.fn().mockResolvedValue({
    status: 'not_processed',
    faceCount: 0,
    providerKey: null,
    modelVersion: null,
    processedAt: null,
    lastError: null,
  }),
  rerunMediaFaces: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
  listPeople: vi.fn().mockResolvedValue({ items: [], meta: { total: 0, page: 1, pageSize: 100 } }),
  getPerson: vi.fn().mockResolvedValue(null),
  createPerson: vi.fn().mockResolvedValue({}),
  updatePerson: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock VideoPlayer and LocationMiniMap (avoid heavy deps in tests)
// ---------------------------------------------------------------------------
vi.mock('../../../components/media/VideoPlayer', () => ({
  VideoPlayer: ({ src }: any) => <div data-testid="video-player" data-src={src} />,
}));

vi.mock('../../../components/media/LocationMiniMap', () => ({
  LocationMiniMap: ({ lat, lng }: any) => (
    <div data-testid="location-mini-map" data-lat={lat} data-lng={lng} />
  ),
}));

vi.mock('../../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: ({ onChange }: any) => (
    <div data-testid="location-picker-map" onClick={() => onChange({ lat: 10, lng: 20 })} />
  ),
}));

vi.mock('../../../components/media/TagAutocomplete', () => ({
  TagAutocomplete: ({ label, value, onChange }: any) => (
    <div data-testid={`tag-autocomplete-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <input
        aria-label={label}
        value={value.join(',')}
        onChange={(e) => onChange(e.target.value ? e.target.value.split(',') : [])}
      />
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
const ITEM_ID = 'media-item-origin-001';
const CIRCLE_ID = 'circle-1';

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: ITEM_ID,
    storageObjectId: 'storage-obj-001',
    addedById: 'user-001',
    circleId: CIRCLE_ID,
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: null,
    importedAt: '2024-06-16T08:00:00.000Z',
    source: 'web',
    contentHash: 'abc123',
    width: 1920,
    height: 1080,
    durationMs: null,
    orientation: 1,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    originalFilename: 'photo.jpg',
    description: null,
    favorite: false,
    geoCountry: null,
    geoCountryCode: null,
    geoAdmin1: null,
    geoAdmin2: null,
    geoLocality: null,
    geoPlaceName: null,
    geoSource: null,
    geocodedAt: null,
    coordSource: null,
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    archivedAt: null,
    burstGroupId: null,
    duplicateGroupId: null,
    metadata: null,
    thumbnailUrl: null,
    downloadUrl: null,
    ...overrides,
  };
}

function defaultProps(overrides: Partial<MediaItem> = {}) {
  return {
    item: makeMediaItem(overrides),
    open: true,
    onClose: vi.fn(),
    onItemUpdated: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MediaDetailDrawer — Origin section (issue #163)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getMedia is only consulted when the passed item's downloadUrl is
    // undefined; every fixture below sets it to null explicitly, so this is
    // just a safety net.
    mockGetMedia.mockResolvedValue(makeMediaItem({ downloadUrl: null }));
  });

  describe('visibility gating', () => {
    it('does NOT render Origin for a live item even if it has a burstGroupId', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ archivedAt: null, deletedAt: null, burstGroupId: 'burst-1' })}
        />,
      );

      expect(screen.queryByText(/^origin$/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view group/i })).not.toBeInTheDocument();
    });

    it('does NOT render Origin for a live item even if it has a duplicateGroupId', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ archivedAt: null, deletedAt: null, duplicateGroupId: 'dup-1' })}
        />,
      );

      expect(screen.queryByText(/^origin$/i)).not.toBeInTheDocument();
    });

    it('does NOT render Origin for an archived item when both group ids are null', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            archivedAt: '2024-07-01T10:00:00.000Z',
            burstGroupId: null,
            duplicateGroupId: null,
          })}
        />,
      );

      expect(screen.queryByText(/^origin$/i)).not.toBeInTheDocument();
    });

    it('does NOT render Origin for a trashed item when both group ids are null', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            deletedAt: '2024-07-05T10:00:00.000Z',
            burstGroupId: null,
            duplicateGroupId: null,
          })}
        />,
      );

      expect(screen.queryByText(/^origin$/i)).not.toBeInTheDocument();
    });
  });

  describe('burst review — archived item', () => {
    it('renders "Burst review" and a "View group" button', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            archivedAt: '2024-07-01T10:00:00.000Z',
            burstGroupId: 'burst-77',
          })}
        />,
      );

      expect(screen.getByText(/^origin$/i)).toBeInTheDocument();
      expect(screen.getByText(/burst review/i)).toBeInTheDocument();
      expect(screen.queryByText(/duplicate review/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /view group/i })).toBeInTheDocument();
    });

    it('clicking "View group" navigates to /bursts/:id', async () => {
      const user = userEvent.setup();
      render(
        <MediaDetailDrawer
          {...defaultProps({
            archivedAt: '2024-07-01T10:00:00.000Z',
            burstGroupId: 'burst-77',
          })}
        />,
      );

      await user.click(screen.getByRole('button', { name: /view group/i }));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/bursts/burst-77');
      });
    });

    it('does NOT show the trashed-item caveat caption for an archived-only item', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            archivedAt: '2024-07-01T10:00:00.000Z',
            deletedAt: null,
            burstGroupId: 'burst-77',
          })}
        />,
      );

      expect(screen.queryByText(/may not appear/i)).not.toBeInTheDocument();
    });
  });

  describe('duplicate review — trashed item', () => {
    it('renders "Duplicate review" and a "View group" button when duplicateGroupId is set and burstGroupId is null', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            deletedAt: '2024-07-05T10:00:00.000Z',
            burstGroupId: null,
            duplicateGroupId: 'dup-55',
          })}
        />,
      );

      expect(screen.getByText(/^origin$/i)).toBeInTheDocument();
      expect(screen.getByText(/duplicate review/i)).toBeInTheDocument();
      expect(screen.queryByText(/burst review/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /view group/i })).toBeInTheDocument();
    });

    it('clicking "View group" navigates to /duplicates/:id', async () => {
      const user = userEvent.setup();
      render(
        <MediaDetailDrawer
          {...defaultProps({
            deletedAt: '2024-07-05T10:00:00.000Z',
            burstGroupId: null,
            duplicateGroupId: 'dup-55',
          })}
        />,
      );

      await user.click(screen.getByRole('button', { name: /view group/i }));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/duplicates/dup-55');
      });
    });

    it('does NOT show the trashed-item caveat caption for a duplicate group (caption is burst-specific)', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            deletedAt: '2024-07-05T10:00:00.000Z',
            burstGroupId: null,
            duplicateGroupId: 'dup-55',
          })}
        />,
      );

      expect(screen.queryByText(/may not appear/i)).not.toBeInTheDocument();
    });
  });

  describe('precedence and caveat caption', () => {
    it('shows "Burst review" (not "Duplicate review") when both group ids are set', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            archivedAt: '2024-07-01T10:00:00.000Z',
            burstGroupId: 'burst-1',
            duplicateGroupId: 'dup-1',
          })}
        />,
      );

      expect(screen.getByText(/burst review/i)).toBeInTheDocument();
      expect(screen.queryByText(/duplicate review/i)).not.toBeInTheDocument();
    });

    it('shows the trashed-item caveat caption when deletedAt is set AND burstGroupId is set', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            deletedAt: '2024-07-05T10:00:00.000Z',
            burstGroupId: 'burst-1',
          })}
        />,
      );

      expect(
        screen.getByText(/trashed items are excluded from the burst group.*member list.*may not appear there/i),
      ).toBeInTheDocument();
    });

    it('does NOT show the caveat caption when only archived (not trashed) even with a burstGroupId', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            archivedAt: '2024-07-01T10:00:00.000Z',
            deletedAt: null,
            burstGroupId: 'burst-1',
          })}
        />,
      );

      expect(screen.queryByText(/may not appear/i)).not.toBeInTheDocument();
    });

    it('does NOT show the caveat caption when trashed with only a duplicateGroupId (no burstGroupId)', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            deletedAt: '2024-07-05T10:00:00.000Z',
            burstGroupId: null,
            duplicateGroupId: 'dup-1',
          })}
        />,
      );

      expect(screen.queryByText(/may not appear/i)).not.toBeInTheDocument();
    });
  });
});

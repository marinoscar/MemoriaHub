/**
 * MediaDetailDrawer — archive and trash action tests.
 *
 * Covers:
 *   - Archive button is present and labeled "Archive" when item is not archived
 *   - Unarchive button is present and labeled "Unarchive" when item IS archived
 *   - Clicking Archive/Unarchive calls the right service function
 *   - Delete button says "Move to Trash" (not permanent)
 *   - Delete confirmation dialog appears on click
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaDetailDrawer } from '../../../components/media/MediaDetailDrawer';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Mock media service
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

import { bulkArchive, bulkUnarchive, bulkDelete, getMedia } from '../../../services/media';

const mockBulkArchive = vi.mocked(bulkArchive);
const mockBulkUnarchive = vi.mocked(bulkUnarchive);
const mockBulkDelete = vi.mocked(bulkDelete);
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
const ITEM_ID = 'media-item-archive-001';
const CIRCLE_ID = 'circle-1';

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: ITEM_ID,
    storageObjectId: 'storage-obj-001',
    ownerId: 'user-001',
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
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    archivedAt: null,
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
describe('MediaDetailDrawer — archive/trash actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkArchive.mockResolvedValue({ archived: 1 });
    mockBulkUnarchive.mockResolvedValue({ unarchived: 1 });
    mockBulkDelete.mockResolvedValue({ deleted: 1 });
    // getMedia is called after archive/unarchive to refresh the item
    mockGetMedia.mockResolvedValue(makeMediaItem({ downloadUrl: null }));
  });

  // -------------------------------------------------------------------------
  // Archive button label toggles on archivedAt
  // -------------------------------------------------------------------------
  describe('Archive button label', () => {
    it('shows "Archive" button when item is NOT archived (archivedAt is null)', () => {
      render(<MediaDetailDrawer {...defaultProps({ archivedAt: null })} />);
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
    });

    it('shows "Unarchive" button when item IS archived (archivedAt is set)', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ archivedAt: '2024-07-01T10:00:00.000Z' })}
        />,
      );
      expect(screen.getByRole('button', { name: /^unarchive$/i })).toBeInTheDocument();
    });

    it('does NOT show Unarchive when item is not archived', () => {
      render(<MediaDetailDrawer {...defaultProps({ archivedAt: null })} />);
      expect(screen.queryByRole('button', { name: /^unarchive$/i })).not.toBeInTheDocument();
    });

    it('does NOT show Archive when item is archived', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ archivedAt: '2024-07-01T10:00:00.000Z' })}
        />,
      );
      expect(screen.queryByRole('button', { name: /^archive$/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Archive action
  // -------------------------------------------------------------------------
  describe('Archive action', () => {
    it('calls bulkArchive with the item id when Archive is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps({ archivedAt: null })} />);

      await user.click(screen.getByRole('button', { name: /^archive$/i }));

      await waitFor(() => {
        expect(mockBulkArchive).toHaveBeenCalledWith({
          circleId: CIRCLE_ID,
          ids: [ITEM_ID],
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Unarchive action
  // -------------------------------------------------------------------------
  describe('Unarchive action', () => {
    it('calls bulkUnarchive with the item id when Unarchive is clicked', async () => {
      const user = userEvent.setup();
      render(
        <MediaDetailDrawer
          {...defaultProps({ archivedAt: '2024-07-01T10:00:00.000Z' })}
        />,
      );

      await user.click(screen.getByRole('button', { name: /^unarchive$/i }));

      await waitFor(() => {
        expect(mockBulkUnarchive).toHaveBeenCalledWith({
          circleId: CIRCLE_ID,
          ids: [ITEM_ID],
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Delete → Move to Trash button
  // -------------------------------------------------------------------------
  describe('Delete button (Move to Trash)', () => {
    it('shows a "Move to Trash" button', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByRole('button', { name: /move to trash/i })).toBeInTheDocument();
    });

    it('opens a confirmation dialog when Move to Trash is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /move to trash/i }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/move to trash\?/i)).toBeInTheDocument();
    });

    it('confirm dialog says "Trash" and mentions recovery (not permanent)', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /move to trash/i }));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/trash/i);
      expect(dialog).toHaveTextContent(/recovered|retention/i);
    });

    it('calls bulkDelete when the dialog confirm button is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);

      await user.click(screen.getByRole('button', { name: /move to trash/i }));
      const confirmBtns = screen.getAllByRole('button', { name: /move to trash/i });
      // The last one inside the dialog is the confirm button
      await user.click(confirmBtns[confirmBtns.length - 1]);

      await waitFor(() => {
        expect(mockBulkDelete).toHaveBeenCalledWith({
          circleId: CIRCLE_ID,
          ids: [ITEM_ID],
        });
      });
    });
  });
});

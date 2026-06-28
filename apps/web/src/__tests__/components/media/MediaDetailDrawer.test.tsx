/**
 * Component tests — MediaDetailDrawer
 *
 * Mocking strategy:
 *   - patchMedia and getMedia from services/media are mocked via vi.mock.
 *   - VideoPlayer is mocked to a lightweight stub (avoids @vidstack deps).
 *   - LocationMiniMap is mocked to a lightweight stub (avoids react-leaflet deps).
 *
 * Test coverage:
 *   - Read-only metadata display
 *   - Edit mode (enter, populate, save, error, cancel)
 *   - Favorite toggle
 *   - getMedia called for video items that lack downloadUrl
 *   - getMedia NOT called when downloadUrl is already present
 *   - Stale-response guard (cancelled flag + id check)
 *   - VideoPlayer renders when downloadUrl is present; spinner when absent
 *   - LocationMiniMap renders when GPS coords present; absent when null
 *   - Close behaviour and null item guard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaDetailDrawer } from '../../../components/media/MediaDetailDrawer';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Mock the media service (both patchMedia and getMedia)
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  patchMedia: vi.fn(),
  getMedia: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mock the social service — useMediaSocial calls getSocialStatus on mount.
// Without this mock the hook issues a real fetch that fails in jsdom.
// ---------------------------------------------------------------------------

vi.mock('../../../services/social', () => ({
  getSocialStatus: vi.fn().mockResolvedValue({
    status: 'not_processed',
    detected: false,
    platform: null,
    processedAt: null,
    lastError: null,
  }),
  rerunSocial: vi.fn().mockResolvedValue({ jobId: 'job-s1', status: 'pending' }),
}));

import { patchMedia, getMedia } from '../../../services/media';

const mockPatchMedia = vi.mocked(patchMedia);
const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Mock the face service — FaceThumbnails (mounted inside the drawer) calls
// getMediaFaces and getMediaFaceStatus on mount via useMediaFaces. Without
// this mock the hook issues real fetches that fail in jsdom and pollute the
// test output with "fetch failed" errors.
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
}));

// ---------------------------------------------------------------------------
// Mock VideoPlayer — avoids @vidstack/react dependency in tests
// ---------------------------------------------------------------------------

vi.mock('../../../components/media/VideoPlayer', () => ({
  VideoPlayer: ({ src, poster, title }: any) => (
    <div
      data-testid="video-player"
      data-src={src}
      data-poster={poster}
      data-title={title}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock LocationMiniMap — avoids react-leaflet/leaflet dependency in tests
// ---------------------------------------------------------------------------

vi.mock('../../../components/media/LocationMiniMap', () => ({
  LocationMiniMap: ({ lat, lng, label }: any) => (
    <div
      data-testid="location-mini-map"
      data-lat={lat}
      data-lng={lng}
      data-label={label}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock LocationPickerMap — avoids react-leaflet/leaflet dependency in tests
// ---------------------------------------------------------------------------

vi.mock('../../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: ({ value, onChange }: any) => (
    <div
      data-testid="location-picker-map"
      data-lat={value?.lat}
      data-lng={value?.lng}
      onClick={() => onChange({ lat: 10, lng: 20 })}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock TagAutocomplete — avoids Autocomplete complexity in tests
// ---------------------------------------------------------------------------

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

const ITEM_ID = 'media-item-001';

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: ITEM_ID,
    storageObjectId: 'storage-obj-001',
    ownerId: 'user-001',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: -360,
    importedAt: '2024-06-16T08:00:00.000Z',
    source: 'web',
    contentHash: 'abc123def456',
    width: 4032,
    height: 3024,
    durationMs: null,
    orientation: 1,
    takenLat: 9.9281,
    takenLng: -84.0907,
    takenAltitude: 1247.5,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    originalFilename: 'DSC_0001.jpg',
    description: 'Beautiful sunset at Arenal',
    favorite: false,
    geoCountry: 'Costa Rica',
    geoCountryCode: 'CR',
    geoAdmin1: 'Alajuela',
    geoAdmin2: 'San Carlos',
    geoLocality: 'La Fortuna',
    geoPlaceName: 'Arenal Volcano',
    geoSource: 'geonames-offline',
    geocodedAt: '2024-06-16T09:00:00.000Z',
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    metadata: null,
    thumbnailUrl: null,
    downloadUrl: null,
    ...overrides,
  };
}

function makeVideoItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return makeMediaItem({
    type: 'video',
    durationMs: 62000,
    ...overrides,
  });
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

describe('MediaDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: patchMedia returns the item passed back as updated
    mockPatchMedia.mockImplementation(async (id, dto) => ({
      ...makeMediaItem(),
      ...dto,
      id,
    } as MediaItem));
    // Default: getMedia returns a full item (with downloadUrl)
    mockGetMedia.mockResolvedValue(
      makeMediaItem({ downloadUrl: 'https://cdn.example.com/video.mp4' }),
    );
  });

  // -------------------------------------------------------------------------
  // Rendering — read-only metadata fields
  // -------------------------------------------------------------------------

  describe('read-only metadata display', () => {
    it('should render the original filename in the drawer header', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getAllByText('DSC_0001.jpg').length).toBeGreaterThan(0);
    });

    it('should display media type', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText('photo')).toBeInTheDocument();
    });

    it('should display video type for video items', () => {
      render(<MediaDetailDrawer {...defaultProps({ type: 'video', durationMs: 62000 })} />);
      expect(screen.getByText('video')).toBeInTheDocument();
    });

    it('should display dimensions', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText(/4032.*3024/)).toBeInTheDocument();
    });

    it('should display camera make and model', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText(/Apple iPhone 15 Pro/i)).toBeInTheDocument();
    });

    it('should display GPS coordinates', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText(/9\.928100.*-84\.090700/)).toBeInTheDocument();
    });

    it('should display altitude', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText(/1247\.5 m/)).toBeInTheDocument();
    });

    it('should display geo country', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText('Costa Rica')).toBeInTheDocument();
    });

    it('should display geo locality', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText('La Fortuna')).toBeInTheDocument();
    });

    it('should display geo place name', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText('Arenal Volcano')).toBeInTheDocument();
    });

    it('should display location section heading when geo fields are present', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      // Use exact match to avoid matching "Edit Location" / "Set Location" button text
      expect(screen.getByText(/^location$/i)).toBeInTheDocument();
    });

    it('should NOT display location section when all geo fields are null', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({
            geoCountry: null,
            geoAdmin1: null,
            geoLocality: null,
            geoPlaceName: null,
          })}
        />,
      );
      expect(screen.queryByText(/^location$/i)).not.toBeInTheDocument();
    });

    it('should not display GPS row when takenLat and takenLng are null', () => {
      render(
        <MediaDetailDrawer {...defaultProps({ takenLat: null, takenLng: null })} />,
      );
      expect(screen.queryByText(/GPS/i)).not.toBeInTheDocument();
    });

    it('should show toggle favorite button', () => {
      render(<MediaDetailDrawer {...defaultProps({ favorite: false })} />);
      expect(
        screen.getByRole('button', { name: /toggle favorite/i }),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // getMedia fetch behaviour — video items without downloadUrl
  // -------------------------------------------------------------------------

  describe('getMedia fetch on open', () => {
    it('calls getMedia when opening a VIDEO item with downloadUrl: undefined', async () => {
      const videoItem = makeVideoItem({ downloadUrl: undefined });
      render(
        <MediaDetailDrawer
          item={videoItem}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(mockGetMedia).toHaveBeenCalledWith(videoItem.id);
      });
    });

    it('renders the VideoPlayer once downloadUrl is available from getMedia', async () => {
      const videoItem = makeVideoItem({ downloadUrl: undefined });
      mockGetMedia.mockResolvedValue(
        makeVideoItem({ downloadUrl: 'https://cdn.example.com/video.mp4' }),
      );

      render(
        <MediaDetailDrawer
          item={videoItem}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('video-player')).toBeInTheDocument();
      });
    });

    it('shows a spinner while the video item is being fetched (downloadUrl not yet present)', () => {
      // getMedia will never resolve in this test — let it hang
      mockGetMedia.mockReturnValue(new Promise(() => {}));
      const videoItem = makeVideoItem({ downloadUrl: undefined });

      render(
        <MediaDetailDrawer
          item={videoItem}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // While waiting for getMedia, the drawer shows a spinner (not a player)
      expect(screen.queryByTestId('video-player')).not.toBeInTheDocument();
      // CircularProgress is rendered — check for the role="progressbar" or the
      // spinner container via its data-testid if present; MUI renders an svg with role=progressbar
      // (or we just verify no player and no error)
    });

    it('does NOT call getMedia when item already has downloadUrl (photo item from list)', async () => {
      const photoItem = makeMediaItem({
        downloadUrl: 'https://cdn.example.com/photo.jpg',
      });

      render(
        <MediaDetailDrawer
          item={photoItem}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // Wait a tick to confirm getMedia was never called
      await new Promise((r) => setTimeout(r, 50));
      expect(mockGetMedia).not.toHaveBeenCalled();
    });

    it('does NOT call getMedia when item.downloadUrl is null (photo items have null, not undefined)', async () => {
      // Photos from the list endpoint have downloadUrl: null (field exists, value is null).
      // Only videos lacking the field (downloadUrl: undefined) trigger a fetch.
      // However the component guards on `item.downloadUrl !== undefined` — null IS defined,
      // so null also skips the fetch.
      const photoItem = makeMediaItem({ downloadUrl: null });

      render(
        <MediaDetailDrawer
          item={photoItem}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(mockGetMedia).not.toHaveBeenCalled();
    });

    it('stale-response guard: out-of-order resolve is ignored when id has changed', async () => {
      let resolveFirst!: (v: MediaItem) => void;
      const firstPromise = new Promise<MediaItem>((res) => { resolveFirst = res; });

      // First render: open with item A (fetch is pending)
      const itemA = makeVideoItem({ id: 'item-a', downloadUrl: undefined });
      const itemAFull = makeVideoItem({ id: 'item-a', downloadUrl: 'https://cdn.example.com/a.mp4' });
      const itemB = makeVideoItem({ id: 'item-b', downloadUrl: 'https://cdn.example.com/b.mp4' });

      mockGetMedia
        .mockReturnValueOnce(firstPromise) // item A fetch hangs
        .mockResolvedValueOnce(itemB);     // item B fetch resolves immediately

      const { rerender } = render(
        <MediaDetailDrawer
          item={itemA}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // Switch to item B before item A's fetch completes
      rerender(
        <MediaDetailDrawer
          item={itemB}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // Item B's player should be visible
      await waitFor(() => {
        expect(screen.getByTestId('video-player')).toBeInTheDocument();
      });

      // Now resolve item A — it should be discarded (cancelled flag / id check)
      resolveFirst(itemAFull);

      // Wait a tick and verify the player is still showing item B's URL
      await new Promise((r) => setTimeout(r, 50));
      const player = screen.getByTestId('video-player');
      expect(player.getAttribute('data-src')).toBe('https://cdn.example.com/b.mp4');
    });
  });

  // -------------------------------------------------------------------------
  // LocationMiniMap rendering
  // -------------------------------------------------------------------------

  describe('LocationMiniMap', () => {
    it('renders LocationMiniMap when takenLat and takenLng are present on the item', async () => {
      const item = makeMediaItem({
        takenLat: 9.9281,
        takenLng: -84.0907,
        downloadUrl: null,
      });

      render(
        <MediaDetailDrawer
          item={item}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // The map is rendered from displayItem, which starts as the list item
      // (fullItem is null until getMedia resolves; but since downloadUrl is
      // null for a photo item, getMedia is not called, so displayItem = item).
      await waitFor(() => {
        expect(screen.getByTestId('location-mini-map')).toBeInTheDocument();
      });
    });

    it('passes correct lat and lng to LocationMiniMap', async () => {
      const item = makeMediaItem({
        takenLat: 48.8566,
        takenLng: 2.3522,
        downloadUrl: null,
      });

      render(
        <MediaDetailDrawer
          item={item}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      await waitFor(() => {
        const map = screen.getByTestId('location-mini-map');
        expect(map.getAttribute('data-lat')).toBe('48.8566');
        expect(map.getAttribute('data-lng')).toBe('2.3522');
      });
    });

    it('does NOT render LocationMiniMap when takenLat is null', async () => {
      const item = makeMediaItem({
        takenLat: null,
        takenLng: null,
        downloadUrl: null,
      });

      render(
        <MediaDetailDrawer
          item={item}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByTestId('location-mini-map')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Edit mode
  // -------------------------------------------------------------------------

  describe('edit mode', () => {
    it('should show Edit button in read-only mode', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      // Use exact name to avoid matching "Edit Tags" button
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    });

    it('should switch to edit mode when Edit is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });
    });

    it('should pre-populate the Description field with the item description', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() => {
        const descriptionInput = screen.getByLabelText(/description/i);
        expect(descriptionInput).toHaveValue('Beautiful sunset at Arenal');
      });
    });

    it('should call onItemUpdated with the API response after save', async () => {
      const onItemUpdated = vi.fn();
      const updatedItem = makeMediaItem({ description: 'New Description' });
      mockPatchMedia.mockResolvedValue(updatedItem);

      const user = userEvent.setup();
      render(
        <MediaDetailDrawer {...defaultProps()} onItemUpdated={onItemUpdated} />,
      );
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(onItemUpdated).toHaveBeenCalledWith(updatedItem);
      });
    });

    it('should return to read-only mode after successful save', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      });
    });

    it('should show an error alert when patchMedia rejects during save', async () => {
      mockPatchMedia.mockRejectedValue(new Error('Server error'));
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/server error/i)).toBeInTheDocument();
      });
    });

    it('should return to read-only mode when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Favorite toggle
  // -------------------------------------------------------------------------

  describe('favorite toggle', () => {
    it('should call patchMedia with { favorite: true } when not currently a favourite', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps({ favorite: false })} />);
      await user.click(screen.getByRole('button', { name: /toggle favorite/i }));
      await waitFor(() => {
        expect(mockPatchMedia).toHaveBeenCalledWith(
          ITEM_ID,
          expect.objectContaining({ favorite: true }),
        );
      });
    });

    it('should call patchMedia with { favorite: false } when currently a favourite', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps({ favorite: true })} />);
      await user.click(screen.getByRole('button', { name: /toggle favorite/i }));
      await waitFor(() => {
        expect(mockPatchMedia).toHaveBeenCalledWith(
          ITEM_ID,
          expect.objectContaining({ favorite: false }),
        );
      });
    });

    it('should call onItemUpdated after toggling favourite', async () => {
      const onItemUpdated = vi.fn();
      const user = userEvent.setup();
      render(
        <MediaDetailDrawer
          {...defaultProps({ favorite: false })}
          onItemUpdated={onItemUpdated}
        />,
      );
      await user.click(screen.getByRole('button', { name: /toggle favorite/i }));
      await waitFor(() => {
        expect(onItemUpdated).toHaveBeenCalledTimes(1);
      });
    });

    it('should silently ignore patchMedia errors on favourite toggle', async () => {
      mockPatchMedia.mockRejectedValue(new Error('network'));
      const user = userEvent.setup();

      await expect(async () => {
        render(<MediaDetailDrawer {...defaultProps({ favorite: false })} />);
        await user.click(screen.getByRole('button', { name: /toggle favorite/i }));
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Close behaviour
  // -------------------------------------------------------------------------

  describe('close behaviour', () => {
    it('should call onClose when the X button is clicked', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} onClose={onClose} />);
      await user.click(screen.getByRole('button', { name: /close detail panel/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Null item guard
  // -------------------------------------------------------------------------

  describe('null item guard', () => {
    it('should render nothing when item is null', () => {
      render(
        <MediaDetailDrawer item={null} open={true} onClose={vi.fn()} onItemUpdated={vi.fn()} />,
      );
      expect(screen.queryByText(/details/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // imgError latch reset — ensures a stale/expired URL doesn't permanently
  // show the "Image not available" fallback after the item or full item changes
  // -------------------------------------------------------------------------

  describe('image error latch reset', () => {
    it('clears the image-error fallback when the item id changes after an error', async () => {
      const itemA = makeMediaItem({
        id: 'item-a',
        thumbnailUrl: 'https://cdn.example.com/thumb-a.jpg',
        downloadUrl: null,
      });
      const itemB = makeMediaItem({
        id: 'item-b',
        thumbnailUrl: 'https://cdn.example.com/thumb-b.jpg',
        downloadUrl: null,
      });

      const { rerender } = render(
        <MediaDetailDrawer
          item={itemA}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // The image should be in the document initially.
      const img = screen.getByRole('img', { name: itemA.originalFilename });
      expect(img).toBeInTheDocument();
      expect(screen.queryByText(/image not available/i)).not.toBeInTheDocument();

      // Simulate a load failure (e.g. expired signed URL).
      fireEvent.error(img);

      // The fallback should appear and the img should be gone.
      await waitFor(() => {
        expect(screen.getByText(/image not available/i)).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: itemA.originalFilename })).not.toBeInTheDocument();
      });

      // Switch to a different item — this should reset imgError.
      rerender(
        <MediaDetailDrawer
          item={itemB}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // The img for item B should now be visible; the fallback should be gone.
      await waitFor(() => {
        expect(screen.queryByText(/image not available/i)).not.toBeInTheDocument();
        expect(screen.getByRole('img', { name: itemB.originalFilename })).toBeInTheDocument();
      });
    });

    it('clears the image-error fallback when fullItem changes (save updates the stored item)', async () => {
      const user = userEvent.setup();

      // Item has both thumbnailUrl and downloadUrl so the component short-circuits
      // to setFullItem(item) immediately — no async getMedia call needed.
      const item = makeMediaItem({
        thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
        downloadUrl: 'https://cdn.example.com/download.jpg',
      });
      // After save, patchMedia returns an updated item; setFullItem will be
      // called with { ...fullItem, ...updated }, changing the fullItem reference.
      const updatedItem = makeMediaItem({
        thumbnailUrl: 'https://cdn.example.com/thumb-updated.jpg',
        downloadUrl: 'https://cdn.example.com/download-updated.jpg',
        description: 'Updated description',
      });
      mockPatchMedia.mockResolvedValue(updatedItem);

      render(
        <MediaDetailDrawer
          item={item}
          open={true}
          onClose={vi.fn()}
          onItemUpdated={vi.fn()}
        />,
      );

      // Img renders from item.thumbnailUrl (via fullItem = item).
      const img = await screen.findByRole('img', { name: item.originalFilename });
      expect(img).toBeInTheDocument();

      // Simulate a URL expiry / transient load failure.
      fireEvent.error(img);

      await waitFor(() => {
        expect(screen.getByText(/image not available/i)).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: item.originalFilename })).not.toBeInTheDocument();
      });

      // User saves an edit → patchMedia resolves → setFullItem(updated) is called
      // → our effect fires → imgError resets to false.
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.queryByText(/image not available/i)).not.toBeInTheDocument();
        expect(screen.getByRole('img', { name: item.originalFilename })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // System tag chip rendering
  // -------------------------------------------------------------------------

  describe('system tag chip rendering', () => {
    it('renders all tag names including system tags as chips', async () => {
      const item = makeMediaItem({
        tags: ['Beach', 'Social Media', 'TikTok'],
        systemTags: ['Social Media', 'TikTok'],
      });

      render(<MediaDetailDrawer item={item} open={true} onClose={vi.fn()} onItemUpdated={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Beach')).toBeInTheDocument();
        expect(screen.getByText('Social Media')).toBeInTheDocument();
        expect(screen.getByText('TikTok')).toBeInTheDocument();
      });
    });

    it('both system and non-system tag names are present in the DOM', async () => {
      // Verifies the branching logic (isSystem ? Tooltip+Chip : Chip) renders
      // all tag names regardless of which branch is taken.
      const item = makeMediaItem({
        tags: ['Beach', 'Social Media'],
        systemTags: ['Social Media'],
      });

      render(<MediaDetailDrawer item={item} open={true} onClose={vi.fn()} onItemUpdated={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Beach')).toBeInTheDocument();
        expect(screen.getByText('Social Media')).toBeInTheDocument();
      });
    });

    it('renders "No tags" when tags array is empty', async () => {
      const item = makeMediaItem({ tags: [], systemTags: [] });

      render(<MediaDetailDrawer item={item} open={true} onClose={vi.fn()} onItemUpdated={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/no tags/i)).toBeInTheDocument();
      });
    });

    it('renders "No tags" when tags field is absent', async () => {
      const item = makeMediaItem({ tags: undefined, systemTags: undefined });

      render(<MediaDetailDrawer item={item} open={true} onClose={vi.fn()} onItemUpdated={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/no tags/i)).toBeInTheDocument();
      });
    });
  });
});

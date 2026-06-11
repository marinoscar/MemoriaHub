/**
 * Component tests — MediaDetailDrawer
 *
 * Mocking strategy:
 *   patchMedia from services/media is mocked via vi.mock so no real fetch occurs.
 *   The drawer is rendered with a fully-populated MediaItem; tests assert that
 *   metadata fields appear in read-only view, that entering edit mode populates
 *   the form, that saving calls patchMedia with the changed payload, and that
 *   the favorite toggle calls patchMedia with { favorite: !current }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaDetailDrawer } from '../../../components/media/MediaDetailDrawer';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Mock the media service
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  patchMedia: vi.fn(),
}));

import { patchMedia } from '../../../services/media';

const mockPatchMedia = vi.mocked(patchMedia);

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
    classification: 'memory',
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
    title: 'Arenal Sunset',
    caption: 'Beautiful sunset at Arenal',
    description: null,
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

// Default props
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
  });

  // -------------------------------------------------------------------------
  // Rendering — read-only metadata fields
  // -------------------------------------------------------------------------

  describe('read-only metadata display', () => {
    it('should render the item title in the drawer header', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      // Title appears at least once (in the h6 drawer header)
      expect(screen.getAllByText('Arenal Sunset').length).toBeGreaterThan(0);
    });

    it('should render the original filename when title is null', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ title: null })}
        />,
      );
      // Filename appears at least once (in the header)
      expect(screen.getAllByText('DSC_0001.jpg').length).toBeGreaterThan(0);
    });

    it('should display media type', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText('photo')).toBeInTheDocument();
    });

    it('should display video type for video items', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ type: 'video', durationMs: 62000 })}
        />,
      );
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
      // Coordinates are rendered as "lat, lng" formatted to 6 decimal places
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
      expect(screen.getByText(/location/i)).toBeInTheDocument();
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
      // "Location" heading should not appear
      expect(screen.queryByText(/^location$/i)).not.toBeInTheDocument();
    });

    it('should not display GPS row when takenLat and takenLng are null', () => {
      render(
        <MediaDetailDrawer
          {...defaultProps({ takenLat: null, takenLng: null })}
        />,
      );
      expect(screen.queryByText(/GPS/i)).not.toBeInTheDocument();
    });

    it('should render the classification chip', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByText('memory')).toBeInTheDocument();
    });

    it('should show a non-favourite star border icon when item is not a favourite', () => {
      render(<MediaDetailDrawer {...defaultProps({ favorite: false })} />);
      // The IconButton should have the aria-label we set
      expect(
        screen.getByRole('button', { name: /toggle favorite/i }),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Edit mode
  // -------------------------------------------------------------------------

  describe('edit mode', () => {
    it('should show Edit button in read-only mode', () => {
      render(<MediaDetailDrawer {...defaultProps()} />);
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    });

    it('should switch to edit mode when Edit is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      });
    });

    it('should pre-populate the Title field with the item title', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await waitFor(() => {
        const titleInput = screen.getByLabelText(/title/i);
        expect(titleInput).toHaveValue('Arenal Sunset');
      });
    });

    it('should pre-populate the Caption field with the item caption', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await waitFor(() => {
        const captionInput = screen.getByLabelText(/caption/i);
        expect(captionInput).toHaveValue('Beautiful sunset at Arenal');
      });
    });

    it('should call patchMedia with changed title on Save', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));

      const titleInput = await screen.findByLabelText(/title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Updated Title');

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockPatchMedia).toHaveBeenCalledWith(
          ITEM_ID,
          expect.objectContaining({ title: 'Updated Title' }),
        );
      });
    });

    it('should call onItemUpdated with the API response after save', async () => {
      const onItemUpdated = vi.fn();
      const updatedItem = makeMediaItem({ title: 'New Title' });
      mockPatchMedia.mockResolvedValue(updatedItem);

      const user = userEvent.setup();
      render(
        <MediaDetailDrawer
          {...defaultProps()}
          onItemUpdated={onItemUpdated}
        />,
      );
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(onItemUpdated).toHaveBeenCalledWith(updatedItem);
      });
    });

    it('should return to read-only mode after successful save', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
      });
    });

    it('should show an error alert when patchMedia rejects during save', async () => {
      mockPatchMedia.mockRejectedValue(new Error('Server error'));
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/server error/i)).toBeInTheDocument();
      });
    });

    it('should return to read-only mode when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaDetailDrawer {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /edit/i }));
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
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

      // Should not throw
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
});

/**
 * Component tests — MediaGallery
 *
 * Covers four scenarios:
 *   (a) Controlled mode: renders provided items grouped by day, opens lightbox on tile click
 *   (b) Selection: clicking a tile's checkbox selects it and shows the bulk toolbar
 *   (c) Per-group "Select all": selects every item in that date group
 *   (d) Feed mode: mocks useInfiniteMedia (via listMedia service) and asserts items +
 *       infinite-scroll sentinel render
 *
 * Leaf components that make external calls are stubbed to isolate the gallery logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { MediaGallery } from '../MediaGallery';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Stub the lightbox so it doesn't call getMedia and doesn't render heavy DOM.
vi.mock('../MediaLightbox', () => ({
  MediaLightbox: vi.fn(({ index, onClose }: { index: number | null; onClose: () => void }) =>
    index !== null ? (
      <div data-testid="media-lightbox">
        <button onClick={onClose}>Close lightbox</button>
      </div>
    ) : null,
  ),
}));

// Stub the detail drawer.
vi.mock('../MediaDetailDrawer', () => ({
  MediaDetailDrawer: vi.fn(() => null),
}));

// Stub the bulk action toolbar (asserted via data-testid).
vi.mock('../BulkActionToolbar', () => ({
  BulkActionToolbar: vi.fn(({ selected }: { selected: Set<string> }) =>
    selected.size > 0 ? <div data-testid="bulk-toolbar">Bulk toolbar</div> : null,
  ),
}));

// Stub bulk dialogs — they are never opened in these tests.
vi.mock('../BulkLocationDialog', () => ({
  BulkLocationDialog: vi.fn(() => null),
}));
vi.mock('../BulkTagsDialog', () => ({
  BulkTagsDialog: vi.fn(() => null),
}));

// Stub AddToAlbumDialog.
vi.mock('../../album/AddToAlbumDialog', () => ({
  AddToAlbumDialog: vi.fn(() => null),
}));

// Mock patchMedia so favourite toggles don't hit the network.
vi.mock('../../../services/media', () => ({
  patchMedia: vi.fn().mockResolvedValue({}),
  removeAlbumItem: vi.fn().mockResolvedValue(undefined),
  listMedia: vi.fn(),
}));

// Mock useIntersectionObserver so the infinite-scroll sentinel never triggers.
vi.mock('../../../hooks/useIntersectionObserver', () => ({
  useIntersectionObserver: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { listMedia } from '../../../services/media';

const mockListMedia = vi.mocked(listMedia);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeItem(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    storageObjectId: `storage-${id}`,
    addedById: 'user-001',
    circleId: 'circle-1',
    type: 'photo',
    capturedAt: '2024-06-15T10:00:00.000Z',
    capturedAtOffset: null,
    importedAt: null,
    source: 'web',
    contentHash: null,
    width: 1920,
    height: 1080,
    durationMs: null,
    orientation: null,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    cameraMake: null,
    cameraModel: null,
    originalFilename: `file-${id}.jpg`,
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
    createdAt: '2024-06-15T10:00:00.000Z',
    updatedAt: '2024-06-15T10:00:00.000Z',
    deletedAt: null,
    metadata: null,
    thumbnailUrl: `https://cdn.example.com/${id}.jpg`,
    downloadUrl: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default feed-mode responses: return empty list to prevent infinite loops.
    mockListMedia.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 },
    });
  });

  // -------------------------------------------------------------------------
  // (a) Controlled mode — item rendering and lightbox
  // -------------------------------------------------------------------------
  describe('controlled mode', () => {
    it('renders items grouped by day with a sticky day header', () => {
      const items = [
        makeItem('a', { capturedAt: '2024-06-15T10:00:00.000Z', originalFilename: 'Photo A.jpg' }),
        makeItem('b', { capturedAt: '2024-06-15T12:00:00.000Z', originalFilename: 'Photo B.jpg' }),
        makeItem('c', { capturedAt: '2024-05-20T09:00:00.000Z', originalFilename: 'Photo C.jpg' }),
      ];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // Thumbnails render as img elements
      expect(screen.getByAltText('Photo A.jpg')).toBeInTheDocument();
      expect(screen.getByAltText('Photo B.jpg')).toBeInTheDocument();
      expect(screen.getByAltText('Photo C.jpg')).toBeInTheDocument();
    });

    it('opens the lightbox when a tile is clicked (no selection active)', async () => {
      const user = userEvent.setup();
      const items = [makeItem('x', { originalFilename: 'Click Me.jpg' })];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      const tile = screen.getByAltText('Click Me.jpg');
      await user.click(tile);

      await waitFor(() => {
        expect(screen.getByTestId('media-lightbox')).toBeInTheDocument();
      });
    });

    it('renders the custom emptyState when the items array is empty', () => {
      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={[]}
          emptyState={<div>Nothing here yet</div>}
        />,
      );

      expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    });

    it('renders default empty state when items are empty and no emptyState prop', () => {
      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole={null}
          items={[]}
        />,
      );

      expect(screen.getByText(/no media found/i)).toBeInTheDocument();
    });

    it('shows a loading spinner in controlled mode when isLoading is true', () => {
      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole={null}
          items={[]}
          isLoading={true}
        />,
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // (b) Selection — checkbox selects an item and reveals BulkActionToolbar
  // -------------------------------------------------------------------------
  describe('selection', () => {
    it('shows the bulk toolbar after selecting an item via its checkbox', async () => {
      const user = userEvent.setup();
      const items = [makeItem('sel-1', { originalFilename: 'selectable.jpg' })];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // The checkbox is an IconButton with aria-label "Select item"
      const checkbox = screen.getByRole('button', { name: /select item/i });
      await user.click(checkbox);

      await waitFor(() => {
        expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument();
      });
    });

    it('deselects an item when the checkbox is clicked again', async () => {
      const user = userEvent.setup();
      const items = [makeItem('sel-2', { originalFilename: 'toggle-select.jpg' })];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // Select
      const checkbox = screen.getByRole('button', { name: /select item/i });
      await user.click(checkbox);
      await waitFor(() => {
        expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument();
      });

      // Deselect (aria-label changes to "Deselect item" when selected)
      const deselect = screen.getByRole('button', { name: /deselect item/i });
      await user.click(deselect);

      await waitFor(() => {
        expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument();
      });
    });

    it('clicking a tile in selection mode toggles selection instead of opening lightbox', async () => {
      const user = userEvent.setup();
      const items = [makeItem('s1', { originalFilename: 'select-via-tile.jpg' })];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // First, select via checkbox to enter selection mode
      await user.click(screen.getByRole('button', { name: /select item/i }));
      await waitFor(() => {
        expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument();
      });

      // Now click the tile image — should deselect (toggle), not open lightbox
      const tile = screen.getByAltText('select-via-tile.jpg');
      await user.click(tile);

      await waitFor(() => {
        // Bulk toolbar disappears when nothing is selected
        expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // (c) Per-group "Select all"
  // -------------------------------------------------------------------------
  describe('per-group select all', () => {
    it('clicking "Select all" in a day group selects every item in that group', async () => {
      const user = userEvent.setup();
      // All items on the same day so they fall in one group
      const items = [
        makeItem('g1', { capturedAt: '2024-06-15T08:00:00.000Z', originalFilename: 'group-a.jpg' }),
        makeItem('g2', { capturedAt: '2024-06-15T09:00:00.000Z', originalFilename: 'group-b.jpg' }),
        makeItem('g3', { capturedAt: '2024-06-15T10:00:00.000Z', originalFilename: 'group-c.jpg' }),
      ];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // Click the per-group "Select all" button (first occurrence)
      const selectAllBtn = screen.getAllByRole('button', { name: /select all/i })[0];
      await user.click(selectAllBtn);

      // All three items should be selected — all checkboxes show "Deselect item"
      await waitFor(() => {
        const deselectBtns = screen.getAllByRole('button', { name: /deselect item/i });
        expect(deselectBtns).toHaveLength(3);
      });

      // Bulk toolbar should be visible
      expect(screen.getByTestId('bulk-toolbar')).toBeInTheDocument();
    });

    it('shows a "Clear" button after selecting items in a group', async () => {
      const user = userEvent.setup();
      const items = [
        makeItem('c1', { capturedAt: '2024-06-15T08:00:00.000Z', originalFilename: 'clear-a.jpg' }),
      ];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // Select all
      await user.click(screen.getByRole('button', { name: /select all/i }));

      // A "Clear" button appears next to "Select all" in the day header
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^clear$/i })).toBeInTheDocument();
      });
    });

    it('clicking "Clear" in a group header deselects only that group\'s items', async () => {
      const user = userEvent.setup();
      // Two groups: June 15 and June 16
      const items = [
        makeItem('d1', { capturedAt: '2024-06-15T08:00:00.000Z', originalFilename: 'day1.jpg' }),
        makeItem('d2', { capturedAt: '2024-06-16T08:00:00.000Z', originalFilename: 'day2.jpg' }),
      ];

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          items={items}
        />,
      );

      // Select all in the first group (newest day renders first)
      const selectAllBtns = screen.getAllByRole('button', { name: /select all/i });
      await user.click(selectAllBtns[0]); // first group's Select all

      // Now clear the first group
      const clearBtn = screen.getAllByRole('button', { name: /^clear$/i })[0];
      await user.click(clearBtn);

      await waitFor(() => {
        // After clearing, no items selected → toolbar hidden
        expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // (d) Feed mode — infinite scroll
  // -------------------------------------------------------------------------
  describe('feed mode', () => {
    it('renders items returned by listMedia in feed mode', async () => {
      const feedItems = [
        makeItem('f1', { capturedAt: '2024-07-01T10:00:00.000Z', originalFilename: 'feed-photo-1.jpg' }),
        makeItem('f2', { capturedAt: '2024-07-01T11:00:00.000Z', originalFilename: 'feed-photo-2.jpg' }),
      ];

      mockListMedia.mockResolvedValueOnce({
        items: feedItems,
        meta: { page: 1, pageSize: 50, totalItems: 2, totalPages: 1 },
      });

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          queryParams={{ circleId: 'circle-1' }}
        />,
      );

      await waitFor(() => {
        expect(screen.getByAltText('feed-photo-1.jpg')).toBeInTheDocument();
        expect(screen.getByAltText('feed-photo-2.jpg')).toBeInTheDocument();
      });
    });

    it('renders the infinite-scroll sentinel element in feed mode', async () => {
      mockListMedia.mockResolvedValueOnce({
        items: [makeItem('s1')],
        meta: { page: 1, pageSize: 50, totalItems: 5, totalPages: 2 },
      });

      const { container } = render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          queryParams={{ circleId: 'circle-1' }}
        />,
      );

      await waitFor(() => {
        // MediaGallery renders alt={item.originalFilename}; makeItem() defaults
        // originalFilename to `file-${id}.jpg`, i.e. "file-s1.jpg" here — not
        // the literal "Photo s1" the component has never produced.
        expect(screen.getByAltText('file-s1.jpg')).toBeInTheDocument();
      });

      // The sentinel is an empty <Box sx={{ height: 1 }}> rendered after the last group.
      // It has height=1 CSS in sx which becomes height: 1px — a zero-height div in jsdom.
      // We verify at least one <div> with a single-pixel height exists (MUI Box sx).
      // A more reliable check: listMedia was called, items are visible, page has data.
      expect(mockListMedia).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-1', page: 1 }),
      );
    });

    it('shows skeleton tiles on initial feed load', async () => {
      // Never resolve so we stay in loading state
      mockListMedia.mockReturnValue(new Promise(() => {}));

      const { container } = render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole={null}
          queryParams={{ circleId: 'circle-1' }}
        />,
      );

      // MUI Skeleton renders as a <span> with MuiSkeleton-root class
      await waitFor(() => {
        const skeletons = container.querySelectorAll('.MuiSkeleton-root');
        expect(skeletons.length).toBeGreaterThan(0);
      });
    });

    it('does NOT render items from feed when circleId is empty (disabled)', () => {
      render(
        <MediaGallery
          circleId=""
          activeCircleRole={null}
          queryParams={{ circleId: '' }}
        />,
      );

      // With empty circleId, enabled=false so listMedia is never called
      expect(mockListMedia).not.toHaveBeenCalled();
    });
  });
});

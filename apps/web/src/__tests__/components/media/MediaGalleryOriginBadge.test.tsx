/**
 * MediaGallery / GalleryTile — burst/duplicate "origin" badge tests (issue #163).
 *
 * Covers:
 *   - Badge renders for a burstGroupId when showOriginBadge is true (archive/trash mode)
 *   - Badge renders for a duplicateGroupId when burstGroupId is null
 *   - Badge does NOT render when both group ids are null, even in archive/trash mode
 *   - Badge does NOT render in a non-archive/non-trash mode (e.g. 'home'), even with
 *     a burstGroupId set
 *   - Clicking the badge navigates to /bursts/:id or /duplicates/:id and does NOT
 *     trigger the tile's own select/lightbox handler (stopPropagation)
 *   - Burst takes precedence over duplicate when both ids are (defensively) set
 *
 * Heavy sibling components (lightbox, detail drawer, bulk dialogs) are stubbed so
 * these tests stay focused on GalleryTile's origin-badge rendering and click
 * behavior. The various bulk toolbars (ArchiveBulkToolbar / TrashBulkToolbar /
 * BulkActionToolbar) all render `null` when nothing is selected — which is always
 * the case in these tests — so they are left unmocked, matching the existing
 * `src/components/media/__tests__/MediaGallery.test.tsx` convention.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaGallery } from '../../../components/media/MediaGallery';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Mock react-router-dom's useNavigate (keep everything else real, notably
// MemoryRouter used by the shared render() helper).
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Stub the lightbox so we can assert whether it opened (or not) without
// pulling in its heavy internals. Renders a marker div only when a tile was
// actually selected (index !== null).
vi.mock('../../../components/media/MediaLightbox', () => ({
  MediaLightbox: vi.fn(({ index }: { index: number | null }) =>
    index !== null ? <div data-testid="media-lightbox" /> : null,
  ),
}));

// Stub the detail drawer — not under test here.
vi.mock('../../../components/media/MediaDetailDrawer', () => ({
  MediaDetailDrawer: vi.fn(() => null),
}));

// Stub bulk dialogs that are never opened in these tests.
vi.mock('../../../components/media/BulkLocationDialog', () => ({
  BulkLocationDialog: vi.fn(() => null),
}));
vi.mock('../../../components/media/BulkTagsDialog', () => ({
  BulkTagsDialog: vi.fn(() => null),
}));
vi.mock('../../../components/album/AddToAlbumDialog', () => ({
  AddToAlbumDialog: vi.fn(() => null),
}));

// Mock the media service. Only `getThumbnails` (consulted by
// usePendingThumbnails) is actually exercised — every fixture below already
// has a thumbnailUrl, so nothing is "pending" and it's never called. The
// remaining functions are referenced only inside unmocked sibling components'
// click handlers, which are never triggered because nothing is selected.
vi.mock('../../../services/media', () => ({
  patchMedia: vi.fn().mockResolvedValue({}),
  removeAlbumItem: vi.fn().mockResolvedValue(undefined),
  listMedia: vi.fn(),
  getThumbnails: vi.fn().mockResolvedValue([]),
  bulkArchive: vi.fn(),
  bulkUnarchive: vi.fn(),
  bulkDelete: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
  bulkRerunTags: vi.fn(),
  bulkRerunFaces: vi.fn(),
  bulkRerunThumbnails: vi.fn(),
  restoreFromTrash: vi.fn(),
  deleteForever: vi.fn(),
}));

// Mock useIntersectionObserver so the infinite-scroll sentinel never triggers.
vi.mock('../../../hooks/useIntersectionObserver', () => ({
  useIntersectionObserver: vi.fn(),
}));

// Mock MediaPreviewContext — no stored local-upload preview for any id.
vi.mock('../../../contexts/MediaPreviewContext', () => ({
  useMediaPreview: vi.fn(() => ({
    addPreview: vi.fn(),
    getPreview: vi.fn(() => undefined),
    removePreview: vi.fn(),
    version: 0,
  })),
}));

// ---------------------------------------------------------------------------
// Fixtures
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
    coordSource: null,
    createdAt: '2024-06-15T10:00:00.000Z',
    updatedAt: '2024-06-15T10:00:00.000Z',
    deletedAt: null,
    archivedAt: null,
    burstGroupId: null,
    duplicateGroupId: null,
    metadata: null,
    thumbnailUrl: `https://cdn.example.com/${id}.jpg`,
    downloadUrl: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaGallery / GalleryTile — origin badge (issue #163)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('badge rendering', () => {
    it('renders a burst badge when the item has a burstGroupId and showOriginBadge is true (archive mode)', () => {
      const items = [makeItem('a1', { burstGroupId: 'burst-1', duplicateGroupId: null })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="archive" items={items} />,
      );

      expect(screen.getByRole('button', { name: /view burst group/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view duplicate group/i })).not.toBeInTheDocument();
    });

    it('renders a duplicate badge when duplicateGroupId is set and burstGroupId is null (trash mode)', () => {
      const items = [makeItem('a2', { burstGroupId: null, duplicateGroupId: 'dup-1' })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="trash" items={items} />,
      );

      expect(screen.getByRole('button', { name: /view duplicate group/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view burst group/i })).not.toBeInTheDocument();
    });

    it('does NOT render any badge when both burstGroupId and duplicateGroupId are null, even in archive mode', () => {
      const items = [makeItem('a3', { burstGroupId: null, duplicateGroupId: null })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="archive" items={items} />,
      );

      expect(screen.queryByRole('button', { name: /view burst group/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view duplicate group/i })).not.toBeInTheDocument();
    });

    it('does NOT render any badge when both burstGroupId and duplicateGroupId are null, in trash mode', () => {
      const items = [makeItem('a3b', { burstGroupId: null, duplicateGroupId: null })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="trash" items={items} />,
      );

      expect(screen.queryByRole('button', { name: /view burst group/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view duplicate group/i })).not.toBeInTheDocument();
    });

    it('does NOT render a badge in home mode even when the item has a burstGroupId', () => {
      const items = [makeItem('a4', { burstGroupId: 'burst-1' })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="home" items={items} />,
      );

      expect(screen.queryByRole('button', { name: /view burst group/i })).not.toBeInTheDocument();
    });

    it('does NOT render a badge in the default mode (mode prop omitted) even when the item has a duplicateGroupId', () => {
      const items = [makeItem('a5', { duplicateGroupId: 'dup-1' })];

      render(<MediaGallery circleId="circle-1" activeCircleRole="circle_admin" items={items} />);

      expect(screen.queryByRole('button', { name: /view duplicate group/i })).not.toBeInTheDocument();
    });

    it('burst badge takes precedence over duplicate badge when both ids are set', () => {
      const items = [
        makeItem('a6', { burstGroupId: 'burst-1', duplicateGroupId: 'dup-1' }),
      ];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="archive" items={items} />,
      );

      expect(screen.getByRole('button', { name: /view burst group/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view duplicate group/i })).not.toBeInTheDocument();
    });
  });

  describe('badge click behavior', () => {
    it('clicking the burst badge navigates to /bursts/:id and does not open the lightbox', async () => {
      const user = userEvent.setup();
      const items = [makeItem('b1', { burstGroupId: 'burst-42', duplicateGroupId: null })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="archive" items={items} />,
      );

      await user.click(screen.getByRole('button', { name: /view burst group/i }));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/bursts/burst-42');
      });
      // stopPropagation on the badge's onClick means the tile's own onClick
      // (which would open the lightbox) must never fire.
      expect(screen.queryByTestId('media-lightbox')).not.toBeInTheDocument();
    });

    it('clicking the duplicate badge navigates to /duplicates/:id and does not open the lightbox', async () => {
      const user = userEvent.setup();
      const items = [makeItem('b2', { burstGroupId: null, duplicateGroupId: 'dup-99' })];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="trash" items={items} />,
      );

      await user.click(screen.getByRole('button', { name: /view duplicate group/i }));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/duplicates/dup-99');
      });
      expect(screen.queryByTestId('media-lightbox')).not.toBeInTheDocument();
    });

    it('clicking elsewhere on the tile (not the badge) still opens the lightbox as normal', async () => {
      const user = userEvent.setup();
      const items = [
        makeItem('b3', { burstGroupId: 'burst-1', originalFilename: 'tile-click.jpg' }),
      ];

      render(
        <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="archive" items={items} />,
      );

      await user.click(screen.getByAltText('tile-click.jpg'));

      await waitFor(() => {
        expect(screen.getByTestId('media-lightbox')).toBeInTheDocument();
      });
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});

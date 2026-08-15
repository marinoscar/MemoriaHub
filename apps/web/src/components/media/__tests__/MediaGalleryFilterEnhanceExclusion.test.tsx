/**
 * MediaGallery — "Enhance all matching" is unreachable from Archive/Trash
 * (issue #424, epic #420 phase 4).
 *
 * `filterEnhanceTarget` (the target that drives the "Enhance all matching"
 * batch-enhance entry point) is derived only in `mode === 'home'`; Archive and
 * Trash swap in entirely SEPARATE toolbar components (`ArchiveBulkToolbar` /
 * `TrashBulkToolbar`) that carry the filter-enhance affordance nowhere at all.
 * Rather than asserting the internal derivation directly (a white-box check
 * that could pass even if a future edit wired the callback into the wrong
 * toolbar), this renders the REAL toolbars with an item selected and proves,
 * black-box, that "Enhance all matching" never appears anywhere in the tree
 * while confirming the mode-appropriate toolbar genuinely mounted.
 *
 * Mocking strategy mirrors MediaGalleryOriginBadge.test.tsx: heavy sibling
 * components (lightbox, detail drawer, bulk dialogs) are stubbed, but the
 * bulk TOOLBARS themselves are left real — the whole point of this file is to
 * exercise their actual rendered content once something is selected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { MediaGallery } from '../MediaGallery';
import { listMedia } from '../../../services/media';
import type { MediaItem } from '../../../types/media';
import type { PictureEnhancementPolicy } from '../../../services/features';

const mockListMedia = vi.mocked(listMedia);

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../MediaLightbox', () => ({ MediaLightbox: vi.fn(() => null) }));
vi.mock('../MediaDetailDrawer', () => ({ MediaDetailDrawer: vi.fn(() => null) }));
vi.mock('../BulkLocationDialog', () => ({ BulkLocationDialog: vi.fn(() => null) }));
vi.mock('../BulkTagsDialog', () => ({ BulkTagsDialog: vi.fn(() => null) }));
vi.mock('../../album/AddToAlbumDialog', () => ({ AddToAlbumDialog: vi.fn(() => null) }));

// The "control group" test uses FEED mode (queryParams) to give
// filterEnhanceTarget a genuine active filter to work with; the infinite-
// scroll sentinel is neutered so it never fires an unexpected page-2 load.
vi.mock('../../../hooks/useIntersectionObserver', () => ({
  useIntersectionObserver: vi.fn(),
}));

vi.mock('../../../contexts/MediaPreviewContext', () => ({
  useMediaPreview: vi.fn(() => ({
    addPreview: vi.fn(),
    getPreview: vi.fn(() => undefined),
    removePreview: vi.fn(),
    version: 0,
  })),
}));

// The feature is deliberately ON here — if "Enhance all matching" could ever
// leak into Archive/Trash, this is the config that would reveal it; leaving
// it off would make the absence trivially true for the wrong reason.
const enabledPictureEnhancement: PictureEnhancementPolicy = {
  enabled: true,
  allowReplace: true,
  blockReplaceOnDownscale: false,
  model: null,
  maxBatchSize: 25,
};
vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(() => ({
    features: {},
    pictureEnhancement: enabledPictureEnhancement,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

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
  bulkEnhance: vi.fn(),
  bulkEnhanceByFilter: vi.fn(),
  restoreFromTrash: vi.fn(),
  deleteForever: vi.fn(),
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
    metadata: null,
    thumbnailUrl: `https://cdn.example.com/${id}.jpg`,
    downloadUrl: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaGallery — "Enhance all matching" is unreachable from Archive/Trash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('archive mode: "Enhance all matching" never appears, even with an item selected and the feature on', async () => {
    const user = userEvent.setup();
    const items = [makeItem('a1')];

    render(
      <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="archive" items={items} />,
    );

    // Select the item so the mode-appropriate toolbar actually mounts.
    const checkbox = screen.getByRole('button', { name: /select item/i });
    await user.click(checkbox);

    // Confirms ArchiveBulkToolbar (not BulkActionToolbar) is the live toolbar
    // — checked BEFORE opening the menu below, since MUI marks the rest of
    // the page aria-hidden while a Menu popover is open.
    expect(screen.getByRole('button', { name: /unarchive selected/i })).toBeInTheDocument();
    expect(screen.queryByText(/enhance all matching/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ai enhance/i)).not.toBeInTheDocument();

    // ArchiveBulkToolbar's own "More actions" overflow menu has no enhance
    // item at all, so the absence above is not merely "the menu was never
    // opened" — it genuinely isn't anywhere in this toolbar.
    const moreButton = screen.getByRole('button', { name: /more actions/i });
    await user.click(moreButton);

    expect(await screen.findByRole('menuitem', { name: /move to trash/i })).toBeInTheDocument();
    expect(screen.queryByText(/enhance all matching/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ai enhance/i)).not.toBeInTheDocument();
  });

  it('trash mode: "Enhance all matching" never appears, even with an item selected and the feature on', async () => {
    const user = userEvent.setup();
    const items = [makeItem('t1', { deletedAt: '2024-06-16T00:00:00.000Z' })];

    render(
      <MediaGallery circleId="circle-1" activeCircleRole="circle_admin" mode="trash" items={items} />,
    );

    const checkbox = screen.getByRole('button', { name: /select item/i });
    await user.click(checkbox);

    await waitFor(() => {
      expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/enhance all matching/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ai enhance/i)).not.toBeInTheDocument();
  });

  it('home mode (same feature config, same selection) DOES expose "Enhance all matching" when a filter is active — the control group proving the exclusion above is mode-specific, not a broken feature everywhere', async () => {
    const user = userEvent.setup();
    mockListMedia.mockResolvedValueOnce({
      items: [makeItem('h1')],
      meta: { pageSize: 50, nextCursor: null, hasMore: false },
    });

    render(
      <MediaGallery
        circleId="circle-1"
        activeCircleRole="circle_admin"
        mode="home"
        // FEED mode with a genuinely active filter — this is what makes
        // `filterEnhanceTarget` non-null and the menu item reachable.
        queryParams={{ circleId: 'circle-1', tag: 'Beach' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByAltText('file-h1.jpg')).toBeInTheDocument();
    });

    const checkbox = screen.getByRole('button', { name: /select item/i });
    await user.click(checkbox);

    const moreButton = await screen.findByRole('button', { name: /more actions/i });
    await user.click(moreButton);

    expect(screen.getByText('Enhance all matching')).toBeInTheDocument();
  });
});

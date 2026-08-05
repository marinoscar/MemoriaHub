/**
 * Component tests — MediaGallery bulk-success feed handling (issue #242)
 *
 * Regression guard for "editing a media item from the gallery discards the
 * loaded feed and jumps back to the top". `handleBulkSuccess` used to call
 * `feedReset()` for EVERY bulk action, which emptied the item list, refetched
 * page 1 and collapsed the document so the browser clamped scroll to the top.
 *
 * The contract these tests pin down:
 *   - a METADATA bulk success (location/date/tags/favorite/album/reruns) never
 *     empties the list, never remounts the grid, refetches only the affected
 *     ids via getMedia, and leaves unaffected items object-identical;
 *   - a MEMBERSHIP bulk success (archive/trash/restore/…) removes exactly the
 *     affected ids in place, with no page-1 refetch;
 *   - the getMedia refresh is chunked, so a 500-id selection cannot fire 500
 *     parallel requests.
 *
 * Scroll position itself is not asserted directly (jsdom has no layout); it is
 * a consequence of the document not collapsing, which the "list is intact +
 * grid not remounted + no refetch" assertions below stand in for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { BULK_REFRESH_CHUNK_SIZE, MediaGallery } from '../MediaGallery';
import type { BulkEffect, BulkSuccessOptions } from '../BulkActionToolbar';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Capture the item list the gallery hands downstream, so object identity of
// unaffected items can be asserted across a bulk success.
const lightboxItems: MediaItem[][] = [];
vi.mock('../MediaLightbox', () => ({
  MediaLightbox: vi.fn(({ items }: { items: MediaItem[] }) => {
    lightboxItems.push(items);
    return null;
  }),
}));

vi.mock('../MediaDetailDrawer', () => ({ MediaDetailDrawer: vi.fn(() => null) }));
vi.mock('../MediaEnhancementDrawer', () => ({ MediaEnhancementDrawer: vi.fn(() => null) }));
vi.mock('../BulkLocationDialog', () => ({ BulkLocationDialog: vi.fn(() => null) }));
vi.mock('../BulkDateDialog', () => ({ BulkDateDialog: vi.fn(() => null) }));
vi.mock('../BulkTagsDialog', () => ({ BulkTagsDialog: vi.fn(() => null) }));
vi.mock('../../album/AddToAlbumDialog', () => ({ AddToAlbumDialog: vi.fn(() => null) }));

// Test harness toolbar: exposes the two completion paths as plain buttons so a
// test can fire either one against whatever is currently selected.
vi.mock('../BulkActionToolbar', () => ({
  BulkActionToolbar: vi.fn(
    ({
      onSelectAll,
      onSuccess,
    }: {
      onSelectAll: () => void;
      onSuccess: (message: string, effect?: BulkEffect) => void;
    }) => (
      <div>
        <button onClick={onSelectAll}>harness-select-all</button>
        <button onClick={() => onSuccess('Updated 1 item')}>harness-metadata</button>
        <button onClick={() => onSuccess('Archived 1 item', 'membership')}>
          harness-membership
        </button>
      </div>
    ),
  ),
}));

// Trash harness toolbar: reports a partial restore — 'restored everything the
// server accepted', with one id handed back as a conflict.
vi.mock('../TrashBulkToolbar', () => ({
  TrashBulkToolbar: vi.fn(
    ({
      onSelectAll,
      onSuccess,
    }: {
      onSelectAll: () => void;
      onSuccess: (message: string, options?: BulkSuccessOptions) => void;
    }) => (
      <div>
        <button onClick={onSelectAll}>harness-trash-select-all</button>
        <button
          onClick={() =>
            onSuccess(
              'Restored 2 items. 1 item could not be restored (duplicate already exists).',
              { retainedIds: ['t2'] },
            )
          }
        >
          harness-restore-with-conflict
        </button>
      </div>
    ),
  ),
}));

vi.mock('../../../services/media', () => ({
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  getThumbnails: vi.fn().mockResolvedValue([]),
  patchMedia: vi.fn().mockResolvedValue({}),
  removeAlbumItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../hooks/useIntersectionObserver', () => ({
  useIntersectionObserver: vi.fn(),
}));

vi.mock('../../../contexts/MediaPreviewContext', () => ({
  useMediaPreview: vi.fn(),
}));

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(() => ({
    features: null,
    pictureEnhancement: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { getMedia, listMedia } from '../../../services/media';
import { useMediaPreview } from '../../../contexts/MediaPreviewContext';

const mockListMedia = vi.mocked(listMedia);
const mockGetMedia = vi.mocked(getMedia);
const mockUseMediaPreview = vi.mocked(useMediaPreview);

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

/** Render the gallery in FEED mode seeded with a single page of `items`. */
async function renderFeed(items: MediaItem[], mode: 'home' | 'trash' | 'archive' = 'home') {
  mockListMedia.mockResolvedValue({
    items,
    meta: { pageSize: 50, nextCursor: null, hasMore: false },
  });

  const result = render(
    <MediaGallery
      circleId="circle-1"
      activeCircleRole="circle_admin"
      mode={mode}
      queryParams={{ circleId: 'circle-1' }}
    />,
  );

  await waitFor(() => {
    expect(screen.getByAltText(items[0].originalFilename!)).toBeInTheDocument();
  });

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaGallery bulk success — loaded feed is preserved (issue #242)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lightboxItems.length = 0;
    mockGetMedia.mockImplementation((id: string) =>
      Promise.resolve(makeItem(id, { favorite: true })),
    );
    mockUseMediaPreview.mockReturnValue({
      addPreview: vi.fn(),
      getPreview: vi.fn(() => undefined),
      removePreview: vi.fn(),
      version: 0,
    });
  });

  // -------------------------------------------------------------------------
  // Metadata path
  // -------------------------------------------------------------------------

  it('keeps the loaded items and does not refetch page 1 after a metadata bulk success', async () => {
    const user = userEvent.setup();
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    await renderFeed(items);

    expect(mockListMedia).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText('harness-select-all'));
    await user.click(screen.getByText('harness-metadata'));

    // Every affected id is refreshed in place...
    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledTimes(3);
    });
    expect(mockGetMedia.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c']);

    // ...the list is never emptied...
    expect(screen.getByAltText('file-a.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('file-b.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('file-c.jpg')).toBeInTheDocument();

    // ...and the feed is never reset (a reset refetches page 1).
    expect(mockListMedia).toHaveBeenCalledTimes(1);

    // The refetched values actually land (favorite: true → the static badge).
    await waitFor(() => {
      expect(screen.getAllByRole('img', { name: /^favorite$/i })).toHaveLength(3);
    });
  });

  it('does not remount the day-group grid on a metadata bulk success', async () => {
    const user = userEvent.setup();
    const items = [makeItem('a'), makeItem('b')];
    const { container } = await renderFeed(items);

    const groupBefore = container.querySelector('[id^="group-"]');
    expect(groupBefore).not.toBeNull();

    await user.click(screen.getByText('harness-select-all'));
    await user.click(screen.getByText('harness-metadata'));
    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledTimes(2);
    });

    // Same DOM node — React reconciled in place rather than tearing the grid
    // down and rebuilding it from an empty list.
    expect(container.querySelector('[id^="group-"]')).toBe(groupBefore);
  });

  it('leaves unaffected items object-identical across a metadata bulk success', async () => {
    const user = userEvent.setup();
    const items = [makeItem('a'), makeItem('kept')];
    await renderFeed(items);

    const before = lightboxItems[lightboxItems.length - 1];
    const keptBefore = before.find((i) => i.id === 'kept');
    const affectedBefore = before.find((i) => i.id === 'a');

    // Select only 'a' via its tile checkbox, then complete a metadata action.
    const checkboxes = screen.getAllByRole('button', { name: /select item/i });
    await user.click(checkboxes[0]);
    await user.click(screen.getByText('harness-metadata'));

    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const after = lightboxItems[lightboxItems.length - 1];
      expect(after.find((i) => i.id === 'a')).not.toBe(affectedBefore);
    });

    const after = lightboxItems[lightboxItems.length - 1];
    expect(after.find((i) => i.id === 'kept')).toBe(keptBefore);
  });

  it('still merges the successful refetches when one id fails', async () => {
    const user = userEvent.setup();
    const items = [makeItem('ok'), makeItem('boom')];
    mockGetMedia.mockImplementation((id: string) =>
      id === 'boom'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve(makeItem(id, { favorite: true })),
    );

    await renderFeed(items);
    await user.click(screen.getByText('harness-select-all'));
    await user.click(screen.getByText('harness-metadata'));

    // The successful id is patched; the failed one is left as it was, and
    // neither the list nor the feed is thrown away.
    await waitFor(() => {
      expect(screen.getAllByRole('img', { name: /^favorite$/i })).toHaveLength(1);
    });
    expect(screen.getByAltText('file-ok.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('file-boom.jpg')).toBeInTheDocument();
    expect(mockListMedia).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Membership path
  // -------------------------------------------------------------------------

  it('removes exactly the affected ids on a membership bulk success, without a page-1 refetch', async () => {
    const user = userEvent.setup();
    const items = [makeItem('m1'), makeItem('m2'), makeItem('m3')];
    await renderFeed(items);

    // Select only the middle item.
    const checkboxes = screen.getAllByRole('button', { name: /select item/i });
    await user.click(checkboxes[1]);
    await user.click(screen.getByText('harness-membership'));

    await waitFor(() => {
      expect(screen.queryByAltText('file-m2.jpg')).not.toBeInTheDocument();
    });
    expect(screen.getByAltText('file-m1.jpg')).toBeInTheDocument();
    expect(screen.getByAltText('file-m3.jpg')).toBeInTheDocument();

    // No reset, and no pointless per-item refetch of items that just left.
    expect(mockListMedia).toHaveBeenCalledTimes(1);
    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('removes every selected id on a bulk membership action', async () => {
    const user = userEvent.setup();
    await renderFeed([makeItem('x1'), makeItem('x2')]);

    await user.click(screen.getByText('harness-select-all'));
    await user.click(screen.getByText('harness-membership'));

    await waitFor(() => {
      expect(screen.getByText(/no media found/i)).toBeInTheDocument();
    });
    expect(mockListMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps a conflicted Trash restore visible and removes only the restored ids', async () => {
    const user = userEvent.setup();
    // The server restores t1 and t3 but hands t2 back in conflicts[]: its
    // content hash collides with an active item, so it is still in Trash.
    await renderFeed([makeItem('t1'), makeItem('t2'), makeItem('t3')], 'trash');

    await user.click(screen.getByText('harness-trash-select-all'));
    await user.click(screen.getByText('harness-restore-with-conflict'));

    await waitFor(() => {
      expect(screen.queryByAltText('file-t1.jpg')).not.toBeInTheDocument();
    });
    expect(screen.queryByAltText('file-t3.jpg')).not.toBeInTheDocument();

    // The item the server refused to restore stays exactly where it was, so the
    // list agrees with the "1 item could not be restored" message.
    expect(screen.getByAltText('file-t2.jpg')).toBeInTheDocument();
    expect(
      screen.getByText(/1 item could not be restored \(duplicate already exists\)/i),
    ).toBeInTheDocument();

    expect(mockListMedia).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Chunking
  // -------------------------------------------------------------------------

  it('chunks the getMedia refresh — 60 ids issue 3 batches, never 60 parallel calls', async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 60 }, (_, i) => makeItem(`chunk-${i}`));

    // Count concurrency: each call increments on entry and decrements after a
    // microtask, so a chunk's calls all overlap and chunks never do.
    let inFlight = 0;
    let maxInFlight = 0;
    let batches = 0;
    mockGetMedia.mockImplementation(async (id: string) => {
      inFlight += 1;
      if (inFlight === 1) batches += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return makeItem(id);
    });

    await renderFeed(items);
    await user.click(screen.getByText('harness-select-all'));
    await user.click(screen.getByText('harness-metadata'));

    await waitFor(() => {
      expect(mockGetMedia).toHaveBeenCalledTimes(60);
    });

    expect(BULK_REFRESH_CHUNK_SIZE).toBe(25);
    expect(maxInFlight).toBe(BULK_REFRESH_CHUNK_SIZE);
    // ceil(60 / 25) = 3
    expect(batches).toBe(3);
  });
});

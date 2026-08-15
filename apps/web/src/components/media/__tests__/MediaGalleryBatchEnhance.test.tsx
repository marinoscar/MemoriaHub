/**
 * Component tests — MediaGallery multi-photo AI Enhance wiring
 * (issue #422, epic #420 phase 2).
 *
 * Covers:
 *   - `selectedItems`/`selectedPhotos` derivation, INCLUDING a selection that
 *     spans a paginated append (ids selected on page 1 still resolve after
 *     page 2 is merged into `mergedItems`).
 *   - The post-submit snackbar uses the SERVER's `result.queued`, never the
 *     client's selection size, and surfaces the skipped summary when
 *     `queued < requested`.
 *   - The selection is cleared after a successful batch submit.
 *
 * `BulkActionToolbar` is replaced with a harness that surfaces the exact
 * `selectedItems` prop MediaGallery computed (so raw derivation can be
 * asserted without depending on the real toolbar's rendering) plus a trigger
 * for `onOpenBatchEnhance`. `BatchEnhanceDialog` itself is left UNMOCKED —
 * the preset -> submit -> bulkEnhance -> snackbar/selection-clear flow is
 * exercised through the real component, mirroring MediaGalleryFeedState's
 * "drive the real completion wiring" approach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { MediaGallery } from '../MediaGallery';
import type { MediaItem } from '../../../types/media';
import type { BulkEnhanceResult } from '../../../services/media';
import type { PictureEnhancementPolicy } from '../../../services/features';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../MediaLightbox', () => ({ MediaLightbox: vi.fn(() => null) }));
vi.mock('../MediaDetailDrawer', () => ({ MediaDetailDrawer: vi.fn(() => null) }));
vi.mock('../MediaEnhancementDrawer', () => ({ MediaEnhancementDrawer: vi.fn(() => null) }));
vi.mock('../BulkLocationDialog', () => ({ BulkLocationDialog: vi.fn(() => null) }));
vi.mock('../BulkDateDialog', () => ({ BulkDateDialog: vi.fn(() => null) }));
vi.mock('../BulkTagsDialog', () => ({ BulkTagsDialog: vi.fn(() => null) }));
vi.mock('../../album/AddToAlbumDialog', () => ({ AddToAlbumDialog: vi.fn(() => null) }));

// Captures every prop set BulkActionToolbar was rendered with, so a test can
// inspect the exact `selectedItems` array MediaGallery derived — the harness
// also exposes a plain button for `onOpenBatchEnhance` so the real
// BatchEnhanceDialog (left unmocked below) can be driven end-to-end.
interface CapturedToolbarProps {
  selected: Set<string>;
  selectedItems?: MediaItem[];
  onOpenBatchEnhance?: () => void;
}
const toolbarCalls: CapturedToolbarProps[] = [];
vi.mock('../BulkActionToolbar', () => ({
  BulkActionToolbar: vi.fn((props: CapturedToolbarProps) => {
    toolbarCalls.push(props);
    if (props.selected.size === 0) return null;
    return (
      <div>
        <div data-testid="bulk-toolbar">Bulk toolbar ({props.selected.size})</div>
        {props.onOpenBatchEnhance && (
          <button onClick={props.onOpenBatchEnhance}>harness-open-batch-enhance</button>
        )}
      </div>
    );
  }),
}));

vi.mock('../../../services/media', () => ({
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  getThumbnails: vi.fn().mockResolvedValue([]),
  patchMedia: vi.fn().mockResolvedValue({}),
  removeAlbumItem: vi.fn().mockResolvedValue(undefined),
  bulkEnhance: vi.fn(),
}));

vi.mock('../../../hooks/useIntersectionObserver', () => ({
  useIntersectionObserver: vi.fn(),
}));

vi.mock('../../../contexts/MediaPreviewContext', () => ({
  useMediaPreview: vi.fn(),
}));

const mockPictureEnhancement: PictureEnhancementPolicy = {
  enabled: true,
  allowReplace: true,
  blockReplaceOnDownscale: false,
  model: null,
  maxBatchSize: 25,
};
vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(() => ({
    features: null,
    pictureEnhancement: mockPictureEnhancement,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { listMedia, getMedia, bulkEnhance } from '../../../services/media';
import { useIntersectionObserver } from '../../../hooks/useIntersectionObserver';
import { useMediaPreview } from '../../../contexts/MediaPreviewContext';

const mockListMedia = vi.mocked(listMedia);
const mockGetMedia = vi.mocked(getMedia);
const mockBulkEnhance = vi.mocked(bulkEnhance);
const mockUseIntersectionObserver = vi.mocked(useIntersectionObserver);
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

function makeResult(overrides: Partial<BulkEnhanceResult> = {}): BulkEnhanceResult {
  return {
    batchId: 'batch-1',
    requested: 2,
    queued: 2,
    skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 },
    ...overrides,
  };
}

/** Latest props BulkActionToolbar was rendered with. */
function latestToolbarProps(): CapturedToolbarProps {
  return toolbarCalls[toolbarCalls.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaGallery — multi-photo AI Enhance wiring (epic #420)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolbarCalls.length = 0;
    mockGetMedia.mockImplementation((id: string) => Promise.resolve(makeItem(id)));
    mockBulkEnhance.mockResolvedValue(makeResult());
    mockUseMediaPreview.mockReturnValue({
      addPreview: vi.fn(),
      getPreview: vi.fn(() => undefined),
      removePreview: vi.fn(),
      version: 0,
    });
  });

  // -------------------------------------------------------------------------
  // selectedItems / selectedPhotos derivation across a paginated append
  // -------------------------------------------------------------------------
  describe('selection derivation', () => {
    it('keeps a page-1 selection resolved in selectedItems once page 2 is merged in', async () => {
      const user = userEvent.setup();
      mockListMedia.mockResolvedValueOnce({
        items: [makeItem('p1', { type: 'photo' }), makeItem('v1', { type: 'video' })],
        meta: { pageSize: 50, nextCursor: 'cursor-2', hasMore: true },
      });

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          queryParams={{ circleId: 'circle-1' }}
        />,
      );

      await waitFor(() => {
        expect(screen.getByAltText('file-p1.jpg')).toBeInTheDocument();
      });

      // Select the photo on page 1.
      const checkboxes = screen.getAllByRole('button', { name: /select item/i });
      await user.click(checkboxes[0]);

      await waitFor(() => {
        expect(latestToolbarProps().selectedItems?.map((it) => it.id)).toEqual(['p1']);
      });

      // Load page 2 — simulate the sentinel intersecting by invoking the
      // callback useIntersectionObserver was wired with directly.
      mockListMedia.mockResolvedValueOnce({
        items: [makeItem('p3', { type: 'photo' })],
        meta: { pageSize: 50, nextCursor: null, hasMore: false },
      });
      const feedLoadMore = mockUseIntersectionObserver.mock.calls[
        mockUseIntersectionObserver.mock.calls.length - 1
      ][1];
      await act(async () => {
        feedLoadMore();
      });

      await waitFor(() => {
        expect(screen.getByAltText('file-p3.jpg')).toBeInTheDocument();
      });

      // The page-1 selection survives the merge, resolved against the fresh
      // merged item object (not lost, not stale).
      const propsAfterMerge = latestToolbarProps();
      expect(propsAfterMerge.selected.has('p1')).toBe(true);
      expect(propsAfterMerge.selectedItems?.map((it) => it.id)).toEqual(['p1']);
      expect(propsAfterMerge.selectedItems?.[0].type).toBe('photo');

      // Selecting the newly-loaded page-2 item extends the derivation rather
      // than replacing it.
      const checkboxesAfterMerge = screen.getAllByRole('button', { name: /select item/i });
      await user.click(checkboxesAfterMerge[checkboxesAfterMerge.length - 1]);

      await waitFor(() => {
        expect(latestToolbarProps().selectedItems?.map((it) => it.id).sort()).toEqual([
          'p1',
          'p3',
        ]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Full submit flow through the real BatchEnhanceDialog
  // -------------------------------------------------------------------------
  describe('batch submit flow', () => {
    async function selectAllAndOpenBatchDialog(user: ReturnType<typeof userEvent.setup>) {
      const checkboxes = screen.getAllByRole('button', { name: /select item/i });
      for (const checkbox of checkboxes) {
        await user.click(checkbox);
      }
      await user.click(screen.getByText('harness-open-batch-enhance'));
      await screen.findByRole('dialog');
    }

    it('sends only photo ids to bulkEnhance (videos excluded) for a mixed selection', async () => {
      const user = userEvent.setup();
      mockListMedia.mockResolvedValueOnce({
        items: [
          makeItem('mp1', { type: 'photo' }),
          makeItem('mp2', { type: 'photo' }),
          makeItem('mv1', { type: 'video' }),
        ],
        meta: { pageSize: 50, nextCursor: null, hasMore: false },
      });

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          queryParams={{ circleId: 'circle-1' }}
        />,
      );
      await waitFor(() => {
        expect(screen.getByAltText('file-mp1.jpg')).toBeInTheDocument();
      });

      await selectAllAndOpenBatchDialog(user);

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      await waitFor(() => {
        expect(mockBulkEnhance).toHaveBeenCalledTimes(1);
      });
      expect(mockBulkEnhance).toHaveBeenCalledWith(
        expect.objectContaining({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['mp1', 'mp2']),
        }),
      );
      const [call] = mockBulkEnhance.mock.calls;
      expect(call[0].ids).toHaveLength(2);
      expect(call[0].ids).not.toContain('mv1');
    });

    it('shows the SERVER queued count (not the client selection size) and the skipped summary when queued < requested', async () => {
      const user = userEvent.setup();
      mockListMedia.mockResolvedValueOnce({
        items: [makeItem('sp1', { type: 'photo' }), makeItem('sp2', { type: 'photo' })],
        meta: { pageSize: 50, nextCursor: null, hasMore: false },
      });
      mockBulkEnhance.mockResolvedValueOnce(
        makeResult({
          requested: 2,
          queued: 1,
          skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 1 },
        }),
      );

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          queryParams={{ circleId: 'circle-1' }}
        />,
      );
      await waitFor(() => {
        expect(screen.getByAltText('file-sp1.jpg')).toBeInTheDocument();
      });

      await selectAllAndOpenBatchDialog(user);
      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      // Result step shows the breakdown first (queued < requested).
      await screen.findByText(/AI enhancements queued/i);
      await user.click(screen.getByRole('button', { name: /^done$/i }));

      // The snackbar reflects the server's queued=1, never the client's
      // selection size of 2, and names the 1 skipped item.
      await waitFor(() => {
        expect(
          screen.getByText(/Queued AI enhancement for 1 photo · 1 skipped/i),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText(/Queued AI enhancement for 2 photos/i),
      ).not.toBeInTheDocument();
    });

    it('clears the selection after a successful batch submit', async () => {
      const user = userEvent.setup();
      mockListMedia.mockResolvedValueOnce({
        items: [makeItem('cp1', { type: 'photo' }), makeItem('cp2', { type: 'photo' })],
        meta: { pageSize: 50, nextCursor: null, hasMore: false },
      });
      mockBulkEnhance.mockResolvedValueOnce(makeResult({ requested: 2, queued: 2 }));

      render(
        <MediaGallery
          circleId="circle-1"
          activeCircleRole="circle_admin"
          queryParams={{ circleId: 'circle-1' }}
        />,
      );
      await waitFor(() => {
        expect(screen.getByAltText('file-cp1.jpg')).toBeInTheDocument();
      });

      await selectAllAndOpenBatchDialog(user);
      expect(latestToolbarProps().selected.size).toBe(2);

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      // Nothing skipped -> the dialog closes immediately and the selection
      // is cleared as part of the ordinary metadata-success path.
      await waitFor(() => {
        expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument();
      });
      expect(latestToolbarProps().selected.size).toBe(0);
    });
  });
});

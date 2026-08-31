/**
 * BatchEnhanceDialog — unit tests (epic #420, issues #422 and #424).
 *
 * Covers BOTH modes:
 *
 *  Selection mode (items[]):
 *   - count rendering in the title/submit label
 *   - over-cap disables submit, with copy naming BOTH the selection size and
 *     the configured cap
 *   - submit calls bulkEnhance with the PHOTO ids only (videos excluded)
 *   - a server 400 surfaces the server's own message verbatim
 *   - a double-submit cannot queue (and bill) the same selection twice
 *   - the success summary is built from the SERVER's `result.queued` /
 *     `result.requested`, never the client's optimistic selection count
 *   - the skipped breakdown (alreadyLive / tooLarge / notPhoto) is surfaced
 *
 *  Filter mode (filterMode):
 *   - the "Photos you cannot currently see on screen are included" copy
 *   - an over-cap REFUSAL renders `details.matchedCount` from the server
 *     response as the specific count it is, not a generic error
 *   - submission posts a FILTER (bulkEnhanceByFilter) rather than an id list
 *     (bulkEnhance is never called)
 *
 * `bulkEnhance` / `bulkEnhanceByFilter` are mocked at the service boundary so
 * these tests exercise only the dialog's own state machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BatchEnhanceDialog } from '../../../components/media/BatchEnhanceDialog';
import type { BulkEnhanceResult } from '../../../services/media';
import type { MediaItem } from '../../../types/media';
import { ApiError } from '../../../services/api';

vi.mock('../../../services/media', () => ({
  bulkEnhance: vi.fn(),
  bulkEnhanceByFilter: vi.fn(),
}));

import { bulkEnhance, bulkEnhanceByFilter } from '../../../services/media';

const mockBulkEnhance = vi.mocked(bulkEnhance);
const mockBulkEnhanceByFilter = vi.mocked(bulkEnhanceByFilter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'item-1',
    storageObjectId: 'storage-obj-1',
    addedById: 'user-1',
    circleId: 'circle-1',
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
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    originalFilename: 'IMG_0001.jpg',
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
    metadata: null,
    thumbnailUrl: null,
    downloadUrl: null,
    ...overrides,
  };
}

const photo = (id: string) => makeMediaItem({ id, type: 'photo' });
const video = (id: string) => makeMediaItem({ id, type: 'video' });

function makeResult(overrides: Partial<BulkEnhanceResult> = {}): BulkEnhanceResult {
  return {
    batchId: 'batch-1',
    requested: 3,
    queued: 3,
    skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 },
    ...overrides,
  };
}

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  circleId: 'circle-1',
  onSuccess: vi.fn(),
};

describe('BatchEnhanceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkEnhance.mockResolvedValue(makeResult());
    mockBulkEnhanceByFilter.mockResolvedValue(makeResult());
  });

  // -------------------------------------------------------------------------
  // Selection mode
  // -------------------------------------------------------------------------
  describe('selection mode', () => {
    it('renders the photo count in the title and submit label', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), photo('p2'), photo('p3')]}
        />,
      );

      expect(screen.getByText('Enhance 3 photos with AI')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enhance 3 photos' })).toBeInTheDocument();
    });

    it('uses singular copy for exactly one photo', () => {
      render(<BatchEnhanceDialog {...defaultProps} items={[photo('p1')]} />);
      expect(screen.getByText('Enhance 1 photo with AI')).toBeInTheDocument();
    });

    it('notes skipped videos in the selection without counting them', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), photo('p2'), video('v1')]}
        />,
      );

      expect(screen.getByText('Enhance 2 photos with AI')).toBeInTheDocument();
      expect(
        screen.getByText(/1 video in your selection will be skipped/i),
      ).toBeInTheDocument();
    });

    it('disables submit and names BOTH the selection size and the cap when over maxBatchSize', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), photo('p2'), photo('p3'), photo('p4'), photo('p5')]}
          maxBatchSize={3}
        />,
      );

      expect(
        screen.getByText(/you selected 5 photos; the limit is 3 per batch/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/deselect 2, or ask an admin/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enhance 5 photos' })).toBeDisabled();
    });

    it('enables submit again once the selection drops back to (or under) the cap', () => {
      const { rerender } = render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), photo('p2'), photo('p3'), photo('p4')]}
          maxBatchSize={3}
        />,
      );
      expect(screen.getByRole('button', { name: 'Enhance 4 photos' })).toBeDisabled();

      rerender(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), photo('p2'), photo('p3')]}
          maxBatchSize={3}
        />,
      );
      expect(screen.getByRole('button', { name: 'Enhance 3 photos' })).toBeEnabled();
    });

    it('submits only the PHOTO ids from a mixed selection, never the video ids', async () => {
      const user = userEvent.setup();
      mockBulkEnhance.mockResolvedValue(makeResult({ requested: 2, queued: 2 }));
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), video('v1'), photo('p2'), video('v2')]}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Enhance 2 photos' }));

      await waitFor(() => {
        expect(mockBulkEnhance).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: 'circle-1', ids: ['p1', 'p2'] }),
        );
      });
      expect(mockBulkEnhanceByFilter).not.toHaveBeenCalled();
    });

    it('surfaces the server\'s 400 message verbatim, and re-enables the form', async () => {
      const user = userEvent.setup();
      mockBulkEnhance.mockRejectedValueOnce(
        new Error('The AI Picture Enhancer is not configured'),
      );
      render(<BatchEnhanceDialog {...defaultProps} items={[photo('p1'), photo('p2')]} />);

      await user.click(screen.getByRole('button', { name: 'Enhance 2 photos' }));

      expect(
        await screen.findByText('The AI Picture Enhancer is not configured'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enhance 2 photos' })).toBeEnabled();
      expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    });

    it('a double submit (rapid double-click) queues only once', async () => {
      const user = userEvent.setup();
      let resolveFn: (r: BulkEnhanceResult) => void = () => {};
      mockBulkEnhance.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFn = resolve;
          }),
      );
      render(<BatchEnhanceDialog {...defaultProps} items={[photo('p1'), photo('p2')]} />);

      const button = screen.getByRole('button', { name: 'Enhance 2 photos' });
      await user.click(button);
      // The button disables itself (pointer-events: none) the instant
      // submission starts, which is what makes a second tap physically
      // impossible for a real user — assert that guard directly rather than
      // attempting a click userEvent would correctly refuse to deliver.
      expect(button).toBeDisabled();

      resolveFn(makeResult());
      await waitFor(() => expect(defaultProps.onSuccess).toHaveBeenCalled());
      expect(mockBulkEnhance).toHaveBeenCalledTimes(1);
    });

    it('the outcome summary uses the SERVER\'s queued/requested counts, never the client selection size', async () => {
      const user = userEvent.setup();
      // 5 selected client-side, but the server reports a different requested
      // total and a partial queue — proving the copy is server-derived.
      mockBulkEnhance.mockResolvedValue(
        makeResult({
          requested: 12,
          queued: 3,
          skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 9 },
        }),
      );
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={[photo('p1'), photo('p2'), photo('p3'), photo('p4'), photo('p5')]}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Enhance 5 photos' }));

      expect(await screen.findByText('AI enhancements queued')).toBeInTheDocument();
      // The sentence is split across a <strong> node, so assert on the
      // normalized whole-document text rather than a single text node.
      const normalized = document.body.textContent!.replace(/\s+/g, ' ');
      expect(normalized).toContain('Queued AI enhancement for 3 photos out of the 12 photos sent.');
    });

    it('surfaces the per-reason skipped breakdown (alreadyLive / tooLarge / notPhoto)', async () => {
      const user = userEvent.setup();
      mockBulkEnhance.mockResolvedValue(
        makeResult({
          requested: 6,
          queued: 3,
          skipped: { notPhoto: 1, tooLarge: 1, alreadyLive: 1 },
        }),
      );
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          items={Array.from({ length: 6 }, (_, i) => photo(`p${i}`))}
        />,
      );

      await user.click(screen.getByRole('button', { name: /enhance 6 photos/i }));

      expect(await screen.findByText(/3 photos were skipped/i)).toBeInTheDocument();
      const normalized = document.body.textContent!.replace(/\s+/g, ' ');
      expect(normalized).toMatch(/already (has|have) an enhancement/i);
      expect(normalized).toMatch(/too large for the enhancer/i);
      expect(normalized).toMatch(/not an enhanceable/i);
    });

    it('finishes immediately (no outcome step) when nothing was skipped', async () => {
      const user = userEvent.setup();
      mockBulkEnhance.mockResolvedValue(makeResult({ requested: 2, queued: 2 }));
      render(<BatchEnhanceDialog {...defaultProps} items={[photo('p1'), photo('p2')]} />);

      await user.click(screen.getByRole('button', { name: 'Enhance 2 photos' }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith(
          expect.stringContaining('Queued AI enhancement for 2 photos'),
          'batch-1',
        );
      });
      expect(defaultProps.onClose).toHaveBeenCalled();
      expect(screen.queryByText('AI enhancements queued')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Filter mode (issue #424)
  // -------------------------------------------------------------------------
  describe('filter mode', () => {
    it('renders the "not on screen" disclosure copy that selection mode never shows', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          filterMode={{ filters: { circleId: 'circle-1', favorite: true } }}
        />,
      );

      expect(
        screen.getByText(/photos you cannot currently see on screen are included/i),
      ).toBeInTheDocument();
    });

    it('does not show the "not on screen" copy in plain selection mode', () => {
      render(<BatchEnhanceDialog {...defaultProps} items={[photo('p1')]} />);
      expect(
        screen.queryByText(/photos you cannot currently see on screen/i),
      ).not.toBeInTheDocument();
    });

    it('posts a FILTER via bulkEnhanceByFilter, never an id list via bulkEnhance', async () => {
      const user = userEvent.setup();
      const filters = { circleId: 'circle-1', tag: 'vacation' };
      mockBulkEnhanceByFilter.mockResolvedValue(
        makeResult({ requested: 40, queued: 40 }),
      );
      render(<BatchEnhanceDialog {...defaultProps} filterMode={{ filters }} />);

      await user.click(screen.getByRole('button', { name: /enhance all matching/i }));

      await waitFor(() => {
        expect(mockBulkEnhanceByFilter).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: 'circle-1', tag: 'vacation' }),
        );
      });
      expect(mockBulkEnhance).not.toHaveBeenCalled();
    });

    it('renders the server\'s over-cap refusal — details.matchedCount — as a specific count, not a generic error', async () => {
      const user = userEvent.setup();
      mockBulkEnhanceByFilter.mockRejectedValueOnce(
        new ApiError('Bad Request', 400, 'BAD_REQUEST', {
          matchedCount: 120,
          maxBatchSize: 50,
        }),
      );
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          filterMode={{ filters: { circleId: 'circle-1', favorite: true } }}
          maxBatchSize={50}
        />,
      );

      await user.click(screen.getByRole('button', { name: /enhance all matching/i }));

      // The specific server-reported count, not a bare "Bad Request".
      expect(
        await screen.findByText(/120 photos match your filter; the limit is 50 per batch/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('Bad Request')).not.toBeInTheDocument();
      // The title updates to reflect the now-known real count too.
      expect(
        screen.getByText('Enhance all 120 photos matching your current filter?'),
      ).toBeInTheDocument();
      // And the submit button is now disabled — the refusal is a hard block,
      // not an error banner beside an otherwise-clickable button.
      expect(
        screen.getByRole('button', { name: /enhance 120 photos/i }),
      ).toBeDisabled();
    });

    it('falls back to a generic error message for a non-cap 400 in filter mode', async () => {
      const user = userEvent.setup();
      mockBulkEnhanceByFilter.mockRejectedValueOnce(new Error('Nothing matched your filter'));
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          filterMode={{ filters: { circleId: 'circle-1', favorite: true } }}
        />,
      );

      await user.click(screen.getByRole('button', { name: /enhance all matching/i }));

      expect(await screen.findByText('Nothing matched your filter')).toBeInTheDocument();
    });

    it('shows an honest count-less title/submit when the caller does not know the match count up front (keyset mode)', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          filterMode={{ filters: { circleId: 'circle-1' }, matchCount: null }}
        />,
      );

      expect(screen.getByText('Enhance every photo matching your current filter?')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enhance all matching' })).toBeInTheDocument();
    });

    it('disables submit when the caller already knows the filter matches zero photos', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          filterMode={{ filters: { circleId: 'circle-1', tag: 'nonexistent' }, matchCount: 0 }}
        />,
      );

      expect(screen.getByText(/no photos match your filter/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /enhance/i })).toBeDisabled();
    });
  });
});

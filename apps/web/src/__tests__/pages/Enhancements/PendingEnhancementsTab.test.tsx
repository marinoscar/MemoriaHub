/**
 * PendingEnhancementsTab — unit tests (issue #201, AI Enhancements hub PR1).
 *
 * Covers:
 *  - card rendering per status (pending / processing / ready / failed)
 *  - the downscale badge on a ready+downscaled row
 *  - expiry countdown formatting and the 24h / 6h severity thresholds
 *  - replace policy: hidden when allowReplace=false; and, when
 *    blockReplaceOnDownscale && downscaled, an ALWAYS-RENDERED reason (never a
 *    hover-only tooltip) plus a confirm-through acknowledgement (issue #426)
 *  - the decision actions calling the right service functions
 *  - filters (status + sort) feeding through to the list params
 *  - empty state
 *
 * `useEnhancements` is mocked one level above the service layer so each
 * status can be forced deterministically without timers or network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import {
  PendingEnhancementsTab,
  formatExpiresIn,
  formatElapsedSince,
  describeParams,
} from '../../../pages/Enhancements/PendingEnhancementsTab';
import type { EnhancementListItem } from '../../../services/enhance';

vi.mock('../../../hooks/useEnhancements', () => ({
  useEnhancements: vi.fn(),
}));

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../../services/enhance', () => ({
  applyEnhancement: vi.fn().mockResolvedValue({}),
  discardEnhancement: vi.fn().mockResolvedValue(undefined),
  // The tab renders the "Recent batches" card (issue #423), which fetches on
  // mount. Stubbed empty so it renders nothing and stays out of the way here.
  listEnhancementBatches: vi.fn().mockResolvedValue({
    items: [],
    meta: { page: 1, pageSize: 3, totalItems: 0, totalPages: 0 },
  }),
}));

vi.mock('../../../services/media', () => ({
  getMedia: vi.fn(),
}));

// The drawer has its own suite; stub it so opening it here is observable
// without pulling in its polling hook.
vi.mock('../../../components/media/MediaEnhancementDrawer', () => ({
  MediaEnhancementDrawer: ({ enhancementId }: { enhancementId?: string }) => (
    <div data-testid="enhancement-drawer">{enhancementId}</div>
  ),
}));

import { useEnhancements } from '../../../hooks/useEnhancements';
import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { applyEnhancement, discardEnhancement } from '../../../services/enhance';
import { getMedia } from '../../../services/media';

const mockUseEnhancements = vi.mocked(useEnhancements);
const mockUseFeatureFlags = vi.mocked(useFeatureFlags);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-27T12:00:00.000Z').getTime();

function makeItem(overrides: Partial<EnhancementListItem> = {}): EnhancementListItem {
  return {
    id: 'enh-1',
    mediaItemId: 'item-1',
    status: 'ready',
    decision: null,
    model: 'gpt-image-1',
    params: { preset: 'restore_old_photo', strength: 'strong' },
    original: { thumbnailUrl: 'https://cdn/o.jpg', width: 4000, height: 3000, size: '5000' },
    enhanced: {
      thumbnailUrl: 'https://cdn/e-thumb.jpg',
      previewUrl: 'https://cdn/e-full.jpg',
      width: 1024,
      height: 1024,
      size: '900',
    },
    downscaled: false,
    expiresAt: new Date(NOW + 6 * 86_400_000 + 4 * 3_600_000).toISOString(),
    lastError: null,
    resultMediaItemId: null,
    sourceFilename: 'IMG_0001.jpg',
    capturedAt: '2026-01-01T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Test User' },
    createdAt: '2026-07-27T11:58:00.000Z',
    updatedAt: '2026-07-27T11:59:00.000Z',
    ...overrides,
  };
}

function mockList(items: EnhancementListItem[], overrides: Record<string, unknown> = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  mockUseEnhancements.mockReturnValue({
    items,
    meta: { page: 1, pageSize: 24, totalItems: items.length, totalPages: 1 },
    isLoading: false,
    error: null,
    polling: false,
    refresh,
    ...overrides,
  });
  return refresh;
}

function mockPolicy(allowReplace = true, blockReplaceOnDownscale = false) {
  mockUseFeatureFlags.mockReturnValue({
    features: { pictureEnhancement: true },
    pictureEnhancement: {
      enabled: true,
      allowReplace,
      blockReplaceOnDownscale,
      model: 'gpt-image-1',
    },
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

function cardFor(id: string): HTMLElement {
  return screen.getByTestId(`enhancement-card-${id}`);
}

// ---------------------------------------------------------------------------

describe('formatExpiresIn', () => {
  it('returns null without an expiresAt (in-flight rows never expire)', () => {
    expect(formatExpiresIn(null, NOW)).toBeNull();
  });

  it('formats multi-day remaining time as "Expires in Nd Nh" at info severity', () => {
    const at = new Date(NOW + 6 * 86_400_000 + 4 * 3_600_000).toISOString();
    expect(formatExpiresIn(at, NOW)).toEqual({
      label: 'Expires in 6d 4h',
      severity: 'info',
    });
  });

  it('stays info at exactly 24h remaining', () => {
    const at = new Date(NOW + 24 * 3_600_000).toISOString();
    expect(formatExpiresIn(at, NOW)).toEqual({
      label: 'Expires in 1d 0h',
      severity: 'info',
    });
  });

  it('warns just under 24h', () => {
    const at = new Date(NOW + 24 * 3_600_000 - 60_000).toISOString();
    const result = formatExpiresIn(at, NOW)!;
    expect(result.severity).toBe('warning');
    expect(result.label).toBe('Expires in 23h 59m');
  });

  it('stays warning at exactly 6h remaining', () => {
    const at = new Date(NOW + 6 * 3_600_000).toISOString();
    expect(formatExpiresIn(at, NOW)).toEqual({
      label: 'Expires in 6h 0m',
      severity: 'warning',
    });
  });

  it('escalates to error just under 6h', () => {
    const at = new Date(NOW + 6 * 3_600_000 - 60_000).toISOString();
    const result = formatExpiresIn(at, NOW)!;
    expect(result.severity).toBe('error');
    expect(result.label).toBe('Expires in 5h 59m');
  });

  it('formats sub-hour remaining time in minutes, never below 1m', () => {
    expect(formatExpiresIn(new Date(NOW + 12 * 60_000).toISOString(), NOW)).toEqual({
      label: 'Expires in 12m',
      severity: 'error',
    });
    expect(formatExpiresIn(new Date(NOW + 5_000).toISOString(), NOW)!.label).toBe(
      'Expires in 1m',
    );
  });

  it('reports an already-past deadline as Expired', () => {
    const at = new Date(NOW - 1000).toISOString();
    expect(formatExpiresIn(at, NOW)).toEqual({ label: 'Expired', severity: 'error' });
  });

  it('returns null for an unparseable timestamp', () => {
    expect(formatExpiresIn('not-a-date', NOW)).toBeNull();
  });
});

describe('formatElapsedSince / describeParams', () => {
  it('formats elapsed time as "Nm SSs"', () => {
    expect(formatElapsedSince(new Date(NOW - 200_000).toISOString(), NOW)).toBe('3m 20s');
  });

  it('summarises a preset run', () => {
    expect(describeParams(makeItem())).toBe('restore old photo · strong');
  });

  it('summarises an auto run and a custom run', () => {
    expect(describeParams(makeItem({ params: {} }))).toBe('auto');
    expect(describeParams(makeItem({ params: { intent: 'custom', quality: 'high' } }))).toBe(
      'custom · high quality',
    );
  });
});

// ---------------------------------------------------------------------------

describe('PendingEnhancementsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    mockPolicy();
    vi.mocked(getMedia).mockResolvedValue({ id: 'item-1' } as never);
  });

  describe('card rendering per status', () => {
    it('renders a queued card with a spinner and elapsed time', () => {
      mockList([makeItem({ status: 'pending', expiresAt: null })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const card = cardFor('enh-1');
      expect(within(card).getByText('Queued')).toBeInTheDocument();
      expect(within(card).getByText(/Waiting for a free worker/)).toBeInTheDocument();
      expect(within(card).getByText(/2m 00s/)).toBeInTheDocument();
      expect(card.querySelector('.MuiCircularProgress-root')).not.toBeNull();
      // Nothing to decide yet.
      expect(within(card).queryByRole('button', { name: 'Review' })).toBeNull();
    });

    it('renders a processing card', () => {
      mockList([makeItem({ status: 'processing', expiresAt: null })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const card = cardFor('enh-1');
      expect(within(card).getByText('Enhancing…')).toBeInTheDocument();
      expect(within(card).getByText(/Enhancing your photo/)).toBeInTheDocument();
      expect(card.querySelector('.MuiCircularProgress-root')).not.toBeNull();
    });

    it('renders a ready card with both thumbnails, dimensions and the decision actions', () => {
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const card = cardFor('enh-1');
      expect(within(card).getByText('Ready to review')).toBeInTheDocument();
      expect(within(card).getByAltText('Original of IMG_0001.jpg')).toBeInTheDocument();
      expect(within(card).getByAltText('Enhanced IMG_0001.jpg')).toBeInTheDocument();
      expect(within(card).getByText('4000×3000 → 1024×1024')).toBeInTheDocument();
      expect(within(card).getByText(/gpt-image-1/)).toBeInTheDocument();
      expect(within(card).getByText('Expires in 6d 4h')).toBeInTheDocument();

      expect(within(card).getByRole('button', { name: 'Review' })).toBeEnabled();
      expect(within(card).getByRole('button', { name: 'Keep both' })).toBeEnabled();
      expect(within(card).getByRole('button', { name: 'Replace original' })).toBeEnabled();
      expect(within(card).getByRole('button', { name: 'Discard' })).toBeEnabled();
    });

    it('renders the enhanced side from the thumbnail derivative, not the full-resolution staged bytes (issue #203)', () => {
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const img = within(cardFor('enh-1')).getByAltText('Enhanced IMG_0001.jpg');
      expect(img).toHaveAttribute('src', 'https://cdn/e-thumb.jpg');
    });

    it('falls back to the full-resolution previewUrl when a row has no thumbnail derivative', () => {
      // Pre-#203 rows, and rows whose best-effort thumbnail render failed, have
      // a null thumbnailUrl — the card must still show something.
      mockList([
        makeItem({
          enhanced: {
            thumbnailUrl: null,
            previewUrl: 'https://cdn/e-full.jpg',
            width: 1024,
            height: 1024,
            size: '900',
          },
        }),
      ]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const img = within(cardFor('enh-1')).getByAltText('Enhanced IMG_0001.jpg');
      expect(img).toHaveAttribute('src', 'https://cdn/e-full.jpg');
    });

    it('renders a failed card with the error and only a Discard action', () => {
      mockList([
        makeItem({
          status: 'failed',
          lastError: 'The model returned a 400',
          enhanced: {
            thumbnailUrl: null,
            previewUrl: null,
            width: null,
            height: null,
            size: null,
          },
        }),
      ]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const card = cardFor('enh-1');
      expect(within(card).getByText('Failed')).toBeInTheDocument();
      expect(within(card).getByText('The model returned a 400')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
      // Retry is explicitly out of scope for PR1 (it is a new paid API call).
      expect(within(card).queryByRole('button', { name: /Retry/ })).toBeNull();
      expect(within(card).queryByRole('button', { name: 'Keep both' })).toBeNull();
    });

    it('shows the downscale badge only when the result is downscaled', () => {
      mockList([makeItem({ downscaled: true })]);
      const { unmount } = render(<PendingEnhancementsTab circleId="circle-1" />);
      expect(within(cardFor('enh-1')).getByText('Lower resolution')).toBeInTheDocument();
      unmount();

      mockList([makeItem({ downscaled: false })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);
      expect(within(cardFor('enh-1')).queryByText('Lower resolution')).toBeNull();
    });

    it('colours the expiry countdown by urgency', () => {
      mockList([
        makeItem({
          id: 'enh-soon',
          expiresAt: new Date(NOW + 3 * 3_600_000).toISOString(),
        }),
      ]);
      render(<PendingEnhancementsTab circleId="circle-1" />);
      expect(within(cardFor('enh-soon')).getByText('Expires in 3h 0m')).toBeInTheDocument();
    });
  });

  describe('replace policy', () => {
    it('hides Replace entirely when the administrator disabled it', () => {
      mockPolicy(false, false);
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const card = cardFor('enh-1');
      expect(within(card).queryByRole('button', { name: 'Replace original' })).toBeNull();
      // The non-destructive path is still offered.
      expect(within(card).getByRole('button', { name: 'Keep both' })).toBeEnabled();
    });

    /**
     * Issue #426. Replace used to be disabled here with the reason living only
     * in a hover tooltip on the disabled button — invisible on touch, and
     * permanent in practice since gpt-image-1 caps output at ~1.6 MP. The
     * reason must now be plain DOM text, and the guard must be passable.
     * These assertions deliberately perform NO hover or pointer interaction.
     */
    it('states the reason on the card without any hover when blockReplaceOnDownscale applies', () => {
      mockPolicy(true, true);
      mockList([makeItem({ downscaled: true })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      const card = cardFor('enh-1');
      expect(
        within(card).getByText(/an administrator has set replacing to be blocked/i),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(/4000×3000 \(12\.0 MP\) → 1024×1024 \(1\.0 MP\)/),
      ).toBeInTheDocument();
    });

    it('keeps Replace usable under blockReplaceOnDownscale so the block can be passed knowingly', () => {
      mockPolicy(true, true);
      mockList([makeItem({ downscaled: true })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(
        within(cardFor('enh-1')).getByRole('button', { name: 'Replace original' }),
      ).toBeEnabled();
    });

    it('links an admin to the responsible setting, and does not for a non-admin', () => {
      mockPolicy(true, true);
      mockList([makeItem({ downscaled: true })]);

      const { unmount } = render(<PendingEnhancementsTab circleId="circle-1" />, {
        wrapperOptions: { user: mockAdminUser },
      });
      expect(
        within(cardFor('enh-1')).getByRole('link', { name: /change this setting/i }),
      ).toHaveAttribute('href', '/admin/settings/enhancer');
      unmount();

      render(<PendingEnhancementsTab circleId="circle-1" />);
      const card = cardFor('enh-1');
      expect(within(card).queryByRole('link', { name: /change this setting/i })).toBeNull();
      // The explanation itself is still shown to everyone.
      expect(
        within(card).getByText(/an administrator has set replacing to be blocked/i),
      ).toBeInTheDocument();
    });

    it('leaves Replace enabled when the policy is on but the result is not downscaled', () => {
      mockPolicy(true, true);
      mockList([makeItem({ downscaled: false })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(
        within(cardFor('enh-1')).getByRole('button', { name: 'Replace original' }),
      ).toBeEnabled();
    });
  });

  describe('decision actions', () => {
    it('Keep both applies the keep_both decision and refreshes', async () => {
      const user = userEvent.setup();
      const refresh = mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(within(cardFor('enh-1')).getByRole('button', { name: 'Keep both' }));

      await waitFor(() => {
        expect(applyEnhancement).toHaveBeenCalledWith('item-1', 'enh-1', 'keep_both');
      });
      expect(refresh).toHaveBeenCalled();
    });

    it('Replace original applies the replace decision', async () => {
      const user = userEvent.setup();
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(
        within(cardFor('enh-1')).getByRole('button', { name: 'Replace original' }),
      );

      await waitFor(() => {
        // No acknowledgement on an ordinary replace (#426).
        expect(applyEnhancement).toHaveBeenCalledWith('item-1', 'enh-1', 'replace', {
          acknowledgeDownscale: false,
        });
      });
    });

    it('confirms before replacing under the downscale guard, then acknowledges it', async () => {
      const user = userEvent.setup();
      mockPolicy(true, true);
      mockList([makeItem({ downscaled: true })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(
        within(cardFor('enh-1')).getByRole('button', { name: 'Replace original' }),
      );
      // Informed consent: nothing is committed on the first tap.
      expect(applyEnhancement).not.toHaveBeenCalled();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/you will lose resolution/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/4000×3000 \(12\.0 MP\) → 1024×1024 \(1\.0 MP\)/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /replace anyway/i }));

      await waitFor(() => {
        expect(applyEnhancement).toHaveBeenCalledWith('item-1', 'enh-1', 'replace', {
          acknowledgeDownscale: true,
        });
      });
    });

    it('cancelling the downscale confirmation commits nothing', async () => {
      const user = userEvent.setup();
      mockPolicy(true, true);
      mockList([makeItem({ downscaled: true })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(
        within(cardFor('enh-1')).getByRole('button', { name: 'Replace original' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(applyEnhancement).not.toHaveBeenCalled();
    });

    it('Discard discards the staged preview', async () => {
      const user = userEvent.setup();
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(within(cardFor('enh-1')).getByRole('button', { name: 'Discard' }));

      await waitFor(() => {
        expect(discardEnhancement).toHaveBeenCalledWith('item-1', 'enh-1');
      });
    });

    it('Review loads the media item and opens the drawer on that enhancement', async () => {
      const user = userEvent.setup();
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(within(cardFor('enh-1')).getByRole('button', { name: 'Review' }));

      await waitFor(() => {
        expect(getMedia).toHaveBeenCalledWith('item-1');
      });
      const drawer = await screen.findByTestId('enhancement-drawer');
      expect(drawer).toHaveTextContent('enh-1');
    });

    it('surfaces an action failure without losing the card', async () => {
      const user = userEvent.setup();
      vi.mocked(applyEnhancement).mockRejectedValueOnce(new Error('Replace is disabled'));
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(
        within(cardFor('enh-1')).getByRole('button', { name: 'Replace original' }),
      );

      expect(await screen.findByText('Replace is disabled')).toBeInTheDocument();
      expect(cardFor('enh-1')).toBeInTheDocument();
    });
  });

  describe('filters and empty state', () => {
    it('requests the circle with no status filter by default', () => {
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(mockUseEnhancements).toHaveBeenCalledWith({
        circleId: 'circle-1',
        page: 1,
        pageSize: 24,
        sortOrder: 'desc',
      });
    });

    it('passes the selected status alias through to the hook', async () => {
      const user = userEvent.setup();
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(screen.getByLabelText('Status'));
      await user.click(await screen.findByRole('option', { name: 'Awaiting decision' }));

      await waitFor(() => {
        expect(mockUseEnhancements).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: 'awaiting_decision' }),
        );
      });
    });

    it('passes the selected sort order through to the hook', async () => {
      const user = userEvent.setup();
      mockList([makeItem()]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      await user.click(screen.getByLabelText('Sort'));
      await user.click(await screen.findByRole('option', { name: 'Oldest first' }));

      await waitFor(() => {
        expect(mockUseEnhancements).toHaveBeenLastCalledWith(
          expect.objectContaining({ sortOrder: 'asc' }),
        );
      });
    });

    it('renders an explanatory empty state', () => {
      mockList([]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(screen.getByText('Nothing waiting for you')).toBeInTheDocument();
      expect(screen.getByText(/exposure, color, clarity and noise/)).toBeInTheDocument();
    });

    it('renders a list error', () => {
      mockList([], { error: 'Failed to load enhancements' });
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(screen.getByText('Failed to load enhancements')).toBeInTheDocument();
    });

    it('does not offer multi-select or bulk actions (PR2 scope)', () => {
      mockList([makeItem(), makeItem({ id: 'enh-2' })]);
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /Select all/i })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Batch filter (epic #420, issue #423) — arriving from a batch's progress
  // page narrows the inbox to that one batch's results.
  // ---------------------------------------------------------------------------
  describe('batch filter (issue #423)', () => {
    it('with no batchId (the normal case), behaves exactly as today: no chip, unfiltered request, RecentBatchesCard shown', () => {
      mockList([makeItem()], {
        meta: { page: 1, pageSize: 24, totalItems: 1, totalPages: 1 },
      });
      render(<PendingEnhancementsTab circleId="circle-1" />);

      expect(screen.queryByText(/from one batch/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
      expect(mockUseEnhancements).toHaveBeenCalledWith(
        expect.not.objectContaining({ batchId: expect.anything() }),
      );
    });

    it('narrows the request to the batch and renders a chip naming the result count', () => {
      mockList([makeItem()], {
        meta: { page: 1, pageSize: 24, totalItems: 7, totalPages: 1 },
      });
      render(<PendingEnhancementsTab circleId="circle-1" batchId="batch-1" />);

      expect(mockUseEnhancements).toHaveBeenCalledWith(
        expect.objectContaining({ circleId: 'circle-1', batchId: 'batch-1' }),
      );
      expect(screen.getByText('Showing 7 results from one batch')).toBeInTheDocument();
    });

    it('uses singular copy for exactly one result', () => {
      mockList([makeItem()], {
        meta: { page: 1, pageSize: 24, totalItems: 1, totalPages: 1 },
      });
      render(<PendingEnhancementsTab circleId="circle-1" batchId="batch-1" />);

      expect(screen.getByText('Showing 1 result from one batch')).toBeInTheDocument();
    });

    it('hides the RecentBatchesCard while a batch filter is active (it would only add noise)', () => {
      mockList([makeItem()]);
      const { unmount } = render(
        <PendingEnhancementsTab circleId="circle-1" batchId="batch-1" />,
      );
      // "Recent batches" is RecentBatchesCard's own heading; absent under a filter.
      expect(screen.queryByText(/recent batches/i)).not.toBeInTheDocument();
      unmount();

      render(<PendingEnhancementsTab circleId="circle-1" />);
      // (RecentBatchesCard renders nothing itself when its own list is empty —
      // the meaningful assertion is that the chip driving `!batchId` is gone.)
      expect(screen.queryByText(/from one batch/i)).not.toBeInTheDocument();
    });

    it('calls onClearBatchFilter from both the chip delete affordance and the "Show all" button', async () => {
      const user = userEvent.setup();
      const onClearBatchFilter = vi.fn();
      mockList([makeItem()], {
        meta: { page: 1, pageSize: 24, totalItems: 3, totalPages: 1 },
      });
      render(
        <PendingEnhancementsTab
          circleId="circle-1"
          batchId="batch-1"
          onClearBatchFilter={onClearBatchFilter}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Show all' }));
      expect(onClearBatchFilter).toHaveBeenCalledTimes(1);

      // MUI Chip's onDelete renders a delete icon inside the chip itself.
      const chip = screen.getByText('Showing 3 results from one batch').closest(
        '.MuiChip-root',
      ) as HTMLElement;
      await user.click(within(chip).getByTestId('CancelIcon'));
      expect(onClearBatchFilter).toHaveBeenCalledTimes(2);
    });

    it('clearing the filter (batchId becomes undefined) restores the unfiltered request', () => {
      mockList([makeItem()], {
        meta: { page: 1, pageSize: 24, totalItems: 3, totalPages: 1 },
      });
      const { rerender } = render(
        <PendingEnhancementsTab circleId="circle-1" batchId="batch-1" />,
      );
      expect(mockUseEnhancements).toHaveBeenLastCalledWith(
        expect.objectContaining({ batchId: 'batch-1' }),
      );

      rerender(<PendingEnhancementsTab circleId="circle-1" />);

      expect(mockUseEnhancements).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ batchId: expect.anything() }),
      );
      expect(screen.queryByText(/from one batch/i)).not.toBeInTheDocument();
    });

    it('shows batch-specific empty-state copy under a batch filter, distinct from the general empty state', () => {
      mockList([]);
      const { unmount } = render(
        <PendingEnhancementsTab circleId="circle-1" batchId="batch-1" />,
      );
      expect(
        screen.getByText(/this batch has no results here yet/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/exposure, color, clarity and noise/)).not.toBeInTheDocument();
      unmount();

      mockList([]);
      render(<PendingEnhancementsTab circleId="circle-1" />);
      expect(screen.getByText(/exposure, color, clarity and noise/)).toBeInTheDocument();
      expect(screen.queryByText(/this batch has no results here yet/i)).not.toBeInTheDocument();
    });

    it('resets to page 1 when the batchId changes', async () => {
      mockList([makeItem()], {
        meta: { page: 2, pageSize: 24, totalItems: 50, totalPages: 3 },
      });
      const { rerender } = render(
        <PendingEnhancementsTab circleId="circle-1" batchId="batch-1" />,
      );
      mockUseEnhancements.mockClear();

      rerender(<PendingEnhancementsTab circleId="circle-1" batchId="batch-2" />);

      await waitFor(() => {
        expect(mockUseEnhancements).toHaveBeenLastCalledWith(
          expect.objectContaining({ batchId: 'batch-2', page: 1 }),
        );
      });
    });
  });
});

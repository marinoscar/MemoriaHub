/**
 * BatchEnhanceDialog — unit tests (issue #422, epic #420 phase 2).
 *
 * Multi-photo AI enhance: params step (preset picker + optional Customize) ->
 * submit -> either an immediate close (nothing skipped) or a result step
 * showing the per-reason skip breakdown before the user dismisses it.
 *
 * Mocks the media service so we don't need a real API. The preset ->
 * EnhanceParams mapping is asserted by IMPORTING `buildEnhanceParams` /
 * `resolvePreset` from the shared `enhancePresets` module (also consumed by
 * MediaEnhancementDrawer) rather than hard-coding an expected literal, so the
 * two enhance surfaces can never silently drift apart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { render } from '../../utils/test-utils';
import { BatchEnhanceDialog } from '../../../components/media/BatchEnhanceDialog';
import type { BatchEnhanceSelectionTarget } from '../../../components/media/BatchEnhanceDialog';
import {
  buildEnhanceParams,
  resolvePreset,
  DEFAULT_ADJUSTMENTS,
} from '../../../components/media/enhancePresets';
import type { EnhanceFormState } from '../../../components/media/enhancePresets';
import type { BulkEnhanceResult } from '../../../services/media';

// ---------------------------------------------------------------------------
// Mock media service
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  bulkEnhance: vi.fn(),
}));

import { bulkEnhance } from '../../../services/media';

const mockBulkEnhance = vi.mocked(bulkEnhance);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<BatchEnhanceSelectionTarget> = {}): BatchEnhanceSelectionTarget {
  return {
    kind: 'selection',
    circleId: 'circle-1',
    photoIds: ['p1', 'p2'],
    nonPhotoCount: 0,
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

/** The default, nothing-touched form state for a given preset selection. */
function defaultFormStateFor(presetKey: EnhanceFormState['presetKey']): EnhanceFormState {
  const preset = resolvePreset(presetKey);
  return {
    presetKey,
    adjustments: preset.prefill.adjustments,
    strength: preset.prefill.strength,
    preserveFaces: preset.prefill.preserveFaces,
    instructions: '',
    quality: '',
  };
}

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  target: makeTarget(),
  maxBatchSize: 25,
  onSuccess: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BatchEnhanceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkEnhance.mockResolvedValue(makeResult());
  });

  // -------------------------------------------------------------------------
  // Count rendering
  // -------------------------------------------------------------------------
  describe('count rendering', () => {
    it('shows the photo count in the headline and the confirm button', () => {
      const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
      render(
        <BatchEnhanceDialog {...defaultProps} target={makeTarget({ photoIds: ids })} />,
      );

      expect(screen.getByText(/Enhance 12 photos with AI/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^Enhance 12 photos$/i }),
      ).toBeInTheDocument();
    });

    it('uses singular phrasing for exactly one photo', () => {
      render(
        <BatchEnhanceDialog {...defaultProps} target={makeTarget({ photoIds: ['p1'] })} />,
      );

      expect(screen.getByText(/Enhance 1 photo with AI/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Enhance 1 photo$/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Non-photo (video) notice
  // -------------------------------------------------------------------------
  describe('non-photo items in the selection', () => {
    it('shows a "N videos will be skipped" notice when nonPhotoCount > 0', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          target={makeTarget({ photoIds: ['p1', 'p2'], nonPhotoCount: 2 })}
        />,
      );

      expect(
        screen.getByText(/2 videos in your selection will be skipped/i),
      ).toBeInTheDocument();
    });

    it('uses singular phrasing for exactly one non-photo item', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          target={makeTarget({ photoIds: ['p1'], nonPhotoCount: 1 })}
        />,
      );

      expect(
        screen.getByText(/1 video in your selection will be skipped/i),
      ).toBeInTheDocument();
    });

    it('shows no video notice when nonPhotoCount is 0', () => {
      render(
        <BatchEnhanceDialog {...defaultProps} target={makeTarget({ nonPhotoCount: 0 })} />,
      );

      expect(screen.queryByText(/will be skipped/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Preset -> params equivalence with the single-item drawer (shared module)
  // -------------------------------------------------------------------------
  describe('preset params equivalence (shared enhancePresets module)', () => {
    it('sends the same params as the drawer would for an untouched real preset', async () => {
      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /^restore old photo —/i }));
      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      const expected = buildEnhanceParams(defaultFormStateFor('restore_old_photo'));

      await waitFor(() => {
        expect(mockBulkEnhance).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: ['p1', 'p2'],
          params: expected,
        });
      });
      // Sanity: a real preset must carry `preset`, never `intent` when untouched.
      expect(expected.preset).toBe('restore_old_photo');
      expect(expected.intent).toBeUndefined();
    });

    it('sends {} (full server defaults) for "Auto" with nothing customized', async () => {
      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} />);

      // "Auto" is selected by default — submit without touching anything.
      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      const expected = buildEnhanceParams(defaultFormStateFor('auto'));
      expect(expected).toEqual({});

      await waitFor(() => {
        expect(mockBulkEnhance).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: ['p1', 'p2'],
          params: expected,
        });
      });
    });

    it('sends intent: "custom" and the changed adjustments once the user actually customizes', async () => {
      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} />);

      // Open the Customize panel and flip "Reduce noise" off (default: true).
      await user.click(screen.getByRole('button', { name: /customize/i }));
      await user.click(screen.getByText(/reduce noise/i));
      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      const customizedFormState: EnhanceFormState = {
        ...defaultFormStateFor('auto'),
        adjustments: { ...DEFAULT_ADJUSTMENTS, denoise: false },
      };
      const expected = buildEnhanceParams(customizedFormState);

      // The isCustomized rule: a real deviation from the preset's prefill
      // must send intent: 'custom' — this is the assertion the shared-module
      // equivalence check protects against drifting silently.
      expect(expected.intent).toBe('custom');

      await waitFor(() => {
        expect(mockBulkEnhance).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: ['p1', 'p2'],
          params: expected,
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Over the batch cap
  // -------------------------------------------------------------------------
  describe('over maxBatchSize', () => {
    it('disables submit and names both the selection size and the cap', () => {
      const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          target={makeTarget({ photoIds: ids })}
          maxBatchSize={25}
        />,
      );

      expect(
        screen.getByText(
          /You selected 30 photos; the limit is 25 per batch\. Deselect 5/i,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Enhance 30 photos$/i })).toBeDisabled();
    });

    it('does not disable submit when the selection is within the cap', () => {
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          target={makeTarget({ photoIds: ['p1', 'p2'] })}
          maxBatchSize={25}
        />,
      );

      expect(screen.getByRole('button', { name: /^Enhance 2 photos$/i })).not.toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Submit payload
  // -------------------------------------------------------------------------
  describe('submit payload', () => {
    it('calls bulkEnhance with the target photo ids only, the circleId, and the built params', async () => {
      const user = userEvent.setup();
      render(
        <BatchEnhanceDialog
          {...defaultProps}
          target={makeTarget({ circleId: 'circle-42', photoIds: ['pa', 'pb', 'pc'] })}
        />,
      );

      await user.click(screen.getByRole('button', { name: /^Enhance 3 photos$/i }));

      await waitFor(() => {
        expect(mockBulkEnhance).toHaveBeenCalledTimes(1);
      });
      expect(mockBulkEnhance).toHaveBeenCalledWith({
        circleId: 'circle-42',
        ids: ['pa', 'pb', 'pc'],
        params: {},
      });
    });
  });

  // -------------------------------------------------------------------------
  // Double-submit guard
  // -------------------------------------------------------------------------
  describe('double-submit guard', () => {
    it('disables the submit button while a request is in flight, so a fast double click cannot fire twice', async () => {
      let resolveBulkEnhance: (result: BulkEnhanceResult) => void = () => {};
      mockBulkEnhance.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveBulkEnhance = resolve;
          }),
      );

      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} />);

      const submitBtn = screen.getByRole('button', { name: /^Enhance 2 photos$/i });
      await user.click(submitBtn);

      // Now disabled — a real `<button disabled>` does not dispatch click at
      // all, so even a raw fireEvent (bypassing userEvent's own pointer-events
      // guard) cannot re-trigger the handler.
      expect(submitBtn).toBeDisabled();
      fireEvent.click(submitBtn);

      expect(mockBulkEnhance).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveBulkEnhance(makeResult());
      });
    });
  });

  // -------------------------------------------------------------------------
  // Server error
  // -------------------------------------------------------------------------
  describe('server error', () => {
    it('renders the server message inline in an error Alert and keeps the dialog open', async () => {
      mockBulkEnhance.mockRejectedValueOnce(
        new Error('Picture enhancement is disabled'),
      );
      const onClose = vi.fn();
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(
        <BatchEnhanceDialog {...defaultProps} onClose={onClose} onSuccess={onSuccess} />,
      );

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      const message = await screen.findByText('Picture enhancement is disabled');
      const alertRoot = message.closest('.MuiAlert-root');
      expect(alertRoot).not.toBeNull();
      expect(alertRoot).toHaveClass('MuiAlert-colorError');

      // Still on the params step, not closed.
      expect(screen.getByRole('button', { name: /^Enhance 2 photos$/i })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('falls back to a generic message for a non-Error rejection', async () => {
      mockBulkEnhance.mockRejectedValueOnce('boom');
      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      expect(
        await screen.findByText('Failed to queue AI enhancements'),
      ).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Result step — skipped breakdown vs. immediate close
  // -------------------------------------------------------------------------
  describe('result step', () => {
    it('keeps the dialog open with the per-reason skip breakdown when something was skipped', async () => {
      const onSuccess = vi.fn();
      const onClose = vi.fn();
      mockBulkEnhance.mockResolvedValueOnce(
        makeResult({
          requested: 3,
          queued: 1,
          skipped: { notPhoto: 0, tooLarge: 1, alreadyLive: 1 },
        }),
      );
      const user = userEvent.setup();
      render(
        <BatchEnhanceDialog {...defaultProps} onSuccess={onSuccess} onClose={onClose} />,
      );

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      await screen.findByText(/AI enhancements queued/i);
      // Neither callback fires until the user acknowledges the breakdown.
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      expect(screen.getByText(/2 photos were skipped/i)).toBeInTheDocument();
      expect(screen.getByText(/too large to enhance/i)).toBeInTheDocument();
      expect(
        screen.getByText(/already has an enhancement waiting for review/i),
      ).toBeInTheDocument();
      // notPhoto is 0 — its reason line must not render.
      expect(screen.queryByText(/not a photo/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^done$/i }));

      expect(onSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Queued AI enhancement for 1 photo · 2 skipped/i),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes immediately with the toast message when nothing was skipped', async () => {
      const onSuccess = vi.fn();
      const onClose = vi.fn();
      mockBulkEnhance.mockResolvedValueOnce(makeResult({ requested: 2, queued: 2 }));
      const user = userEvent.setup();
      render(
        <BatchEnhanceDialog {...defaultProps} onSuccess={onSuccess} onClose={onClose} />,
      );

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith('Queued AI enhancement for 2 photos');
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      // No result step ever rendered.
      expect(screen.queryByText(/AI enhancements queued/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // queued === 0
  // -------------------------------------------------------------------------
  describe('queued === 0', () => {
    it('renders "No photos were queued" rather than "Queued AI enhancement for 0 photos" when nothing was skipped either', async () => {
      const onSuccess = vi.fn();
      mockBulkEnhance.mockResolvedValueOnce(
        makeResult({ requested: 0, queued: 0, skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 } }),
      );
      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} onSuccess={onSuccess} />);

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith('No photos were queued');
      });
      expect(onSuccess).not.toHaveBeenCalledWith(
        expect.stringMatching(/Queued AI enhancement for 0/i),
      );
    });

    it('renders "No photos queued — N skipped" (not the 0-photos phrasing) when everything was skipped', async () => {
      mockBulkEnhance.mockResolvedValueOnce(
        makeResult({
          requested: 2,
          queued: 0,
          skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 2 },
        }),
      );
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<BatchEnhanceDialog {...defaultProps} onSuccess={onSuccess} />);

      await user.click(screen.getByRole('button', { name: /^Enhance 2 photos$/i }));

      const heading = await screen.findByText(/nothing was queued/i);
      expect(heading).toBeInTheDocument();
      expect(screen.getByText(/2 photos were skipped/i)).toBeInTheDocument();
      expect(
        screen.queryByText(/queued ai enhancement for 0 photos/i),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^done$/i }));
      expect(onSuccess).toHaveBeenCalledWith('No photos queued — 2 photos were skipped');
      expect(onSuccess).not.toHaveBeenCalledWith(
        expect.stringMatching(/Queued AI enhancement for 0/i),
      );
    });
  });
});

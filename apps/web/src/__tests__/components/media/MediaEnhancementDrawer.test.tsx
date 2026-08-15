/**
 * MediaEnhancementDrawer — unit tests (issue #98 — AI Picture Enhancer).
 *
 * The drawer walks: params -> progress (polling) -> compare -> decision
 * (Keep both / Replace original / Discard), each decision gated behind a
 * confirm Dialog. All state is driven by `useMediaEnhance`, which is mocked
 * here so we can force each step deterministically without a real network
 * call or timer-based polling.
 *
 * Step selection mirrors the component's own logic:
 *   showCompare  = status === 'ready'
 *   showProgress = polling (status === 'pending' | 'processing')
 *   showParams   = otherwise (idle / failed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaEnhancementDrawer } from '../../../components/media/MediaEnhancementDrawer';
import type { MediaItem } from '../../../types/media';
import type { EnhancementDto } from '../../../services/enhance';

// ---------------------------------------------------------------------------
// Mock the polling hook
// ---------------------------------------------------------------------------
vi.mock('../../../hooks/useMediaEnhance', () => ({
  useMediaEnhance: vi.fn(),
}));

import { useMediaEnhance } from '../../../hooks/useMediaEnhance';

const mockUseMediaEnhance = vi.mocked(useMediaEnhance);

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
    thumbnailUrl: 'https://cdn.example.com/item-1-thumb.jpg',
    downloadUrl: null,
    ...overrides,
  };
}

function makeEnhancementDto(overrides: Partial<EnhancementDto> = {}): EnhancementDto {
  return {
    id: 'enh-1',
    status: 'ready',
    model: 'test-model',
    original: {
      url: 'https://cdn.example.com/original.jpg',
      width: 4032,
      height: 3024,
      size: '2500000',
    },
    enhanced: {
      url: 'https://cdn.example.com/enhanced.jpg',
      width: 4032,
      height: 3024,
      size: '1800000',
    },
    downscaled: false,
    params: null,
    lastError: null,
    ...overrides,
  };
}

type HookReturn = ReturnType<typeof useMediaEnhance>;

function makeHook(overrides: Partial<HookReturn> = {}): HookReturn {
  return {
    status: 'idle',
    data: null,
    error: null,
    polling: false,
    start: vi.fn().mockResolvedValue(undefined),
    resumeLatest: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn().mockResolvedValue({ status: 'ready' }),
    discard: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    ...overrides,
  } as HookReturn;
}

const baseProps = {
  item: makeMediaItem(),
  open: true,
  onClose: vi.fn(),
  onReplaced: vi.fn(),
  onKeptBoth: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MediaEnhancementDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMediaEnhance.mockReturnValue(makeHook());
  });

  describe('params step', () => {
    it('renders the params step by default (idle status) and calls resumeLatest on open', async () => {
      const resumeLatest = vi.fn().mockResolvedValue(undefined);
      mockUseMediaEnhance.mockReturnValue(makeHook({ resumeLatest }));

      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.getByText(/ai enhance/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^enhance$/i })).toBeInTheDocument();

      await waitFor(() => {
        expect(resumeLatest).toHaveBeenCalledTimes(1);
      });
      // No `enhancementId` prop -> the existing per-item behaviour (resolve
      // the item's LATEST enhancement) must be preserved exactly.
      expect(resumeLatest).toHaveBeenCalledWith(undefined);
    });

    it('resumes a NAMED enhancement when opened from the hub (issue #201)', async () => {
      const resumeLatest = vi.fn().mockResolvedValue(undefined);
      mockUseMediaEnhance.mockReturnValue(makeHook({ resumeLatest }));

      render(<MediaEnhancementDrawer {...baseProps} enhancementId="enh-42" />);

      await waitFor(() => {
        expect(resumeLatest).toHaveBeenCalledWith('enh-42');
      });
      // Still the SAME resume path — the hub does not add a second one.
      expect(resumeLatest).toHaveBeenCalledTimes(1);
    });

    it('calls start() with empty params when the Enhance button is clicked without customizing', async () => {
      const start = vi.fn().mockResolvedValue(undefined);
      mockUseMediaEnhance.mockReturnValue(makeHook({ start }));

      const user = userEvent.setup();
      render(<MediaEnhancementDrawer {...baseProps} />);

      await user.click(screen.getByRole('button', { name: /^enhance$/i }));

      expect(start).toHaveBeenCalledWith({});
    });

    it('shows the model label when provided', () => {
      mockUseMediaEnhance.mockReturnValue(makeHook());
      render(<MediaEnhancementDrawer {...baseProps} modelLabel="gpt-image-1" />);

      expect(screen.getByText(/gpt-image-1/i)).toBeInTheDocument();
    });
  });

  describe('progress step', () => {
    it('shows a spinner and hides the params form while polling', () => {
      mockUseMediaEnhance.mockReturnValue(makeHook({ status: 'processing', polling: true }));

      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.getByText(/enhancing your photo/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^enhance$/i })).not.toBeInTheDocument();
    });
  });

  describe('compare step', () => {
    it('renders both compare panes and the dimensions/size delta once the enhancement is ready', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto() }),
      );

      render(<MediaEnhancementDrawer {...baseProps} />);

      // "Original"/"Enhanced" each appear twice: once as the compare-pane
      // label, once as a metadata-table column header.
      expect(screen.getAllByText('Original').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('Enhanced').length).toBeGreaterThanOrEqual(2);
      // Dimensions are identical in the fixture -> "4032×3024" appears twice
      expect(screen.getAllByText('4032×3024')).toHaveLength(2);

      expect(screen.getByRole('button', { name: /keep both/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /replace original/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    });

    it('shows a downscale warning when the enhanced image is smaller than the original', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({
          status: 'ready',
          data: makeEnhancementDto({
            downscaled: true,
            enhanced: {
              url: 'https://cdn.example.com/enhanced.jpg',
              width: 2016,
              height: 1512,
              size: '900000',
            },
          }),
        }),
      );

      render(<MediaEnhancementDrawer {...baseProps} />);

      // The reason is plain text in the DOM, not a hover-only tooltip (#426),
      // and names the exact resolution loss.
      expect(
        screen.getByText(/enhanced image is lower resolution than the original/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/4032×3024 \(12\.2 MP\) → 2016×1512 \(3\.0 MP\)/)).toBeInTheDocument();
    });

    it('does not show a downscale warning when dimensions are unchanged', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto({ downscaled: false }) }),
      );

      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(
        screen.queryByText(/enhanced image is lower resolution than the original/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('decision flow — Keep both', () => {
    it('opens a confirm dialog, and on confirm calls apply("keep_both"), onKeptBoth, and onClose', async () => {
      const apply = vi.fn().mockResolvedValue({ id: 'new-item-1' });
      const onKeptBoth = vi.fn();
      const onClose = vi.fn();
      const reset = vi.fn();
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto(), apply, reset }),
      );

      const user = userEvent.setup();
      render(
        <MediaEnhancementDrawer {...baseProps} onKeptBoth={onKeptBoth} onClose={onClose} />,
      );

      await user.click(screen.getByRole('button', { name: /keep both/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/keep both photos\?/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /^keep both$/i }));

      await waitFor(() => {
        expect(apply).toHaveBeenCalledWith('keep_both');
      });
      expect(onKeptBoth).toHaveBeenCalledWith(expect.any(String));
      expect(reset).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('decision flow — Replace', () => {
    it('opens a confirm dialog, and on confirm calls apply("replace"), onReplaced, and onClose', async () => {
      const apply = vi.fn().mockResolvedValue({ status: 'ready', width: 4032, height: 3024 });
      const onReplaced = vi.fn();
      const onClose = vi.fn();
      const reset = vi.fn();
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto(), apply, reset }),
      );

      const user = userEvent.setup();
      render(
        <MediaEnhancementDrawer {...baseProps} onReplaced={onReplaced} onClose={onClose} />,
      );

      await user.click(screen.getByRole('button', { name: /replace original/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/replace the original\?/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /^replace$/i }));

      await waitFor(() => {
        // No acknowledgement on an ordinary replace: the flag is only ever sent
        // when the admin downscale guard is actually in force (#426).
        expect(apply).toHaveBeenCalledWith('replace', { acknowledgeDownscale: false });
      });
      expect(onReplaced).toHaveBeenCalledTimes(1);
      expect(reset).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('decision flow — Discard', () => {
    it('opens a confirm dialog, and on confirm calls discard() and onClose (no keep/replace callback)', async () => {
      const discard = vi.fn().mockResolvedValue(undefined);
      const onReplaced = vi.fn();
      const onKeptBoth = vi.fn();
      const onClose = vi.fn();
      const reset = vi.fn();
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto(), discard, reset }),
      );

      const user = userEvent.setup();
      render(
        <MediaEnhancementDrawer
          {...baseProps}
          onReplaced={onReplaced}
          onKeptBoth={onKeptBoth}
          onClose={onClose}
        />,
      );

      await user.click(screen.getByRole('button', { name: /discard/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/discard this enhancement\?/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /^discard$/i }));

      await waitFor(() => {
        expect(discard).toHaveBeenCalledTimes(1);
      });
      expect(onReplaced).not.toHaveBeenCalled();
      expect(onKeptBoth).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('decision flow — error handling', () => {
    it('shows an error alert and keeps the drawer open when apply() rejects', async () => {
      const apply = vi.fn().mockRejectedValue(new Error('Apply failed'));
      const onClose = vi.fn();
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto(), apply }),
      );

      const user = userEvent.setup();
      render(<MediaEnhancementDrawer {...baseProps} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /keep both/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^keep both$/i }));

      await waitFor(() => {
        expect(screen.getByText('Apply failed')).toBeInTheDocument();
      });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Presets (issue #98 commit set E)
  // ---------------------------------------------------------------------------
  describe('presets', () => {
    it('renders all 6 preset cards', () => {
      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.getByRole('button', { name: /^auto —/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^restore old photo —/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^low-light rescue —/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^colorize b&w —/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^portrait polish —/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^custom —/i })).toBeInTheDocument();
    });

    it('"Auto" is selected by default', () => {
      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.getByRole('button', { name: /^auto —/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('selecting "Restore old photo" pre-fills the Customize panel with its adjustments and strength', async () => {
      const user = userEvent.setup();
      render(<MediaEnhancementDrawer {...baseProps} />);

      await user.click(screen.getByRole('button', { name: /^restore old photo —/i }));
      expect(screen.getByRole('button', { name: /^restore old photo —/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await user.click(screen.getByRole('button', { name: /customize/i }));

      // restore_old_photo prefill: dehaze:true, strength:'strong'
      const dehazeSwitch = screen
        .getByText(/remove haze/i)
        .closest('.MuiFormControlLabel-root')!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(dehazeSwitch.checked).toBe(true);

      // The Strength <Select> has no explicit labelId association in the
      // component, so getByLabelText can't resolve it — scope by DOM order
      // instead: Strength is the first combobox in the Customize panel,
      // Output quality the second.
      const [strengthSelect] = screen.getAllByRole('combobox');
      expect(strengthSelect).toHaveTextContent(/strong/i);
    });

    it('selecting "Portrait polish" pre-fills a subtle strength', async () => {
      const user = userEvent.setup();
      render(<MediaEnhancementDrawer {...baseProps} />);

      await user.click(screen.getByRole('button', { name: /^portrait polish —/i }));
      await user.click(screen.getByRole('button', { name: /customize/i }));

      const [strengthSelect] = screen.getAllByRole('combobox');
      expect(strengthSelect).toHaveTextContent(/subtle/i);
    });

    it('sends the preset key in start() params for a real preset with nothing customized', async () => {
      const start = vi.fn().mockResolvedValue(undefined);
      mockUseMediaEnhance.mockReturnValue(makeHook({ start }));

      const user = userEvent.setup();
      render(<MediaEnhancementDrawer {...baseProps} />);

      await user.click(screen.getByRole('button', { name: /^low-light rescue —/i }));
      await user.click(screen.getByRole('button', { name: /^enhance$/i }));

      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ preset: 'low_light', strength: 'strong' }),
      );
      // auto/custom are UI-only and must never be sent as `preset`.
      expect(start.mock.calls[0][0]).not.toHaveProperty('intent');
    });

    it('does not send a preset for "Auto"', async () => {
      const start = vi.fn().mockResolvedValue(undefined);
      mockUseMediaEnhance.mockReturnValue(makeHook({ start }));

      const user = userEvent.setup();
      render(<MediaEnhancementDrawer {...baseProps} />);

      await user.click(screen.getByRole('button', { name: /^enhance$/i }));

      expect(start).toHaveBeenCalledWith({});
    });

    describe('Colorize B&W interpretive warning', () => {
      it('shows an "Interpretive" chip on the Colorize B&W card', () => {
        render(<MediaEnhancementDrawer {...baseProps} />);

        expect(
          screen.getByRole('button', { name: /^colorize b&w —/i }),
        ).toHaveTextContent(/interpretive/i);
      });

      it('shows the interpretive warning alert once Colorize B&W is selected', async () => {
        const user = userEvent.setup();
        render(<MediaEnhancementDrawer {...baseProps} />);

        expect(
          screen.queryByText(/colorizing is interpretive/i),
        ).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /^colorize b&w —/i }));

        expect(screen.getByText(/colorizing is interpretive/i)).toBeInTheDocument();
      });

      it('hides the interpretive warning once a different preset is selected', async () => {
        const user = userEvent.setup();
        render(<MediaEnhancementDrawer {...baseProps} />);

        await user.click(screen.getByRole('button', { name: /^colorize b&w —/i }));
        expect(screen.getByText(/colorizing is interpretive/i)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /^auto —/i }));
        expect(
          screen.queryByText(/colorizing is interpretive/i),
        ).not.toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Start error visible in the params step (the fixed bug — see
  // useMediaEnhance.test.ts for the underlying hook-level coverage)
  // ---------------------------------------------------------------------------
  describe('params step — start error', () => {
    it('shows the hook error alert in the params step', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'idle', error: 'Picture enhancement is disabled' }),
      );

      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.getByText('Picture enhancement is disabled')).toBeInTheDocument();
      // Still on the params step — the Enhance button is available to retry.
      expect(screen.getByRole('button', { name: /^enhance$/i })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Replace policy (issue #98 — server-resolved replacePolicy prop)
  // ---------------------------------------------------------------------------
  describe('replace policy', () => {
    it('does not render the Replace button when allowReplace is false', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto() }),
      );

      render(
        <MediaEnhancementDrawer
          {...baseProps}
          replacePolicy={{ allowReplace: false, blockReplaceOnDownscale: false }}
        />,
      );

      expect(
        screen.queryByRole('button', { name: /replace original/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/an administrator has disabled replacing originals/i),
      ).toBeInTheDocument();
      // Keep both / discard remain available.
      expect(screen.getByRole('button', { name: /keep both/i })).toBeInTheDocument();
    });

    /**
     * Issue #426. `blockReplaceOnDownscale` used to disable the button outright
     * with the reason living only in a hover tooltip — unreachable on touch,
     * and (because gpt-image-1 caps output at ~1.6 MP) permanent for every real
     * photo. It is now a confirm-through guard whose reason is always in the
     * DOM. The assertions below deliberately perform NO hover or pointer
     * interaction before reading the reason.
     */
    function renderBlockedByDownscale(
      overrides: Partial<Parameters<typeof makeHook>[0]> = {},
    ) {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({
          status: 'ready',
          data: makeEnhancementDto({
            downscaled: true,
            enhanced: {
              url: 'https://cdn.example.com/enhanced.jpg',
              width: 2016,
              height: 1512,
              size: '900000',
            },
          }),
          ...overrides,
        }),
      );

      return render(
        <MediaEnhancementDrawer
          {...baseProps}
          replacePolicy={{ allowReplace: true, blockReplaceOnDownscale: true }}
        />,
      );
    }

    it('states the reason in the DOM without any hover when blockReplaceOnDownscale applies', () => {
      renderBlockedByDownscale();

      expect(
        screen.getByText(/an administrator has set replacing to be blocked/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/4032×3024 \(12\.2 MP\) → 2016×1512 \(3\.0 MP\)/)).toBeInTheDocument();
    });

    it('keeps Replace usable under blockReplaceOnDownscale so the block can be passed knowingly', () => {
      renderBlockedByDownscale();

      expect(screen.getByRole('button', { name: /replace original/i })).not.toBeDisabled();
    });

    it('sends acknowledgeDownscale only after the escalated confirmation', async () => {
      const apply = vi.fn().mockResolvedValue({ data: { status: 'ready' } });
      const user = userEvent.setup();
      renderBlockedByDownscale({ apply });

      await user.click(screen.getByRole('button', { name: /replace original/i }));
      expect(apply).not.toHaveBeenCalled();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/you will lose resolution/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /^replace$/i }));

      await waitFor(() => {
        expect(apply).toHaveBeenCalledWith('replace', { acknowledgeDownscale: true });
      });
    });

    it('renders the Replace button ENABLED when blockReplaceOnDownscale is true but the result is not downscaled', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto({ downscaled: false }) }),
      );

      render(
        <MediaEnhancementDrawer
          {...baseProps}
          replacePolicy={{ allowReplace: true, blockReplaceOnDownscale: true }}
        />,
      );

      expect(screen.getByRole('button', { name: /replace original/i })).not.toBeDisabled();
    });

    it('renders the Replace button ENABLED (default policy) when no replacePolicy prop is supplied', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({ status: 'ready', data: makeEnhancementDto() }),
      );

      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.getByRole('button', { name: /replace original/i })).not.toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Model label
  // ---------------------------------------------------------------------------
  describe('model label', () => {
    it('renders the modelLabel prop in the params step when no run data exists yet', () => {
      render(<MediaEnhancementDrawer {...baseProps} modelLabel="gpt-image-1" />);

      expect(screen.getByText(/model:/i)).toBeInTheDocument();
      expect(screen.getByText('gpt-image-1')).toBeInTheDocument();
    });

    it('prefers the run data model over the modelLabel prop once ready', () => {
      mockUseMediaEnhance.mockReturnValue(
        makeHook({
          status: 'ready',
          data: makeEnhancementDto({ model: 'gpt-image-1-run' }),
        }),
      );

      render(<MediaEnhancementDrawer {...baseProps} modelLabel="gpt-image-1-fallback" />);

      expect(screen.getByText(/enhanced with/i)).toBeInTheDocument();
      expect(screen.getByText('gpt-image-1-run')).toBeInTheDocument();
      expect(screen.queryByText('gpt-image-1-fallback')).not.toBeInTheDocument();
    });

    it('renders nothing model-related when neither modelLabel nor run data provide one', () => {
      render(<MediaEnhancementDrawer {...baseProps} />);

      expect(screen.queryByText(/^model:/i)).not.toBeInTheDocument();
    });
  });
});

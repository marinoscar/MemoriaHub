/**
 * Tests for `BottomNav` (issue #392, epic #388, spec §4.1).
 *
 * `useReviewQueues` is mocked directly so the dot-badge/accessible-name cases
 * can drive `totalPending` without touching the network. `BottomNav` self-gates
 * on `down('md')`, so every test renders at the default (all-`matches:false`)
 * viewport, matching `setup.ts`'s baseline — the phone treatment — unless a
 * case explicitly widens the viewport to prove the component renders nothing
 * above `md`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BottomNav } from '../../../components/navigation/BottomNav';

vi.mock('../../../hooks/useReviewQueues', () => ({
  useReviewQueues: vi.fn(),
}));

import { useReviewQueues } from '../../../hooks/useReviewQueues';
import type { UseReviewQueuesResult } from '../../../hooks/useReviewQueues';

const mockUseReviewQueues = vi.mocked(useReviewQueues);

function reviewQueues(overrides: Partial<UseReviewQueuesResult> = {}): UseReviewQueuesResult {
  return {
    entries: [],
    counts: null,
    totalPending: 0,
    isLoading: false,
    anyEnabled: true,
    ...overrides,
  };
}

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const min = query.match(/min-width:\s*([\d.]+)px/);
      const max = query.match(/max-width:\s*([\d.]+)px/);
      let matches = true;
      if (min) matches = matches && px >= parseFloat(min[1]);
      if (max) matches = matches && px <= parseFloat(max[1]);
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function restoreDefaultViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const PHONE_WIDTH = 400; // < md(900) -> down('md') matches -> BottomNav renders

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The suite-wide `matchMedia` baseline (setup.ts) reports every query as
    // NOT matching, which for `down('md')` means "not mobile" — the opposite
    // of the treatment this component exists for. So every case here needs an
    // explicit phone-width viewport; only the "renders nothing at md+" case
    // below widens it.
    setViewportWidth(PHONE_WIDTH);
    mockUseReviewQueues.mockReturnValue(reviewQueues());
  });

  afterEach(() => {
    restoreDefaultViewport();
  });

  // =========================================================================
  // The 4-item catalog, nothing else
  // =========================================================================

  it('renders exactly the 4 destinations: Photos, Collections, Search, Review', () => {
    const { container } = render(<BottomNav />, { wrapperOptions: { route: '/' } });

    const items = container.querySelectorAll('.MuiBottomNavigationAction-root');
    expect(items).toHaveLength(4);
    expect(screen.getByText('Photos')).toBeInTheDocument();
    expect(screen.getByText('Collections')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('renders no "More" action and no hamburger', () => {
    render(<BottomNav />, { wrapperOptions: { route: '/' } });

    expect(screen.queryByText('More')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
  });

  it('renders nothing at md and above (self-gated on down("md"))', () => {
    setViewportWidth(1000);

    const { container } = render(<BottomNav />, { wrapperOptions: { route: '/' } });

    expect(container.firstChild).toBeNull();
  });

  // =========================================================================
  // Review's dot badge — never a number
  // =========================================================================

  describe("Review's badge", () => {
    it('renders a dot badge (not a numeral) when pending > 0', () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 4 }));

      const { container } = render(<BottomNav />, { wrapperOptions: { route: '/' } });

      const badge = container.querySelector('.MuiBadge-badge');
      expect(badge).not.toBeNull();
      expect(badge?.classList.contains('MuiBadge-dot')).toBe(true);
      // No visible numeral anywhere in the badge content.
      expect(badge?.textContent).toBe('');
    });

    it('renders no badge at all when pending is zero', () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 0 }));

      const { container } = render(<BottomNav />, { wrapperOptions: { route: '/' } });

      expect(container.querySelector('.MuiBadge-badge')).toBeNull();
    });

    it("the dot's accessible name still carries the count", () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 4 }));

      render(<BottomNav />, { wrapperOptions: { route: '/' } });

      expect(screen.getByRole('button', { name: 'Review, 4 items pending' })).toBeInTheDocument();
    });

    it('carries just "Review" as the accessible name when pending is zero', () => {
      mockUseReviewQueues.mockReturnValue(reviewQueues({ totalPending: 0 }));

      render(<BottomNav />, { wrapperOptions: { route: '/' } });

      expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Active state — driven by resolveActiveDestination, not a path prefix
  // =========================================================================

  describe('active state', () => {
    it('selects Photos at /', () => {
      render(<BottomNav />, { wrapperOptions: { route: '/' } });

      expect(screen.getByText('Photos').closest('button')).toHaveClass('Mui-selected');
    });

    it('selects Review at /bursts, a route that does not resemble "review"', () => {
      render(<BottomNav />, { wrapperOptions: { route: '/bursts' } });

      expect(screen.getByText('Review').closest('button')).toHaveClass('Mui-selected');
    });

    it('selects Collections at /albums/:id, a child route', () => {
      render(<BottomNav />, { wrapperOptions: { route: '/albums/some-id' } });

      expect(screen.getByText('Collections').closest('button')).toHaveClass('Mui-selected');
    });

    it('selects nothing on /admin/*  — the bar stays Library navigation, never a Console state', () => {
      const { container } = render(<BottomNav />, { wrapperOptions: { route: '/admin/settings/jobs' } });

      expect(container.querySelectorAll('.Mui-selected')).toHaveLength(0);
    });

    it('selects nothing on a deliberately-unowned route (/settings)', () => {
      const { container } = render(<BottomNav />, { wrapperOptions: { route: '/settings' } });

      expect(container.querySelectorAll('.Mui-selected')).toHaveLength(0);
    });
  });

  // =========================================================================
  // Navigation targets
  // =========================================================================

  it('Search points at /search', async () => {
    render(<BottomNav />, { wrapperOptions: { route: '/' } });
    // BottomNavigationAction renders as a <button>, not a link — assert via
    // clicking (wrapped in userEvent's own act()) and observing the resulting
    // active state instead of href.
    const user = userEvent.setup();
    await user.click(screen.getByText('Search').closest('button') as HTMLElement);
    expect(screen.getByText('Search').closest('button')).toHaveClass('Mui-selected');
  });
});

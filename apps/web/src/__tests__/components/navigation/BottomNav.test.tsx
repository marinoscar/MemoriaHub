/**
 * The phone bottom bar — the app's binding of the packaged `ShellBottomNav`
 * (RETRO-F1, #571; the bar itself is issue #392 / #402).
 *
 * What the binding owns and this file pins: the bar draws exactly the four
 * library destinations (never the Console, even for an admin, so it never
 * overflows into a More sheet), active state follows the destination model,
 * Review's badge carries the pending count in its accessible name, and the bar
 * self-gates on `down('sm')` (gate 2, sampled on both sides of 600px).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { BottomNav } from '../../../components/navigation/BottomNav';
import { renderShell } from '../../utils/shell-harness';

vi.mock('../../../hooks/useReviewQueues', () => ({
  useReviewQueues: vi.fn(),
}));

import { useReviewQueues } from '../../../hooks/useReviewQueues';
import type { UseReviewQueuesResult } from '../../../hooks/useReviewQueues';

const mockUseReviewQueues = vi.mocked(useReviewQueues);

function queues(totalPending = 0): UseReviewQueuesResult {
  return { entries: [], counts: null, totalPending, isLoading: false, anyEnabled: true };
}

function bar() {
  return document.querySelector('.MuiBottomNavigation-root') as HTMLElement | null;
}

function selectedLabel(): string | null {
  const selected = bar()?.querySelector('.Mui-selected');
  return selected?.textContent ?? null;
}

describe('BottomNav (packaged ShellBottomNav binding)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseReviewQueues.mockReturnValue(queues());
  });

  it('draws exactly Photos, Collections, Search, Review — no Console even for an admin, no More', () => {
    renderShell(<BottomNav />, { width: 390, admin: true });
    const actions = within(bar()!).getAllByRole('button');
    expect(actions.map((a) => a.getAttribute('aria-label') ?? a.textContent)).toEqual([
      'Photos',
      'Collections',
      'Search',
      'Review',
    ]);
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Console')).not.toBeInTheDocument();
  });

  it.each([599, 360])('renders at %dpx (below sm)', (px) => {
    renderShell(<BottomNav />, { width: px });
    expect(bar()).not.toBeNull();
  });

  it.each([600, 700, 899, 900, 1200])('renders nothing at %dpx (sm and up, gate 2)', (px) => {
    renderShell(<BottomNav />, { width: px });
    expect(bar()).toBeNull();
  });

  it.each([
    ['/', 'Photos'],
    ['/albums/abc', 'Collect'],
    ['/bursts', 'Review'],
    ['/search', 'Search'],
  ])('at %s selects %s', (route, label) => {
    renderShell(<BottomNav />, { width: 390, route });
    expect(selectedLabel()).toContain(label);
  });

  it.each(['/settings', '/admin/settings/jobs', '/circles'])('selects nothing on %s', (route) => {
    renderShell(<BottomNav />, { width: 390, route, admin: true });
    expect(selectedLabel()).toBeNull();
  });

  it('navigates to /search from the Search tab', () => {
    renderShell(<BottomNav />, { width: 390 });
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Search' }));
    expect(selectedLabel()).toContain('Search');
  });

  it('carries the Review count in the accessible name, and none at zero', () => {
    mockUseReviewQueues.mockReturnValue(queues(12));
    const { unmount } = renderShell(<BottomNav />, { width: 390 });
    expect(within(bar()!).getByRole('button', { name: /Review.*12/ })).toBeInTheDocument();
    unmount();

    mockUseReviewQueues.mockReturnValue(queues(0));
    renderShell(<BottomNav />, { width: 390 });
    expect(within(bar()!).getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });
});

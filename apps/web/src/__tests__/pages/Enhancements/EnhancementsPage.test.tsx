/**
 * EnhancementsPage — hub shell tests (issue #201, PR1).
 *
 * Covers:
 *  - the no-active-circle guard
 *  - the three tabs, with only "Pending review" implemented in this PR
 *  - `?tab=` URL addressability in both directions (read on mount, mirrored on
 *    change), and that the default tab is kept OFF the wire
 *  - only the active tab's data is fetched
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSearchParams } from 'react-router-dom';
import { render } from '../../utils/test-utils';
import EnhancementsPage from '../../../pages/Enhancements/EnhancementsPage';

/**
 * The suite renders under MemoryRouter, so `window.location` never changes.
 * This probe surfaces the router's own search string for assertion instead.
 */
function SearchParamsProbe() {
  const [params] = useSearchParams();
  return <div data-testid="search-params">{params.toString()}</div>;
}

// The tab has its own suite; stub it so the shell's behaviour is isolated and
// no list request is made from here.
const pendingTabSpy = vi.fn();
vi.mock('../../../pages/Enhancements/PendingEnhancementsTab', () => ({
  PendingEnhancementsTab: (props: { circleId: string }) => {
    pendingTabSpy(props);
    return <div data-testid="pending-tab">pending tab for {props.circleId}</div>;
  },
}));

describe('EnhancementsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the user to pick a circle when none is active', () => {
    render(<EnhancementsPage />, { wrapperOptions: { activeCircle: null } });

    expect(screen.getByText('Select a circle to review AI enhancements.')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('renders the three tabs with Pending review active by default', () => {
    render(<EnhancementsPage />);

    expect(screen.getByRole('tab', { name: 'Pending review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Enhanced photos' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'Pending review' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('pending-tab')).toBeInTheDocument();
  });

  it('passes the active circle id down to the pending tab', () => {
    render(<EnhancementsPage />);
    // objectContaining, because the tab also receives the optional batch-filter
    // props (issue #423) which this assertion is not about.
    expect(pendingTabSpy).toHaveBeenCalledWith(
      expect.objectContaining({ circleId: 'circle-1' }),
    );
  });

  it('opens the tab named by ?tab= on mount', () => {
    render(<EnhancementsPage />, { wrapperOptions: { route: '/enhancements?tab=history' } });

    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText(/History — the full audit trail/)).toBeInTheDocument();
  });

  it('falls back to the default tab for an unknown ?tab= value', () => {
    render(<EnhancementsPage />, { wrapperOptions: { route: '/enhancements?tab=bogus' } });

    expect(screen.getByRole('tab', { name: 'Pending review' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('only renders (and therefore only fetches) the active tab', async () => {
    const user = userEvent.setup();
    render(<EnhancementsPage />);

    expect(screen.getByTestId('pending-tab')).toBeInTheDocument();
    expect(pendingTabSpy).toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: 'Enhanced photos' }));

    await waitFor(() => {
      expect(screen.queryByTestId('pending-tab')).toBeNull();
    });
    const callsWhileAway = pendingTabSpy.mock.calls.length;

    await user.click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() => {
      expect(screen.getByText(/History — the full audit trail/)).toBeInTheDocument();
    });
    // The pending tab stayed unmounted, so it issued no further work.
    expect(pendingTabSpy).toHaveBeenCalledTimes(callsWhileAway);
  });

  it('renders a coming-soon placeholder for the two PR3 tabs', async () => {
    const user = userEvent.setup();
    render(<EnhancementsPage />);

    // Matched on the body copy, not "Enhanced photos" — that string also
    // appears as the tab's own label.
    await user.click(screen.getByRole('tab', { name: 'Enhanced photos' }));
    expect(
      await screen.findByText(/a gallery of every enhancement you kept/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(
      await screen.findByText(/History — the full audit trail of past enhancements/),
    ).toBeInTheDocument();
  });

  it('mirrors a non-default tab into the URL and removes it again on return', async () => {
    const user = userEvent.setup();
    render(
      <>
        <EnhancementsPage />
        <SearchParamsProbe />
      </>,
      { wrapperOptions: { route: '/enhancements' } },
    );

    // Default tab is deliberately kept off the wire.
    expect(screen.getByTestId('search-params')).toHaveTextContent('');

    await user.click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() => {
      expect(screen.getByTestId('search-params')).toHaveTextContent('tab=history');
    });

    await user.click(screen.getByRole('tab', { name: 'Pending review' }));
    await waitFor(() => {
      expect(screen.getByTestId('search-params').textContent).toBe('');
    });
  });
});

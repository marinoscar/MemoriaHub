/**
 * Unit tests — PageSearchBar / PageSearchBarSection
 *
 * PageSearchBar is the regression guard's namesake component for production
 * bug #400: it is the search input that lives IN `/search` itself, so the
 * page is self-sufficient when `TopbarSearch` is gated out of the AppBar
 * below `md`. Its behaviour intentionally mirrors `TopbarSearch` (see that
 * component's test file for the sibling coverage on the toolbar entry point):
 *   - Typing + Enter calls runAgentSearch with the trimmed query.
 *   - Empty / whitespace-only input never calls runAgentSearch.
 *   - No active circle disables the whole control.
 *   - The Tune button opens SearchPanel with the active circleId; its
 *     onSubmit wires to runDeterministicSearch and closes the panel.
 *   - The clear (X) button appears only once there is text, and clears it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE any import of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../../contexts/SearchContext', () => ({
  useSearch: vi.fn(),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

// A realistic minimal SearchRequest fixture used by the stubbed SearchPanel's
// "Apply" button — mirrors TopbarSearch.test.tsx's fixture exactly.
const FAKE_REQUEST = { circleId: 'circle-1', filters: { country: 'Costa Rica' } };

// Stub SearchPanel: records the props it was opened with (so we can assert
// circleId) and renders an "Apply" button that calls onSubmit when clicked.
const searchPanelSpy = vi.fn();
vi.mock('../../../components/search/SearchPanel', () => ({
  SearchPanel: vi.fn((props: any) => {
    searchPanelSpy(props);
    return props.open ? (
      <div data-testid="advanced-dialog">
        <button onClick={() => props.onSubmit(FAKE_REQUEST)}>Apply</button>
        <button onClick={props.onClose}>Cancel</button>
      </div>
    ) : null;
  }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { PageSearchBar, PageSearchBarSection } from '../../../components/search/PageSearchBar';
import { useSearch } from '../../../contexts/SearchContext';
import { useCircle } from '../../../hooks/useCircle';

const mockUseSearch = vi.mocked(useSearch);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSearchMock() {
  return {
    messages: [],
    results: null,
    isSearching: false,
    error: null,
    searchRequest: null,
    runAgentSearch: vi.fn(),
    runDeterministicSearch: vi.fn(),
    clearSearch: vi.fn(),
  };
}

function defaultCircleMock() {
  return {
    activeCircle: { id: 'circle-1', name: 'My Circle' },
    activeCircleId: 'circle-1',
    activeCircleRole: 'circle_admin' as const,
    circles: [],
    loading: false,
    setActiveCircle: vi.fn(),
    refreshCircles: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PageSearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchPanelSpy.mockClear();
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  describe('rendering', () => {
    it('renders a text input labelled "Search your photos"', () => {
      render(<PageSearchBar />);

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
    });

    it('renders an "Advanced search" button', () => {
      render(<PageSearchBar />);

      expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
    });

    it('the advanced search button announces it opens a dialog', () => {
      render(<PageSearchBar />);

      expect(
        screen.getByRole('button', { name: /advanced search/i }),
      ).toHaveAttribute('aria-haspopup', 'dialog');
    });
  });

  // -------------------------------------------------------------------------
  // Enter-to-submit
  // -------------------------------------------------------------------------
  describe('submitting via Enter', () => {
    it('calls runAgentSearch with the trimmed typed text when Enter is pressed', async () => {
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<PageSearchBar />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, '  vacation photos  {Enter}');

      expect(runAgentSearch).toHaveBeenCalledWith('vacation photos');
    });

    it('does NOT call runAgentSearch for an empty query', async () => {
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<PageSearchBar />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, '{Enter}');

      expect(runAgentSearch).not.toHaveBeenCalled();
    });

    it('does NOT call runAgentSearch for a whitespace-only query', async () => {
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<PageSearchBar />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, '   {Enter}');

      expect(runAgentSearch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No active circle — disabled control, submission is a no-op
  // -------------------------------------------------------------------------
  describe('no active circle', () => {
    it('disables the text input', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<PageSearchBar />);

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeDisabled();
    });

    it('disables the Advanced search button', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<PageSearchBar />);

      expect(screen.getByRole('button', { name: /advanced search/i })).toBeDisabled();
    });

    it('typing and pressing Enter does not call runAgentSearch', async () => {
      const runAgentSearch = vi.fn();
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<PageSearchBar />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      // The input itself is disabled, so user-event cannot type into it —
      // this in itself is the guarantee submission is unreachable. Fire the
      // key event directly to prove the handler also declines to act, in
      // case the disabled attribute is ever dropped from the markup.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(runAgentSearch).not.toHaveBeenCalled();
    });

    it('does not mount SearchPanel at all (no circleId to load facets with)', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<PageSearchBar />);

      expect(searchPanelSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Advanced search (SearchPanel) wiring
  // -------------------------------------------------------------------------
  describe('advanced search', () => {
    it('opens SearchPanel with the active circleId when the Tune button is clicked', async () => {
      const user = userEvent.setup();
      render(<PageSearchBar />);

      await user.click(screen.getByRole('button', { name: /advanced search/i }));

      expect(screen.getByTestId('advanced-dialog')).toBeInTheDocument();
      expect(searchPanelSpy).toHaveBeenCalledWith(
        expect.objectContaining({ open: true, circleId: 'circle-1' }),
      );
    });

    it('calls runDeterministicSearch and closes the panel when SearchPanel submits', async () => {
      const runDeterministicSearch = vi.fn();
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        runDeterministicSearch,
      } as any);

      const user = userEvent.setup();
      render(<PageSearchBar />);

      await user.click(screen.getByRole('button', { name: /advanced search/i }));
      await user.click(screen.getByRole('button', { name: /apply/i }));

      expect(runDeterministicSearch).toHaveBeenCalledWith(FAKE_REQUEST);
      expect(screen.queryByTestId('advanced-dialog')).not.toBeInTheDocument();
    });

    it('closes the panel when Cancel/onClose fires', async () => {
      const user = userEvent.setup();
      render(<PageSearchBar />);

      await user.click(screen.getByRole('button', { name: /advanced search/i }));
      expect(screen.getByTestId('advanced-dialog')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByTestId('advanced-dialog')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Clear button
  // -------------------------------------------------------------------------
  describe('clear button', () => {
    it('does not render when the input is empty', () => {
      render(<PageSearchBar />);

      expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();
    });

    it('appears once the input has text', async () => {
      const user = userEvent.setup();
      render(<PageSearchBar />);

      await user.type(screen.getByRole('textbox', { name: /search your photos/i }), 'dogs');

      expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument();
    });

    it('clears the input text when clicked', async () => {
      const user = userEvent.setup();
      render(<PageSearchBar />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, 'dogs');
      await user.click(screen.getByRole('button', { name: /clear search/i }));

      expect(input).toHaveValue('');
    });
  });
});

// ---------------------------------------------------------------------------
// PageSearchBarSection — thin wrapper used at all four SearchPage mount sites
// ---------------------------------------------------------------------------

describe('PageSearchBarSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchPanelSpy.mockClear();
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
  });

  it('renders the same input and advanced-search trigger as PageSearchBar', () => {
    render(<PageSearchBarSection />);

    expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /advanced search/i })).toBeInTheDocument();
  });
});

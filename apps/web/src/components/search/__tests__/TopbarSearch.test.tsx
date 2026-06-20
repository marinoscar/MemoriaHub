/**
 * Unit tests — TopbarSearch component
 *
 * Covers:
 *   - Typing and pressing Enter calls runAgentSearch with the typed text.
 *   - Clicking the search icon button also calls runAgentSearch.
 *   - Pressing the Tune button opens AdvancedSearchDialog.
 *   - AdvancedSearchDialog.onResults is wired to runAdvancedResults.
 *   - Clear button appears when input has text and clears it.
 *   - Phone branch: search icon expands overlay; back button collapses it.
 *
 * Note on Shift+Enter: TopbarSearch does NOT suppress Shift+Enter — the
 * component only checks `e.key === 'Enter'` and submits regardless of
 * modifier keys. This differs from textarea-based chat inputs.
 *
 * Note on phone tests: useMediaQuery is mocked at the module level via
 * vi.mock so the phone/desktop branches can be exercised without JSDOM
 * viewport changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';

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

// Stub AdvancedSearchDialog: renders an "Apply" button that calls onResults
// when clicked, so we can test the wiring.
vi.mock('../AdvancedSearchDialog', () => ({
  AdvancedSearchDialog: vi.fn(
    ({
      open,
      onResults,
      onClose,
    }: {
      open: boolean;
      onResults: (items: [], total: number) => void;
      onClose: () => void;
    }) =>
      open ? (
        <div data-testid="advanced-dialog">
          <button onClick={() => onResults([], 5)}>Apply</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      ) : null,
  ),
}));

// ---------------------------------------------------------------------------
// Phone-branch toggle: control isPhone by toggling this flag before each test.
// useMediaQuery is called inside TopbarSearch; we mock the entire @mui/material
// module so we can intercept the call and return the flag value.
// ---------------------------------------------------------------------------

let simulatePhone = false;

vi.mock('@mui/material', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mui/material')>();
  return {
    ...actual,
    useMediaQuery: () => simulatePhone,
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { TopbarSearch } from '../TopbarSearch';
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
    runAgentSearch: vi.fn(),
    runAdvancedResults: vi.fn(),
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

describe('TopbarSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    simulatePhone = false; // default: desktop layout
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  describe('rendering', () => {
    it('renders the search input with the correct placeholder', () => {
      render(<TopbarSearch />);

      expect(screen.getByRole('textbox', { name: /search your photos/i })).toBeInTheDocument();
    });

    it('renders the Tune (advanced filters) icon button', () => {
      render(<TopbarSearch />);

      expect(
        screen.getByRole('button', { name: /open advanced search filters/i }),
      ).toBeInTheDocument();
    });

    it('search icon button is disabled when input is empty', () => {
      render(<TopbarSearch />);

      expect(screen.getByRole('button', { name: /^search$/i })).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Enter key triggers runAgentSearch
  // -------------------------------------------------------------------------
  describe('keyboard submit', () => {
    it('calls runAgentSearch with the typed text when Enter is pressed', async () => {
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<TopbarSearch />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, 'vacation photos{Enter}');

      expect(runAgentSearch).toHaveBeenCalledWith('vacation photos');
    });

    it('also calls runAgentSearch when Shift+Enter is pressed (no special-case suppression)', async () => {
      // TopbarSearch checks only e.key === 'Enter', not e.shiftKey.
      // This is intentional — it is a single-line search pill, not a chat textarea.
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<TopbarSearch />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, 'hello{Shift>}{Enter}{/Shift}');

      expect(runAgentSearch).toHaveBeenCalledWith('hello');
    });
  });

  // -------------------------------------------------------------------------
  // Search icon click triggers runAgentSearch
  // -------------------------------------------------------------------------
  describe('search button submit', () => {
    it('calls runAgentSearch when the search icon button is clicked', async () => {
      const runAgentSearch = vi.fn();
      mockUseSearch.mockReturnValue({ ...defaultSearchMock(), runAgentSearch } as any);

      const user = userEvent.setup();
      render(<TopbarSearch />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, 'beach photos');

      const searchBtn = screen.getByRole('button', { name: /^search$/i });
      expect(searchBtn).not.toBeDisabled();
      await user.click(searchBtn);

      expect(runAgentSearch).toHaveBeenCalledWith('beach photos');
    });
  });

  // -------------------------------------------------------------------------
  // Clear button
  // -------------------------------------------------------------------------
  describe('clear button', () => {
    it('does not show the Clear button when input is empty', () => {
      render(<TopbarSearch />);

      expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();
    });

    it('shows the Clear button when input has text', async () => {
      const user = userEvent.setup();
      render(<TopbarSearch />);

      await user.type(
        screen.getByRole('textbox', { name: /search your photos/i }),
        'dogs',
      );

      expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument();
    });

    it('clears the input when the Clear button is clicked', async () => {
      const user = userEvent.setup();
      render(<TopbarSearch />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      await user.type(input, 'dogs');
      await user.click(screen.getByRole('button', { name: /clear search/i }));

      expect(input).toHaveValue('');
    });
  });

  // -------------------------------------------------------------------------
  // AdvancedSearchDialog wiring
  // -------------------------------------------------------------------------
  describe('advanced search dialog', () => {
    it('opens AdvancedSearchDialog when the Tune button is clicked', async () => {
      const user = userEvent.setup();
      render(<TopbarSearch />);

      await user.click(screen.getByRole('button', { name: /open advanced search filters/i }));

      expect(screen.getByTestId('advanced-dialog')).toBeInTheDocument();
    });

    it('calls runAdvancedResults when the dialog fires onResults', async () => {
      const runAdvancedResults = vi.fn();
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        runAdvancedResults,
      } as any);

      const user = userEvent.setup();
      render(<TopbarSearch />);

      await user.click(screen.getByRole('button', { name: /open advanced search filters/i }));
      await user.click(screen.getByRole('button', { name: /apply/i }));

      expect(runAdvancedResults).toHaveBeenCalledWith([], 5);
    });

    it('closes the dialog when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<TopbarSearch />);

      await user.click(screen.getByRole('button', { name: /open advanced search filters/i }));
      expect(screen.getByTestId('advanced-dialog')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByTestId('advanced-dialog')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Disabled state — no active circle
  // -------------------------------------------------------------------------
  describe('no active circle', () => {
    it('disables the search input when no circle is active', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<TopbarSearch />);

      const input = screen.getByRole('textbox', { name: /search your photos/i });
      expect(input).toBeDisabled();
    });

    it('does not open the AdvancedSearchDialog when no circle is active', async () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<TopbarSearch />);

      // Advanced button should be disabled — no dialog renders
      const tuneBtn = screen.getByRole('button', { name: /open advanced search filters/i });
      expect(tuneBtn).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Phone branch (useMediaQuery mocked truthy via module-level flag)
  // -------------------------------------------------------------------------
  describe('phone branch', () => {
    // simulatePhone is a module-level flag read by the vi.mock('@mui/material/useMediaQuery')
    // factory above.  Set it before rendering to exercise the phone layout.

    it('renders an "Open search" icon button on phone-sized viewport', () => {
      simulatePhone = true;
      render(<TopbarSearch />);

      expect(screen.getByRole('button', { name: /open search/i })).toBeInTheDocument();
    });

    it('expands the overlay when the phone search button is clicked', async () => {
      simulatePhone = true;

      const user = userEvent.setup();
      render(<TopbarSearch />);

      await user.click(screen.getByRole('button', { name: /open search/i }));

      // After expanding, the input should be visible
      expect(
        screen.getByRole('textbox', { name: /search your photos/i }),
      ).toBeInTheDocument();
    });

    it('collapses the overlay when the back button is clicked', async () => {
      simulatePhone = true;

      const user = userEvent.setup();
      render(<TopbarSearch />);

      await user.click(screen.getByRole('button', { name: /open search/i }));
      await user.click(screen.getByRole('button', { name: /close search/i }));

      await waitFor(() => {
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      });
    });
  });
});

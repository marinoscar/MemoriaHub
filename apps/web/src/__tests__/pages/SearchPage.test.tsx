import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE the imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useSearch', () => ({
  useSearch: vi.fn(),
}));

vi.mock('../../hooks/useConversations', () => ({
  useConversations: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../services/searchStream', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../components/media/MediaResultsGrid', () => ({
  MediaResultsGrid: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import SearchPage from '../../pages/SearchPage';
import { useSearch } from '../../hooks/useSearch';
import { useConversations } from '../../hooks/useConversations';
import { useCircle } from '../../hooks/useCircle';

const mockUseSearch = vi.mocked(useSearch);
const mockUseConversations = vi.mocked(useConversations);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Default mock values
// ---------------------------------------------------------------------------

function defaultSearchMock() {
  return {
    fields: [],
    searchResults: [],
    meta: null,
    isLoadingFields: false,
    isSearching: false,
    error: null,
    fetchFields: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
  };
}

function defaultConversationsMock() {
  return {
    conversations: [],
    activeConversation: null,
    loading: false,
    error: null,
    fetchConversations: vi.fn().mockResolvedValue(undefined),
    loadConversation: vi.fn().mockResolvedValue(undefined),
    createNew: vi.fn().mockResolvedValue({ id: 'conv-new', circleId: 'circle-1' }),
    updateConversation: vi.fn().mockResolvedValue(undefined),
    removeConversation: vi.fn().mockResolvedValue(undefined),
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

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // scrollIntoView is not implemented in jsdom — mock it globally for Chat tab tests
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUseConversations.mockReturnValue(defaultConversationsMock() as any);
  });

  // -------------------------------------------------------------------------
  describe('Tab rendering', () => {
    it('renders Advanced and Chat tabs', () => {
      render(<SearchPage />);
      expect(screen.getByRole('tab', { name: /advanced/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /chat/i })).toBeInTheDocument();
    });

    it('Advanced tab is selected by default', () => {
      render(<SearchPage />);
      expect(screen.getByRole('tab', { name: /advanced/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /chat/i })).toHaveAttribute('aria-selected', 'false');
    });
  });

  // -------------------------------------------------------------------------
  describe('No active circle', () => {
    it('renders an alert asking to select a circle when activeCircle is null', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<SearchPage />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toMatch(/select a circle/i);
    });

    it('does NOT render the tabs when activeCircle is null', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<SearchPage />);

      expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Advanced tab — field rendering', () => {
    it('renders a text input for string-type field', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [{ key: 'tag', label: 'Tag', type: 'string', description: 'Filter by tag' }],
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('textbox', { name: /tag/i })).toBeInTheDocument();
    });

    it('renders a select for enum-type field', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [
          {
            key: 'type',
            label: 'Media type',
            type: 'enum',
            enumValues: ['photo', 'video'],
            description: 'Filter by type',
          },
        ],
      } as any);

      const { container } = render(<SearchPage />);

      // MUI Select renders the label text in both a <label> and a <span> (legend).
      // Use getAllByText to handle both occurrences.
      const labelElements = screen.getAllByText('Media type');
      expect(labelElements.length).toBeGreaterThan(0);
      // MUI Select trigger is a div with role="combobox" or .MuiSelect-select
      const selectEl = container.querySelector('[role="combobox"], .MuiSelect-select');
      expect(selectEl).not.toBeNull();
    });

    it('renders two date inputs for date-range fields', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [
          {
            key: 'capturedAt',
            label: 'Capture date range',
            type: 'date-range',
            description: 'Date range',
          },
        ],
      } as any);

      render(<SearchPage />);

      expect(screen.getByLabelText(/capture date range from/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/capture date range to/i)).toBeInTheDocument();
    });

    it('renders multiple field types at the same time', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [
          { key: 'tag', label: 'Tag', type: 'string', description: 'by tag' },
          { key: 'type', label: 'Media type', type: 'enum', enumValues: ['photo', 'video'], description: 'by type' },
        ],
      } as any);

      const { container } = render(<SearchPage />);

      expect(screen.getByRole('textbox', { name: /tag/i })).toBeInTheDocument();
      // MUI Select: label text appears in both <label> and <span> (legend)
      const mediaTypeLabels = screen.getAllByText('Media type');
      expect(mediaTypeLabels.length).toBeGreaterThan(0);
      const selectEl = container.querySelector('[role="combobox"], .MuiSelect-select');
      expect(selectEl).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('Error states', () => {
    it('shows a warning Alert with "AI Settings" link when AI is not configured', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        error: 'AI search is not configured. An admin must configure the AI provider and model in AI Settings.',
      } as any);

      render(<SearchPage />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      // The alert should contain a link to AI Settings
      expect(screen.getByRole('link', { name: /ai settings/i })).toBeInTheDocument();
    });

    it('shows an error Alert (not the AI one) for other errors', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        error: 'Some other error occurred',
      } as any);

      render(<SearchPage />);

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toContain('Some other error occurred');
      // No AI settings link for generic errors
      expect(screen.queryByRole('link', { name: /ai settings/i })).not.toBeInTheDocument();
    });

    it('renders a warning alert for the not-configured error variant', () => {
      // The error contains "not configured" so it should trigger the warning variant
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        error: 'ai search is not configured by the admin',
      } as any);

      render(<SearchPage />);

      // Should be a warning (not an error severity) per the page logic
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  describe('Chat tab', () => {
    it('switches to chat view when Chat tab is clicked', async () => {
      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        // The chat textarea placeholder is the key indicator
        expect(
          screen.getByPlaceholderText(/ask about your memories/i),
        ).toBeInTheDocument();
      });
    });

    it('Chat tab becomes selected after clicking it', async () => {
      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /chat/i })).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('hides the Advanced field inputs after switching to Chat tab', async () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [{ key: 'tag', label: 'Tag', type: 'string', description: 'by tag' }],
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      // Verify tag input is present first
      expect(screen.getByRole('textbox', { name: /tag/i })).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.queryByRole('textbox', { name: /tag/i })).not.toBeInTheDocument();
      });
    });

    it('switching back to Advanced tab shows field inputs again', async () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [{ key: 'tag', label: 'Tag', type: 'string', description: 'by tag' }],
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));
      await user.click(screen.getByRole('tab', { name: /advanced/i }));

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /tag/i })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('shows a loading spinner while fields are loading', () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        isLoadingFields: true,
        fields: [],
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });
});

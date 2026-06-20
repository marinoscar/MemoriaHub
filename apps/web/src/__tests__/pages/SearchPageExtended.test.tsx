/**
 * Extended coverage for the new SearchPage.
 * Tests streaming behavior, keyboard interactions, and explore navigation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/useSearch', () => ({
  useSearch: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/usePeople', () => ({
  usePeople: vi.fn(),
}));

vi.mock('../../hooks/useUserSettings', () => ({
  useUserSettings: vi.fn(),
}));

vi.mock('../../services/searchAgentStream', () => ({
  streamAgent: vi.fn(),
}));

vi.mock('../../services/media', () => ({
  getExplorePlaces: vi.fn().mockResolvedValue([
    { name: 'Paris', count: 10, coverThumbnailUrl: null },
  ]),
  getExploreTags: vi.fn().mockResolvedValue([
    { name: 'beach', count: 5, coverThumbnailUrl: null },
  ]),
}));

vi.mock('../../components/media/MediaResultsGrid', () => ({
  MediaResultsGrid: vi.fn(() => null),
}));

vi.mock('../../components/search/AdvancedSearchDialog', () => ({
  AdvancedSearchDialog: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import SearchPage from '../../pages/SearchPage';
import { useSearch } from '../../hooks/useSearch';
import { useCircle } from '../../hooks/useCircle';
import { usePeople } from '../../hooks/usePeople';
import { useUserSettings } from '../../hooks/useUserSettings';
import { streamAgent } from '../../services/searchAgentStream';

const mockUseSearch = vi.mocked(useSearch);
const mockUseCircle = vi.mocked(useCircle);
const mockUsePeople = vi.mocked(usePeople);
const mockUseUserSettings = vi.mocked(useUserSettings);
const mockStreamAgent = vi.mocked(streamAgent);

// ---------------------------------------------------------------------------
// Default mock factories
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
    search: vi.fn().mockResolvedValue({ items: [], meta: { totalItems: 0, totalPages: 0, page: 1, pageSize: 20 } }),
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

function defaultPeopleMock() {
  return {
    data: { items: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    cluster: vi.fn(),
    assignFaces: vi.fn(),
    unassignFace: vi.fn(),
  };
}

function defaultUserSettingsMock() {
  return {
    settings: { search: { visibleFields: [] } },
    isLoading: false,
    error: null,
    updateSettings: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------

describe('SearchPage — extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUsePeople.mockReturnValue(defaultPeopleMock() as any);
    mockUseUserSettings.mockReturnValue(defaultUserSettingsMock() as any);
    mockStreamAgent.mockResolvedValue(undefined);
  });

  describe('Conversational search flow', () => {
    it('calls streamAgent with correct body when Send is clicked', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onDone?.();
      });

      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByRole('textbox', { name: /conversational search input/i });
      await user.type(input, 'photos from Paris');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(mockStreamAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            circleId: 'circle-1',
            messages: expect.arrayContaining([
              { role: 'user', content: 'photos from Paris' },
            ]),
          }),
          expect.any(Object),
          expect.any(AbortSignal),
        );
      });
    });

    it('does not send when Enter+Shift is pressed (newline)', async () => {
      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByRole('textbox', { name: /conversational search input/i });
      await user.type(input, 'line1{Shift>}{Enter}{/Shift}');

      expect(mockStreamAgent).not.toHaveBeenCalled();
    });

    it('shows streaming spinner while streaming', async () => {
      // Never resolves so we can observe streaming state
      mockStreamAgent.mockReturnValue(new Promise(() => {}));

      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByRole('textbox', { name: /conversational search input/i });
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        const progressbars = screen.getAllByRole('progressbar');
        expect(progressbars.length).toBeGreaterThan(0);
      });
    });

    it('clears conversation when New search is clicked', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onToken?.('Some response');
        handlers.onDone?.();
      });

      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByRole('textbox', { name: /conversational search input/i });
      await user.type(input, 'test query');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new search/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /new search/i }));

      await waitFor(() => {
        // After clearing, explore rows should be visible again
        expect(screen.queryByRole('button', { name: /new search/i })).not.toBeInTheDocument();
      });
    });
  });

  describe('Explore section', () => {
    it('shows Places and Tags from explore endpoints', async () => {
      render(<SearchPage />);

      await waitFor(() => {
        expect(screen.getByText('Paris')).toBeInTheDocument();
        expect(screen.getByText('beach')).toBeInTheDocument();
      });
    });

    it('hides explore section when conversation is active', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onDone?.();
      });

      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByRole('textbox', { name: /conversational search input/i });
      await user.type(input, 'hello');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        // After sending, explore rows should be hidden
        expect(screen.queryByText('Places')).not.toBeInTheDocument();
      });
    });
  });

  describe('Advanced search dialog', () => {
    it('opens the advanced dialog when Tune button is clicked', async () => {
      const { AdvancedSearchDialog } = await import('../../components/search/AdvancedSearchDialog');
      const mockDialog = vi.mocked(AdvancedSearchDialog);
      // Initially closed
      mockDialog.mockImplementation(({ open }) => open ? <div>dialog-open</div> : null);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('button', { name: /open advanced search options/i }));

      await waitFor(() => {
        expect(screen.getByText('dialog-open')).toBeInTheDocument();
      });
    });
  });
});

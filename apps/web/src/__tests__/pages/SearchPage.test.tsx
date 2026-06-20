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
  getExplorePlaces: vi.fn().mockResolvedValue([]),
  getExploreTags: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../components/media/MediaGallery', () => ({
  MediaGallery: vi.fn(() => null),
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

const mockUseSearch = vi.mocked(useSearch);
const mockUseCircle = vi.mocked(useCircle);
const mockUsePeople = vi.mocked(usePeople);
const mockUseUserSettings = vi.mocked(useUserSettings);

// ---------------------------------------------------------------------------
// Default mocks
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

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUsePeople.mockReturnValue(defaultPeopleMock() as any);
    mockUseUserSettings.mockReturnValue(defaultUserSettingsMock() as any);
  });

  describe('No active circle', () => {
    it('renders an alert when activeCircle is null', () => {
      mockUseCircle.mockReturnValue({
        ...defaultCircleMock(),
        activeCircle: null,
        activeCircleId: null,
      } as any);

      render(<SearchPage />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert').textContent).toMatch(/select a circle/i);
    });
  });

  describe('Search input', () => {
    it('renders the conversational search input', () => {
      render(<SearchPage />);
      // The aria-label is on the MUI TextField wrapper; query by placeholder instead.
      expect(screen.getByPlaceholderText(/search your memories/i)).toBeInTheDocument();
    });

    it('renders the tune icon button for advanced search', () => {
      render(<SearchPage />);
      expect(screen.getByRole('button', { name: /open advanced search options/i })).toBeInTheDocument();
    });

    it('send button is disabled when input is empty', () => {
      render(<SearchPage />);
      expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
    });

    it('send button becomes enabled when input has text', async () => {
      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByPlaceholderText(/search your memories/i);
      await user.type(input, 'hello');

      expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled();
    });
  });

  describe('Explore rows', () => {
    it('shows People section when people are available', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        },
      } as any);

      render(<SearchPage />);

      // People section header
      expect(screen.getByText('People')).toBeInTheDocument();
    });

    it('shows Places and Tags explore row headers', () => {
      render(<SearchPage />);
      expect(screen.getByText('Places')).toBeInTheDocument();
      expect(screen.getByText('Tags')).toBeInTheDocument();
    });
  });

  describe('Conversational thread', () => {
    it('shows New search button after sending a message', async () => {
      const { streamAgent } = await import('../../services/searchAgentStream');
      vi.mocked(streamAgent).mockImplementation(async (_body, handlers) => {
        handlers.onToken?.('Hello from assistant');
        handlers.onDone?.();
      });

      const user = userEvent.setup();
      render(<SearchPage />);

      const input = screen.getByPlaceholderText(/search your memories/i);
      await user.type(input, 'show me photos');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new search/i })).toBeInTheDocument();
      });
    });
  });
});

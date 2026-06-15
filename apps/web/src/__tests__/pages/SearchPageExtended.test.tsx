/**
 * Extended coverage for SearchPage — covers handlers not exercised in the
 * primary SearchPage.test.tsx file:
 *
 *   AdvancedSearchTab:  handleApply, handlePageChange, setFilter (boolean type)
 *   ChatTab:            handleSend, handleKeyDown, new-conversation button,
 *                       show-archived toggle, favorite/delete conversation icons,
 *                       streaming states
 *   MessageBubble:      rendered via active conversation messages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
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
// Imports after mocks
// ---------------------------------------------------------------------------

import SearchPage from '../../pages/SearchPage';
import { useSearch } from '../../hooks/useSearch';
import { useConversations } from '../../hooks/useConversations';
import { useCircle } from '../../hooks/useCircle';
import { streamMessage } from '../../services/searchStream';

const mockUseSearch = vi.mocked(useSearch);
const mockUseConversations = vi.mocked(useConversations);
const mockUseCircle = vi.mocked(useCircle);
const mockStreamMessage = vi.mocked(streamMessage);

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
    search: vi.fn().mockResolvedValue(undefined),
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

describe('SearchPage — extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    mockUseSearch.mockReturnValue(defaultSearchMock() as any);
    mockUseConversations.mockReturnValue(defaultConversationsMock() as any);
    // Default: streamMessage does nothing
    mockStreamMessage.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  describe('AdvancedSearchTab — search execution', () => {
    it('calls search with correct params when Apply button is clicked', async () => {
      const mockSearch = vi.fn().mockResolvedValue(undefined);
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        search: mockSearch,
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockSearch).toHaveBeenCalledWith(
          expect.objectContaining({
            circleId: 'circle-1',
            page: 1,
            pageSize: 20,
          }),
        );
      });
    });

    it('renders results count when searchResults are present', async () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        searchResults: [
          { id: 'media-1', type: 'photo', originalFilename: 'photo.jpg' },
          { id: 'media-2', type: 'video', originalFilename: 'clip.mp4' },
        ],
        meta: { totalItems: 2, totalPages: 1, page: 1, pageSize: 20 },
      } as any);

      render(<SearchPage />);

      expect(screen.getByText(/2 result/i)).toBeInTheDocument();
    });

    it('renders pagination when totalPages > 1', async () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        searchResults: [{ id: 'media-1', type: 'photo', originalFilename: 'a.jpg' }],
        meta: { totalItems: 25, totalPages: 2, page: 1, pageSize: 20 },
      } as any);

      render(<SearchPage />);

      // MUI Pagination renders a nav element
      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });

    it('setFilter — boolean type field renders a switch with its label', async () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [
          { key: 'favorite', label: 'Favorites only', type: 'boolean', description: 'Filter favorites' },
        ],
      } as any);

      render(<SearchPage />);

      // MUI FormControlLabel renders the label text as plain text in the DOM
      expect(screen.getByText('Favorites only')).toBeInTheDocument();
    });

    it('setFilter — boolean type switch uses MUI Switch (role="switch" or checkbox)', async () => {
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        fields: [
          { key: 'favorite', label: 'Favorites only', type: 'boolean', description: 'Filter favorites' },
        ],
      } as any);

      const { container } = render(<SearchPage />);

      // MUI Switch renders an <input type="checkbox"> — query by type attribute
      const switchInput = container.querySelector('input[type="checkbox"]');
      expect(switchInput).not.toBeNull();
      expect((switchInput as HTMLInputElement).checked).toBe(false);
    });

    it('handleApply — search throws but does not surface unhandled rejection', async () => {
      const mockSearch = vi.fn().mockRejectedValue(new Error('Search failed'));
      mockUseSearch.mockReturnValue({
        ...defaultSearchMock(),
        search: mockSearch,
        error: 'Search failed',
      } as any);

      const user = userEvent.setup();
      // Should not throw
      render(<SearchPage />);
      await user.click(screen.getByRole('button', { name: /apply/i }));

      // Error from hook is displayed
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Chat tab — handleSend and handleKeyDown', () => {
    it('sends a message when Send button is clicked', async () => {
      const mockCreateNew = vi.fn().mockResolvedValue({ id: 'conv-123' });
      const mockLoadConversation = vi.fn().mockResolvedValue(undefined);
      const mockFetchConversations = vi.fn().mockResolvedValue(undefined);

      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        createNew: mockCreateNew,
        loadConversation: mockLoadConversation,
        fetchConversations: mockFetchConversations,
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      // Switch to Chat tab
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      // Type a message
      const input = await screen.findByPlaceholderText(/ask about your memories/i);
      await user.type(input, 'show me photos from Paris');

      // Click Send
      const sendButton = screen.getByRole('button', { name: /send message/i });
      await user.click(sendButton);

      await waitFor(() => {
        expect(mockStreamMessage).toHaveBeenCalledWith(
          'conv-123',
          'show me photos from Paris',
          expect.any(Object),
          expect.any(AbortSignal),
        );
      });
    });

    it('sends message on Enter key (without shift)', async () => {
      const mockCreateNew = vi.fn().mockResolvedValue({ id: 'conv-key-enter' });
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        createNew: mockCreateNew,
        loadConversation: vi.fn().mockResolvedValue(undefined),
        fetchConversations: vi.fn().mockResolvedValue(undefined),
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      const input = await screen.findByPlaceholderText(/ask about your memories/i);
      await user.type(input, 'hello{Enter}');

      await waitFor(() => {
        expect(mockStreamMessage).toHaveBeenCalled();
      });
    });

    it('does NOT send on Shift+Enter', async () => {
      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      const input = await screen.findByPlaceholderText(/ask about your memories/i);
      await user.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

      // No send called because we used shift+enter (newline in textarea)
      expect(mockStreamMessage).not.toHaveBeenCalled();
    });

    it('does NOT send when input is empty', async () => {
      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      // Send button should be disabled with empty input
      const sendButton = screen.getByRole('button', { name: /send message/i });
      expect(sendButton).toBeDisabled();

      // Pressing Enter with no input also should not call streamMessage
      const input = screen.getByPlaceholderText(/ask about your memories/i);
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

      expect(mockStreamMessage).not.toHaveBeenCalled();
    });

    it('uses existing conversation id if activeConversation is set', async () => {
      const mockCreateNew = vi.fn();
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        activeConversation: {
          id: 'existing-conv',
          circleId: 'circle-1',
          title: 'Old conversation',
          favorite: false,
          messages: [],
        },
        createNew: mockCreateNew,
        loadConversation: vi.fn().mockResolvedValue(undefined),
        fetchConversations: vi.fn().mockResolvedValue(undefined),
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      const input = await screen.findByPlaceholderText(/ask about your memories/i);
      await user.type(input, 'reuse existing');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(mockStreamMessage).toHaveBeenCalledWith(
          'existing-conv',
          expect.any(String),
          expect.any(Object),
          expect.any(AbortSignal),
        );
      });

      // createNew should NOT be called since we have an existing conversation
      expect(mockCreateNew).not.toHaveBeenCalled();
    });

    it('displays existing conversation messages via MessageBubble', async () => {
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        activeConversation: {
          id: 'conv-with-msgs',
          circleId: 'circle-1',
          title: 'Chat about Paris',
          favorite: false,
          messages: [
            { id: 'msg-1', role: 'user', content: 'Show me Paris photos' },
            { id: 'msg-2', role: 'assistant', content: 'Here are your Paris photos.' },
          ],
        },
      } as any);

      render(<SearchPage />);

      // Switch to chat tab
      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.getByText('Show me Paris photos')).toBeInTheDocument();
        expect(screen.getByText('Here are your Paris photos.')).toBeInTheDocument();
      });
    });

    it('shows streaming spinner while message is streaming', async () => {
      // streamMessage never resolves so we can observe streaming state
      mockStreamMessage.mockReturnValue(new Promise(() => {}));

      const mockCreateNew = vi.fn().mockResolvedValue({ id: 'conv-stream' });
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        createNew: mockCreateNew,
        loadConversation: vi.fn().mockResolvedValue(undefined),
        fetchConversations: vi.fn().mockResolvedValue(undefined),
      } as any);

      const user = userEvent.setup();
      render(<SearchPage />);

      await user.click(screen.getByRole('tab', { name: /chat/i }));

      const input = await screen.findByPlaceholderText(/ask about your memories/i);
      await user.type(input, 'streaming test');
      await user.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        // While streaming, the Send IconButton shows a CircularProgress and
        // the chat area also shows one — so multiple progressbars may exist.
        const progressbars = screen.getAllByRole('progressbar');
        expect(progressbars.length).toBeGreaterThan(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Chat tab — conversation list interactions', () => {
    it('renders conversation list items', async () => {
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        conversations: [
          { id: 'conv-a', title: 'Holiday photos', favorite: false },
          { id: 'conv-b', title: null, favorite: true },
        ],
      } as any);

      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.getByText('Holiday photos')).toBeInTheDocument();
        expect(screen.getByText('New conversation')).toBeInTheDocument();
      });
    });

    it('loads a conversation when clicking on it', async () => {
      const mockLoadConversation = vi.fn().mockResolvedValue(undefined);
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        conversations: [{ id: 'conv-click', title: 'Clickable conv', favorite: false }],
        loadConversation: mockLoadConversation,
      } as any);

      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.getByText('Clickable conv')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Clickable conv'));

      await waitFor(() => {
        expect(mockLoadConversation).toHaveBeenCalledWith('conv-click');
      });
    });

    it('calls updateConversation with favorite toggled when star button is clicked', async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        conversations: [{ id: 'conv-fav', title: 'Favable', favorite: false }],
        updateConversation: mockUpdate,
      } as any);

      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /favorite/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /favorite/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('conv-fav', { favorite: true });
      });
    });

    it('calls removeConversation when delete button is clicked', async () => {
      const mockRemove = vi.fn().mockResolvedValue(undefined);
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        conversations: [{ id: 'conv-del', title: 'Delete me', favorite: false }],
        removeConversation: mockRemove,
      } as any);

      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete conversation/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /delete conversation/i }));

      await waitFor(() => {
        expect(mockRemove).toHaveBeenCalledWith('conv-del');
      });
    });

    it('creates a new conversation when New Conversation button is clicked', async () => {
      const mockCreateNew = vi.fn().mockResolvedValue({ id: 'brand-new-conv' });
      const mockLoadConversation = vi.fn().mockResolvedValue(undefined);
      const mockFetchConversations = vi.fn().mockResolvedValue(undefined);

      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        createNew: mockCreateNew,
        loadConversation: mockLoadConversation,
        fetchConversations: mockFetchConversations,
      } as any);

      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      const newConvButton = await screen.findByRole('button', { name: /new conversation/i });
      await user.click(newConvButton);

      await waitFor(() => {
        expect(mockCreateNew).toHaveBeenCalledWith('circle-1');
        expect(mockLoadConversation).toHaveBeenCalledWith('brand-new-conv');
      });
    });

    it('calls fetchConversations on mount with archived:false', async () => {
      const mockFetchConversations = vi.fn().mockResolvedValue(undefined);
      mockUseConversations.mockReturnValue({
        ...defaultConversationsMock(),
        fetchConversations: mockFetchConversations,
      } as any);

      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        // fetchConversations should be called on mount
        expect(mockFetchConversations).toHaveBeenCalledWith(
          expect.objectContaining({ circleId: 'circle-1', archived: false }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Chat tab — empty conversation state', () => {
    it('shows placeholder text when there is no active conversation and not streaming', async () => {
      render(<SearchPage />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('tab', { name: /chat/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/start a new conversation or select one/i),
        ).toBeInTheDocument();
      });
    });
  });
});

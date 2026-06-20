/**
 * Unit tests — SearchContext / SearchProvider / useSearch
 *
 * Tests cover:
 *   - runAgentSearch: appends user message, calls streamAgent with full
 *     message history, sets results from onResults, appends assistant
 *     message from onDone.
 *   - Refine mode: calling runAgentSearch a second time sends BOTH prior
 *     messages AND the new user message (full history).
 *   - runAdvancedResults: sets results + clears messages.
 *   - clearSearch: resets messages, results, error, isSearching.
 *   - Circle change: resets state when activeCircleId changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE any imports of the mocked modules
// ---------------------------------------------------------------------------

// streamAgent is the SSE client — mock it so tests don't make real network calls.
vi.mock('../../services/searchAgentStream', () => ({
  streamAgent: vi.fn(),
}));

// useCircle is used inside SearchProvider to react to circle changes.
vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { SearchProvider, useSearch } from '../../contexts/SearchContext';
import { streamAgent } from '../../services/searchAgentStream';
import { useCircle } from '../../hooks/useCircle';
import type { MediaItem, MediaListMeta } from '../../types/media';

const mockStreamAgent = vi.mocked(streamAgent);
const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultCircle = { id: 'circle-1', name: 'Test Circle' };

function makeCircle(overrides: Partial<typeof defaultCircle> = {}) {
  return { ...defaultCircle, ...overrides };
}

function defaultCircleMock(circleId: string = 'circle-1') {
  const circle = makeCircle({ id: circleId });
  return {
    circles: [circle],
    activeCircle: circle,
    activeCircleId: circleId,
    activeCircleRole: 'circle_admin' as const,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
  };
}

function makeResultsPayload(items: MediaItem[] = []): { items: MediaItem[]; meta: MediaListMeta } {
  return {
    items,
    meta: { page: 1, pageSize: items.length, totalItems: items.length, totalPages: 1 },
  };
}

/** Render the hook inside a SearchProvider + MemoryRouter (SearchContext needs navigate). */
function renderSearchHook(initialPath = '/') {
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <SearchProvider>{children}</SearchProvider>
      </MemoryRouter>
    );
  }
  return renderHook(() => useSearch(), { wrapper });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SearchContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(defaultCircleMock() as any);
    // Default: streamAgent resolves immediately (no-op)
    mockStreamAgent.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts with empty messages, no results, not searching, no error', () => {
      const { result } = renderSearchHook();

      expect(result.current.messages).toEqual([]);
      expect(result.current.results).toBeNull();
      expect(result.current.isSearching).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // runAgentSearch
  // -------------------------------------------------------------------------
  describe('runAgentSearch', () => {
    it('appends the user message to history', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('cats');
      });

      await waitFor(() => {
        expect(result.current.isSearching).toBe(false);
      });

      expect(result.current.messages).toContainEqual({ role: 'user', content: 'cats' });
    });

    it('calls streamAgent with the user message in the messages array', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('cats');
      });

      await waitFor(() => {
        expect(mockStreamAgent).toHaveBeenCalledOnce();
      });

      const [body] = mockStreamAgent.mock.calls[0];
      expect(body.circleId).toBe('circle-1');
      expect(body.messages).toContainEqual({ role: 'user', content: 'cats' });
    });

    it('sets results from the onResults callback', async () => {
      const payload = makeResultsPayload();
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onResults?.(payload);
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('cats');
      });

      await waitFor(() => {
        expect(result.current.results).not.toBeNull();
      });

      expect(result.current.results?.items).toEqual(payload.items);
    });

    it('appends assistant message from text tokens on done', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onToken?.('Here are ');
        handlers.onToken?.('your photos.');
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('show me photos');
      });

      await waitFor(() => {
        expect(result.current.isSearching).toBe(false);
      });

      const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.content).toBe('Here are your photos.');
    });

    it('sets isSearching to true while streaming and false when done', async () => {
      let doneCb: (() => void) | undefined;
      mockStreamAgent.mockImplementation(
        (_body, handlers) =>
          new Promise<void>((resolve) => {
            doneCb = () => {
              handlers.onDone?.();
              resolve();
            };
          }),
      );

      const { result } = renderSearchHook();

      act(() => {
        result.current.runAgentSearch('dogs');
      });

      // Should be searching right after call
      expect(result.current.isSearching).toBe(true);

      // Complete the stream
      await act(async () => {
        doneCb?.();
      });

      expect(result.current.isSearching).toBe(false);
    });

    it('sets error when onError is called', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onError?.({ message: 'Provider unavailable' });
      });

      const { result } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('dogs');
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Provider unavailable');
      });
    });

    // -----------------------------------------------------------------------
    // Refine mode — second call sends full prior history + new message
    // -----------------------------------------------------------------------
    it('sends full history (prior + new user msg) on the second call (refine mode)', async () => {
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onToken?.('First answer.');
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      // First search
      await act(async () => {
        result.current.runAgentSearch('cats');
      });
      await waitFor(() => expect(result.current.isSearching).toBe(false));

      // Reset streamAgent mock for the second call
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onToken?.('Refined answer.');
        handlers.onDone?.();
      });

      // Second search (refine)
      await act(async () => {
        result.current.runAgentSearch('show only outdoor cats');
      });
      await waitFor(() => expect(result.current.isSearching).toBe(false));

      // The second call should include the prior user + assistant messages
      expect(mockStreamAgent).toHaveBeenCalledTimes(2);
      const secondCallMessages = mockStreamAgent.mock.calls[1][0].messages;
      // History should contain both prior messages and the new user message
      const roles = secondCallMessages.map((m: { role: string }) => m.role);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
      // The last message is the new query
      expect(secondCallMessages[secondCallMessages.length - 1]).toEqual({
        role: 'user',
        content: 'show only outdoor cats',
      });
    });
  });

  // -------------------------------------------------------------------------
  // runAdvancedResults
  // -------------------------------------------------------------------------
  describe('runAdvancedResults', () => {
    it('sets results and clears messages', async () => {
      // First: run an agent search so we have messages
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onToken?.('hello');
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('dogs');
      });
      await waitFor(() => expect(result.current.isSearching).toBe(false));

      // Confirm messages exist
      expect(result.current.messages.length).toBeGreaterThan(0);

      // Now call runAdvancedResults
      const items: MediaItem[] = [];
      await act(async () => {
        result.current.runAdvancedResults(items, 3);
      });

      expect(result.current.results?.meta.totalItems).toBe(3);
      expect(result.current.messages).toEqual([]);
      expect(result.current.isSearching).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // clearSearch
  // -------------------------------------------------------------------------
  describe('clearSearch', () => {
    it('resets results, messages, error, and isSearching', async () => {
      const payload = makeResultsPayload();
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onResults?.(payload);
        handlers.onDone?.();
      });

      const { result } = renderSearchHook();

      // Build up some state
      await act(async () => {
        result.current.runAgentSearch('birds');
      });
      await waitFor(() => expect(result.current.results).not.toBeNull());

      // Clear
      act(() => {
        result.current.clearSearch();
      });

      expect(result.current.messages).toEqual([]);
      expect(result.current.results).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.isSearching).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Circle change resets state
  // -------------------------------------------------------------------------
  describe('circle change', () => {
    it('resets state when activeCircleId changes', async () => {
      const payload = makeResultsPayload();
      mockStreamAgent.mockImplementation(async (_body, handlers) => {
        handlers.onResults?.(payload);
        handlers.onDone?.();
      });

      // Start with circle-1
      const { result, rerender } = renderSearchHook();

      await act(async () => {
        result.current.runAgentSearch('flowers');
      });
      await waitFor(() => expect(result.current.results).not.toBeNull());

      // Switch to circle-2 — update the useCircle mock and re-render
      mockUseCircle.mockReturnValue(defaultCircleMock('circle-2') as any);
      rerender();

      await waitFor(() => {
        expect(result.current.results).toBeNull();
        expect(result.current.messages).toEqual([]);
      });
    });
  });
});

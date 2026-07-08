import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  ReactNode,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useCircle } from '../hooks/useCircle';
import { streamAgent } from '../services/searchAgentStream';
import type { ChatMsg } from '../services/searchAgentStream';
import type { SearchRequest } from '../services/search';
import type { MediaItem, MediaListMeta } from '../types/media';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResults {
  items: MediaItem[];
  meta: MediaListMeta;
}

interface SearchContextValue {
  messages: ChatMsg[];
  results: SearchResults | null;
  /**
   * Deterministic (advanced) search request. When set, SearchPage renders the
   * results grid in FEED (infinite-scroll) mode, letting MediaGallery's fetcher
   * own paging. Mutually exclusive with the agentic `results` batch.
   */
  searchRequest: SearchRequest | null;
  isSearching: boolean;
  error: string | null;
  runAgentSearch: (query: string) => void;
  runDeterministicSearch: (request: SearchRequest) => void;
  clearSearch: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const SearchContext = createContext<SearchContextValue | null>(null);

interface SearchProviderProps {
  children: ReactNode;
}

export function SearchProvider({ children }: SearchProviderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { activeCircle, activeCircleId } = useCircle();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Reset session when active circle changes
  useEffect(() => {
    setMessages([]);
    setResults(null);
    setSearchRequest(null);
    setError(null);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [activeCircleId]);

  const runAgentSearch = useCallback(
    (query: string) => {
      if (!query.trim() || !activeCircle) return;

      // Abort any in-flight search
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      const userMsg: ChatMsg = { role: 'user', content: query.trim() };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      // Agentic and deterministic paths are mutually exclusive.
      setSearchRequest(null);
      setIsSearching(true);
      setError(null);

      let finalText = '';

      const run = async () => {
        try {
          await streamAgent(
            { circleId: activeCircle.id, messages: nextMessages },
            {
              onToken: (chunk) => {
                finalText += chunk;
              },
              onResults: (data) => {
                setResults(data);
              },
              onDone: () => {
                if (finalText) {
                  setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', content: finalText },
                  ]);
                }
                setIsSearching(false);
              },
              onError: (data) => {
                setError(data.message);
                setIsSearching(false);
              },
            },
            abort.signal,
          );
        } catch (err) {
          if (err instanceof Error && err.name !== 'AbortError') {
            setError(err.message);
          }
          setIsSearching(false);
        }
      };

      void run();

      // Navigate to /search if not already there
      if (location.pathname !== '/search') {
        navigate('/search');
      }
    },
    [activeCircle, messages, navigate, location.pathname],
  );

  const runDeterministicSearch = useCallback(
    (request: SearchRequest) => {
      // Abort any in-flight agent search
      abortRef.current?.abort();
      abortRef.current = null;

      // Paging is owned by the gallery's fetcher — strip any page/pageSize so
      // the stored request is a stable, page-agnostic query key.
      const { page: _page, pageSize: _pageSize, ...rest } = request;
      void _page;
      void _pageSize;

      setSearchRequest(rest);
      // Deterministic and agentic paths are mutually exclusive.
      setResults(null);
      setMessages([]);
      setIsSearching(false);
      setError(null);

      if (location.pathname !== '/search') {
        navigate('/search');
      }
    },
    [navigate, location.pathname],
  );

  const clearSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setResults(null);
    setSearchRequest(null);
    setError(null);
    setIsSearching(false);
  }, []);

  return (
    <SearchContext.Provider
      value={{
        messages,
        results,
        searchRequest,
        isSearching,
        error,
        runAgentSearch,
        runDeterministicSearch,
        clearSearch,
      }}
    >
      {children}
    </SearchContext.Provider>
  );
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) {
    throw new Error('useSearch must be used within a SearchProvider');
  }
  return ctx;
}

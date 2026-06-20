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
  isSearching: boolean;
  error: string | null;
  runAgentSearch: (query: string) => void;
  runAdvancedResults: (items: MediaItem[], total: number) => void;
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
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Reset session when active circle changes
  useEffect(() => {
    setMessages([]);
    setResults(null);
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

  const runAdvancedResults = useCallback(
    (items: MediaItem[], total: number) => {
      // Abort any in-flight agent search
      abortRef.current?.abort();
      abortRef.current = null;

      const meta: MediaListMeta = {
        page: 1,
        pageSize: items.length,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / Math.max(items.length, 1))),
      };
      setResults({ items, meta });
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
    setError(null);
    setIsSearching(false);
  }, []);

  return (
    <SearchContext.Provider
      value={{
        messages,
        results,
        isSearching,
        error,
        runAgentSearch,
        runAdvancedResults,
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

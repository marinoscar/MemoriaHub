/**
 * PageSearchBar — the search input that lives IN the page, not in the toolbar.
 *
 * `TopbarSearch` is toolbar chrome and is gated to `md`+ (spec §4.1: below `md`
 * Search is a bottom-bar destination rather than a top-bar field). That gate is
 * only sound if the destination itself owns an equivalent input — otherwise the
 * only entry point to free-text/agentic search AND the only opener of
 * `SearchPanel` disappear below 900px, which is exactly the outage issue #400
 * records. This component is that input: mounted by `SearchPage`, it makes
 * `/search` self-sufficient at every breakpoint.
 *
 * It deliberately encapsulates BOTH search capabilities so a page that mounts it
 * needs nothing else:
 *   1. free-text / semantic / agentic search  → `runAgentSearch(query)`
 *   2. advanced (deterministic) search        → `SearchPanel` → `runDeterministicSearch(req)`
 *
 * The submit / clear / advanced logic mirrors `TopbarSearch` exactly so the two
 * entry points cannot drift in behaviour. `TopbarSearch` is intentionally left
 * untouched — this is additive.
 */

import { useCallback, useRef, useState } from 'react';
import { Box, IconButton, InputBase, Paper, Tooltip } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import TuneIcon from '@mui/icons-material/Tune';
import ClearIcon from '@mui/icons-material/Close';
import { useCircle } from '../../hooks/useCircle';
import { useSearch } from '../../contexts/SearchContext';
import { SearchPanel } from './SearchPanel';

export interface PageSearchBarProps {
  /** Pre-fill the field (e.g. restoring the query behind a results view). */
  initialQuery?: string;
  /** Focus the input on mount. Off by default — a page-level autofocus on a
   *  phone pops the keyboard over the content the user just navigated to. */
  autoFocus?: boolean;
}

export function PageSearchBar({
  initialQuery = '',
  autoFocus = false,
}: PageSearchBarProps) {
  const { activeCircle, activeCircleId } = useCircle();
  const { runAgentSearch, runDeterministicSearch } = useSearch();

  const [input, setInput] = useState(initialQuery);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Same guard as TopbarSearch: an empty query or no active circle is a no-op,
  // never an error state — SearchContext.runAgentSearch bails on both anyway.
  const handleSubmit = useCallback(() => {
    const q = input.trim();
    if (!q || !activeCircle) return;
    runAgentSearch(q);
    // Keep the text so the user can see what they searched.
  }, [input, activeCircle, runAgentSearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleClear = useCallback(() => {
    setInput('');
    inputRef.current?.focus();
  }, []);

  const handleAdvancedSubmit = useCallback(
    (request: Parameters<typeof runDeterministicSearch>[0]) => {
      runDeterministicSearch(request);
      setAdvancedOpen(false);
    },
    [runDeterministicSearch],
  );

  const circleId = activeCircleId ?? '';

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          // Full width of the page column, unlike the toolbar pill's capped
          // maxWidth — here the field IS the page's primary affordance.
          width: '100%',
          // minWidth: 0 on every flex context per the issue #291 house rule, so
          // a long value can never widen the app shell.
          minWidth: 0,
          px: 1,
          py: 0.5,
          // 48px comfortable touch target on phone, where this is the only
          // way to search at all.
          minHeight: 48,
          borderRadius: 5,
          bgcolor: 'action.hover',
        }}
      >
        <IconButton
          size="small"
          onClick={handleSubmit}
          disabled={!input.trim() || !activeCircle}
          aria-label="Search"
          sx={{ p: 0.75, flexShrink: 0, color: 'text.secondary' }}
        >
          <SearchIcon fontSize="small" />
        </IconButton>

        <InputBase
          inputRef={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search your photos"
          disabled={!activeCircle}
          autoFocus={autoFocus}
          inputProps={{ 'aria-label': 'Search your photos' }}
          sx={{ flex: 1, minWidth: 0, fontSize: '0.95rem' }}
        />

        {input && (
          <IconButton
            size="small"
            onClick={handleClear}
            aria-label="Clear search"
            sx={{ p: 0.5, flexShrink: 0, color: 'text.secondary' }}
          >
            <ClearIcon fontSize="small" />
          </IconButton>
        )}

        {/* The ONLY opener of SearchPanel below `md`. Wrapped in a <span> so the
            Tooltip still has a live event target while the button is disabled. */}
        <Tooltip title="Advanced search">
          <span style={{ display: 'flex', flexShrink: 0 }}>
            <IconButton
              size="small"
              onClick={() => setAdvancedOpen(true)}
              disabled={!activeCircle}
              aria-label="Advanced search"
              aria-haspopup="dialog"
              sx={{ p: 0.75, color: 'text.secondary' }}
            >
              <TuneIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Paper>

      {/* SearchPanel requires a real circleId to load its facets, so it is only
          mounted once one exists — matching TopbarSearch. */}
      {circleId && (
        <SearchPanel
          open={advancedOpen}
          onClose={() => setAdvancedOpen(false)}
          circleId={circleId}
          onSubmit={handleAdvancedSubmit}
        />
      )}
    </>
  );
}

/** Convenience wrapper: the bar plus the vertical rhythm every SearchPage
 *  branch wants above its own header row. Keeps the four mount sites identical. */
export function PageSearchBarSection(props: PageSearchBarProps) {
  return (
    <Box sx={{ mb: 2, minWidth: 0 }}>
      <PageSearchBar {...props} />
    </Box>
  );
}

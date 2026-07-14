/**
 * TopbarSearch — Immich-style inline search pill for the AppBar.
 *
 * sm+ (tablet/desktop): rounded pill with SearchIcon, InputBase, clear button,
 *   and TuneIcon that opens SearchPanel.
 * xs (phone): a single SearchIcon IconButton; tapping expands a full-width
 *   overlay row with a back button, InputBase, clear and Tune buttons.
 *   Pressing Escape or clicking the back arrow collapses it.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Box,
  InputBase,
  IconButton,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import {
  Search as SearchIcon,
  Tune as TuneIcon,
  Close as ClearIcon,
  ArrowBack as ArrowBackIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useCircle } from '../../hooks/useCircle';
import { useSearch } from '../../contexts/SearchContext';
import { SearchPanel } from './SearchPanel';

export function TopbarSearch() {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  const { activeCircle, activeCircleId } = useCircle();
  const { runAgentSearch, runDeterministicSearch } = useSearch();

  const [input, setInput] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Phone-only: whether the expanding overlay is visible
  const [phoneExpanded, setPhoneExpanded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Collapse phone overlay on Escape
  useEffect(() => {
    if (!phoneExpanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPhoneExpanded(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [phoneExpanded]);

  // Auto-focus when overlay opens
  useEffect(() => {
    if (phoneExpanded) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [phoneExpanded]);

  const handleSubmit = useCallback(() => {
    const q = input.trim();
    if (!q || !activeCircle) return;
    runAgentSearch(q);
    // Keep input text so the user sees what they searched
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
      setPhoneExpanded(false);
    },
    [runDeterministicSearch],
  );

  const circleId = activeCircleId ?? '';

  // -------------------------------------------------------------------------
  // Shared pill content (used in both layouts)
  // -------------------------------------------------------------------------
  const pillContent = (
    <>
      {/* Search icon button (submits on desktop pill; does nothing extra on phone overlay) */}
      <IconButton
        size="small"
        onClick={handleSubmit}
        disabled={!input.trim() || !activeCircle}
        aria-label="Search"
        sx={{ p: 0.75, color: 'text.secondary' }}
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
        inputProps={{ 'aria-label': 'Search your photos' }}
        sx={{ flex: 1, fontSize: '0.9rem', minWidth: 0 }}
      />

      {input && (
        <IconButton
          size="small"
          onClick={handleClear}
          aria-label="Clear search"
          sx={{ p: 0.5, color: 'text.secondary' }}
        >
          <ClearIcon fontSize="small" />
        </IconButton>
      )}

      <Tooltip title="Advanced filters">
        <span>
          <IconButton
            size="small"
            onClick={() => setAdvancedOpen(true)}
            disabled={!activeCircle}
            aria-label="Open advanced search filters"
            sx={{ p: 0.75, color: 'text.secondary' }}
          >
            <TuneIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </>
  );

  // -------------------------------------------------------------------------
  // Phone: icon-only button + expanding overlay
  // -------------------------------------------------------------------------
  if (isPhone) {
    return (
      <>
        {/* Collapsed state: single icon button. Wrapped in a flex-growing Box so
            it claims the Toolbar's remaining width on phone, matching the
            desktop pill's own flexGrow wrapper below — otherwise every phone
            toolbar icon packs to the left with dead space on the right. */}
        {!phoneExpanded && (
          <Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'flex-end' }}>
            <IconButton
              color="inherit"
              aria-label="Open search"
              onClick={() => setPhoneExpanded(true)}
            >
              <SearchIcon />
            </IconButton>
          </Box>
        )}

        {/* Expanded overlay: covers the full toolbar row */}
        {phoneExpanded && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '100%',
              zIndex: 20,
              display: 'flex',
              alignItems: 'center',
              backgroundColor: theme.palette.background.paper,
              px: 1,
              gap: 0.5,
            }}
          >
            <IconButton
              color="inherit"
              aria-label="Close search"
              onClick={() => setPhoneExpanded(false)}
              sx={{ flexShrink: 0 }}
            >
              <ArrowBackIcon />
            </IconButton>

            <Box
              sx={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                borderRadius: 5,
                backgroundColor: theme.palette.action.hover,
                px: 1,
                minWidth: 0,
              }}
            >
              {pillContent}
            </Box>
          </Box>
        )}

        {/* Advanced dialog */}
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

  // -------------------------------------------------------------------------
  // Tablet / desktop: inline pill
  // -------------------------------------------------------------------------
  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexGrow: 1,
          maxWidth: 720,
          mx: 'auto',
          borderRadius: 5,
          backgroundColor: theme.palette.action.hover,
          px: 1,
          py: 0.25,
          minWidth: 0,
        }}
      >
        {pillContent}
      </Box>

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

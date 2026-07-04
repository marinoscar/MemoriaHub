/**
 * tui/DateRangeFilter.tsx — Optional capture-date range filter step.
 *
 * Sits between the sync-flow entry (Sync all / Sync selected) and the live
 * SyncDashboard. Lets the user optionally bound the sync to a capture-date
 * window before the engine runs. Both fields are optional — an empty field
 * means "unbounded that side", and both empty means "all dates".
 *
 * Props: { onApply, onBack }
 *
 * Interaction:
 *   up/down — move focus between the From and To fields
 *   type    — edit the focused field (sanitized to date characters only)
 *   Enter   — apply the parsed range (blocked while invalid)
 *   c       — clear both fields
 *   Esc/q   — back
 *
 * The screen live-validates on every keystroke via parseDateRange() and shows
 * either an inline error (blocking Enter) or a prominent preview line built
 * from describeRange() so the user always sees exactly what will sync.
 *
 * Only date characters (digits, '-', and the ISO extras 'T:.Zz+ ') are allowed
 * into the fields; command keys ('c'/'q') are stripped by the sanitizer, so a
 * command keystroke never lands as text — it only triggers its command.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import {
  parseDateRange,
  describeRange,
  type DateRange,
} from '../sync/date-range.js';
import { BOX_BORDER, GLYPHS } from './theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DateRangeFilterProps {
  onApply: (r: DateRange) => void;
  onBack: () => void;
}

type FocusField = 'from' | 'to';

// Characters legal in a bare `YYYY-MM-DD` date or a full ISO 8601 datetime.
// Everything else (including the command keys 'c'/'q') is stripped so it can
// never appear as typed text in a field.
const DATE_CHARS_RE = /[^\dTZz:.\-+ ]/g;

function sanitize(raw: string): string {
  return raw.replace(DATE_CHARS_RE, '');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DateRangeFilter({
  onApply,
  onBack,
}: DateRangeFilterProps): React.ReactElement {
  const [fromStr, setFromStr] = useState('');
  const [toStr, setToStr]     = useState('');
  const [focus, setFocus]     = useState<FocusField>('from');

  // Live validation + preview — recomputed every render.
  let previewText: string | null = null;
  let errorText: string | null = null;
  let parsedRange: DateRange | null = null;
  try {
    parsedRange = parseDateRange(fromStr || undefined, toStr || undefined);
    previewText = describeRange(parsedRange);
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
  }

  // ---- Field edits: sanitize, and skip no-op writes so a stripped command
  //      key ('c'/'q') never clobbers the command's own state change. ----
  const handleChange = useCallback(
    (which: FocusField, raw: string) => {
      const clean = sanitize(raw);
      if (which === 'from') {
        setFromStr((prev) => (clean === prev ? prev : clean));
      } else {
        setToStr((prev) => (clean === prev ? prev : clean));
      }
    },
    [],
  );

  const handleApply = useCallback(() => {
    // Re-parse defensively; block when the current input is invalid.
    try {
      const r = parseDateRange(fromStr || undefined, toStr || undefined);
      onApply(r);
    } catch {
      // Invalid — do nothing; the inline error already tells the user why.
    }
  }, [fromStr, toStr, onApply]);

  // ---- Global keybindings (arrows/commands; typing goes to TextInput). ----
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onBack();
      return;
    }
    if (input === 'c') {
      setFromStr('');
      setToStr('');
      return;
    }
    if (key.upArrow) {
      setFocus('from');
      return;
    }
    if (key.downArrow) {
      setFocus('to');
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === 'from' ? 'to' : 'from'));
      return;
    }
  });

  const fieldMarker = (field: FocusField): string =>
    focus === field ? GLYPHS.arrow : ' ';

  return (
    <Box
      borderStyle={BOX_BORDER}
      borderColor="cyan"
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">Date range filter</Text>
      <Text dimColor>
        Filter by photo capture date (EXIF, else file date). Leave blank to sync all dates.
      </Text>

      {/* From field */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text color={focus === 'from' ? 'cyan' : undefined}>{fieldMarker('from')}</Text>
        <Text color={focus === 'from' ? 'cyan' : undefined}>From</Text>
        <TextInput
          value={fromStr}
          onChange={(v) => handleChange('from', v)}
          onSubmit={handleApply}
          placeholder="YYYY-MM-DD"
          focus={focus === 'from'}
        />
      </Box>

      {/* To field */}
      <Box flexDirection="row" gap={1}>
        <Text color={focus === 'to' ? 'cyan' : undefined}>{fieldMarker('to')}</Text>
        <Text color={focus === 'to' ? 'cyan' : undefined}>To  </Text>
        <TextInput
          value={toStr}
          onChange={(v) => handleChange('to', v)}
          onSubmit={handleApply}
          placeholder="YYYY-MM-DD"
          focus={focus === 'to'}
        />
      </Box>

      {/* Live preview / validation */}
      <Box marginTop={1}>
        {errorText ? (
          <Text color="red">{GLYPHS.cross} {errorText}</Text>
        ) : (
          <Text color="green">
            {GLYPHS.check} Syncing: <Text bold>{previewText}</Text>
          </Text>
        )}
      </Box>

      {/* Keybindings footer */}
      <Box marginTop={1}>
        <Text dimColor>[up/down] field  [Enter] apply  [c] clear both  [Esc/q] back</Text>
      </Box>
    </Box>
  );
}

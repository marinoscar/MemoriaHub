/**
 * tui/components/EventLog.tsx — Rolling event log.
 *
 * Shows the last N file events with colored glyphs:
 *   ✔ uploaded  ↷ skipped (reason)  ✖ failed: <error>  [will retry / blocked]
 */

import React from 'react';
import { Box, Text } from 'ink';
import { GLYPHS } from '../theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogEventKind = 'done' | 'skipped' | 'failed';

export interface LogEvent {
  id: number;          // fileId — used as React key
  kind: LogEventKind;
  path: string;
  reason?: string;     // skip reason
  error?: string;      // fail message
  willRetry?: boolean;
}

interface EventLogProps {
  events: LogEvent[];
  maxVisible?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Human-friendly labels for known skip reasons; falls back to the raw value. */
const REASON_LABELS: Record<string, string> = {
  out_of_range: 'out of date range',
};

function reasonLabel(reason?: string): string {
  if (!reason) return 'skipped';
  return REASON_LABELS[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventLog({
  events,
  maxVisible = 8,
}: EventLogProps): React.ReactElement | null {
  if (events.length === 0) return null;

  const visible = events.slice(-maxVisible);

  return (
    <Box flexDirection="column">
      <Text bold dimColor>Recent events</Text>
      {visible.map((ev) => {
        const name = truncate(basename(ev.path), 36);
        switch (ev.kind) {
          case 'done':
            return (
              <Box key={ev.id} flexDirection="row" gap={1}>
                <Text color="green">{GLYPHS.check}</Text>
                <Text>{name}</Text>
              </Box>
            );
          case 'skipped':
            return (
              <Box key={ev.id} flexDirection="row" gap={1}>
                <Text color="blue">{GLYPHS.retry}</Text>
                <Text dimColor>{name}</Text>
                <Text dimColor>({reasonLabel(ev.reason)})</Text>
              </Box>
            );
          case 'failed':
            return (
              <Box key={ev.id} flexDirection="row" gap={1}>
                <Text color="red">{GLYPHS.cross}</Text>
                <Text color="red">{name}</Text>
                {ev.error && <Text dimColor>: {truncate(ev.error, 30)}</Text>}
                <Text dimColor>{ev.willRetry ? '— will retry' : '— blocked'}</Text>
              </Box>
            );
        }
      })}
    </Box>
  );
}

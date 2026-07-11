/**
 * tui/NodeLogs.tsx — live JSONL tail viewer for the worker-node log.
 *
 * The CLI already has `memoriahub node logs [-n <n>] [--follow]` (see
 * `logsCmd()` in commands/node.ts), backed by `node/logger.ts`'s
 * `readLastLines`/`followLog`. This screen is the TUI equivalent: it loads a
 * trailing window on mount, then keeps it live via `followLog` — a genuine
 * `tail -f`, not a static dump — until the operator backs out, at which point
 * the returned stop function is called so the underlying `fs.watch` handle is
 * released (no leaked watchers across screen visits).
 *
 * The visible window size ("tail size") is adjustable with [+]/[-] the same
 * way `-n` is on the CLI; changing it re-reads `readLastLines(tailSize)` from
 * disk (cheap — JSONL logs are rotated at 5 MB, see logger.ts) so widening the
 * window can reveal more already-persisted history, not just newly-appended
 * lines. `[c]` clears the pane cosmetically (never touches the file) — handy
 * before triggering an action elsewhere and wanting a clean view of what
 * happens next.
 *
 * Each raw JSONL line is parsed by the pure, independently-testable
 * `parseLogLine()` into a `{ level, time, text }` triple and rendered as one
 * row, colored by level (error=red, warn=yellow, info=default, debug=dim) —
 * matching the log-pane convention established by NodeDashboard.tsx.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { followLog, nodeLogPath, readLastLines, type NodeLogLevel } from '../node/logger.js';
import { BOX_BORDER } from './theme.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeLogsProps {
  /** Pop back to the previous screen/menu. */
  onBack: () => void;
  /** Override the log directory — used by tests; defaults to the standard logs dir. */
  dir?: string;
}

// ---------------------------------------------------------------------------
// Tail-size bounds (mirrors the CLI's `-n, --lines` default of 50)
// ---------------------------------------------------------------------------

export const DEFAULT_TAIL_SIZE = 50;
export const MIN_TAIL_SIZE = 10;
export const MAX_TAIL_SIZE = 500;
const TAIL_STEP = 10;

// ---------------------------------------------------------------------------
// Line parsing/formatting (pure — unit-testable without Ink)
// ---------------------------------------------------------------------------

export interface ParsedLogLine {
  level: NodeLogLevel;
  /** HH:MM:SS extracted from the line's `ts` field, or null if absent/unparseable. */
  time: string | null;
  /** Human-readable rendering of the line (msg / ev / extra fields). */
  text: string;
  /** True when the raw line was not valid JSON (rendered as-is, defensively). */
  malformed: boolean;
}

const GLYPH_BY_LEVEL: Record<NodeLogLevel, string> = {
  error: '✖',
  warn: '⚠',
  info: '·',
  debug: '·',
};

function isNodeLogLevel(v: unknown): v is NodeLogLevel {
  return v === 'error' || v === 'warn' || v === 'info' || v === 'debug';
}

function formatFieldValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[unserializable]';
    }
  }
  return String(v);
}

/**
 * Parse one raw JSONL line written by node/logger.ts (`{ ts, level, ev?,
 * msg?, ...payload }`) into a readable row. Falls back to rendering the raw
 * line (level 'info', malformed:true) when it isn't valid JSON — logger.ts
 * always writes valid JSON in practice, but a torn line mid-rotation/mid-write
 * is possible and must never crash the screen.
 */
export function parseLogLine(raw: string): ParsedLogLine {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { level: 'info', time: null, text: raw, malformed: true };
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return { level: 'info', time: null, text: raw, malformed: true };
  }

  const level: NodeLogLevel = isNodeLogLevel(obj.level) ? obj.level : 'info';

  let time: string | null = null;
  if (typeof obj.ts === 'string') {
    const parsedDate = new Date(obj.ts);
    if (!Number.isNaN(parsedDate.getTime())) {
      time = parsedDate.toTimeString().slice(0, 8);
    }
  }

  const rest: Record<string, unknown> = { ...obj };
  delete rest.ts;
  delete rest.level;
  const msg = typeof rest.msg === 'string' ? rest.msg : null;
  delete rest.msg;
  const ev = typeof rest.ev === 'string' ? rest.ev : null;
  delete rest.ev;

  const extra = Object.keys(rest)
    .map((k) => `${k}=${formatFieldValue(rest[k])}`)
    .join(' ');

  let text: string;
  if (msg && ev) text = `[${ev}] ${msg}`;
  else if (msg) text = msg;
  else if (ev) text = ev;
  else text = '(no message)';
  if (extra) text += `  ${extra}`;

  return { level, time, text, malformed: false };
}

function levelColor(level: NodeLogLevel): string | undefined {
  switch (level) {
    case 'error':
      return 'red';
    case 'warn':
      return 'yellow';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Local line-record model (stable React keys across an append-only buffer)
// ---------------------------------------------------------------------------

interface LineRecord {
  id: number;
  raw: string;
}

let lineSeq = 0;
function toRecords(rawLines: string[]): LineRecord[] {
  return rawLines.map((raw) => ({ id: ++lineSeq, raw }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeLogs({ onBack, dir }: NodeLogsProps): React.ReactElement {
  const [tailSize, setTailSize] = useState<number>(DEFAULT_TAIL_SIZE);
  const [lines, setLines] = useState<LineRecord[]>(() => toRecords(readLastLines(DEFAULT_TAIL_SIZE, dir)));
  const tailSizeRef = useRef(tailSize);
  tailSizeRef.current = tailSize;

  const isFirstRender = useRef(true);

  // Re-read the buffer from disk whenever the tail size changes (widening can
  // reveal more already-persisted history; narrowing just trims the view).
  // Skipped on the very first render since the initial `useState` already did it.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setLines(toRecords(readLastLines(tailSize, dir)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailSize, dir]);

  // Live tail: start once on mount, stop on unmount. New lines are appended
  // and the buffer is trimmed to the CURRENT tail size (via ref, so this
  // effect doesn't need to restart every time the operator presses +/-).
  useEffect(() => {
    const stop = followLog((line) => {
      setLines((prev) => [...prev, { id: ++lineSeq, raw: line }].slice(-tailSizeRef.current));
    }, dir);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const clearView = useCallback((): void => {
    setLines([]);
  }, []);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onBack();
    } else if (input === 'c') {
      clearView();
    } else if (input === '+' || input === '=') {
      setTailSize((n) => Math.min(MAX_TAIL_SIZE, n + TAIL_STEP));
    } else if (input === '-' || input === '_') {
      setTailSize((n) => Math.max(MIN_TAIL_SIZE, n - TAIL_STEP));
    }
  });

  const logPath = nodeLogPath(dir);

  return (
    <Box flexDirection="column" gap={1}>
      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        <Text bold color="cyan">Worker Node — Logs</Text>
        <Text dimColor>
          {logPath}   tail: {tailSize} lines
        </Text>
      </Box>

      <Box borderStyle={BOX_BORDER} borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0}>
        {lines.length === 0 ? (
          <Text dimColor>No log lines yet ({logPath}).</Text>
        ) : (
          lines.map((rec) => {
            const parsed = parseLogLine(rec.raw);
            const color = levelColor(parsed.level);
            const dimmed = parsed.level === 'debug' || parsed.malformed;
            return (
              <Box key={rec.id} flexDirection="row" gap={1}>
                <Text dimColor>{parsed.time ?? '--:--:--'}</Text>
                <Text color={color} dimColor={dimmed}>
                  {GLYPH_BY_LEVEL[parsed.level]}
                </Text>
                <Text color={color} dimColor={dimmed}>
                  {parsed.text}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box paddingX={2}>
        <Text dimColor>
          [+/-] tail size ({tailSize})   [c] clear view   [q] back
        </Text>
      </Box>
    </Box>
  );
}

/**
 * tui/components/Summary.tsx — Post-run summary shown after run:done.
 *
 * Displays uploaded/skipped/failed counts, duration, failures list.
 * Keys: Enter → home, r → retry failed, f → force retry (reset attempt cap).
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { RunStats } from '../../sync/events.js';
import { BOX_BORDER } from '../theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryFailure {
  fileId: number;
  path: string;
  error: string;
}

interface SummaryProps {
  runId: number;
  stats: RunStats;
  durationMs: number;
  failures: SummaryFailure[];
  /** Excel run-report auto-export state. */
  exporting?: boolean;
  exportPath?: string | null;
  exportError?: string | null;
  onHome: () => void;
  /** Retry failed uploads; `force` also resets files blocked at the attempts cap. */
  onRetry: (force?: boolean) => void;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Summary({
  runId,
  stats,
  durationMs,
  failures,
  exporting,
  exportPath,
  exportError,
  onHome,
  onRetry,
}: SummaryProps): React.ReactElement {
  useInput((input, key) => {
    if (key.return || input === 'q') onHome();
    if (input === 'r' && failures.length > 0) onRetry(false);
    if (input === 'f' && failures.length > 0) onRetry(true);
  });

  const secs = (durationMs / 1000).toFixed(1);

  return (
    <Box flexDirection="column" gap={1}>
      {/* Summary box */}
      <Box
        borderStyle={BOX_BORDER}
        borderColor="cyan"
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <Text bold color="cyan">Sync Complete — Run #{runId}</Text>
        <Text> </Text>
        <Box flexDirection="row" gap={4}>
          <Box flexDirection="column">
            <Text color="green">Uploaded</Text>
            <Text bold color="green">{stats.uploaded}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Skipped</Text>
            <Text bold dimColor>{stats.skipped}</Text>
          </Box>
          <Box flexDirection="column">
            <Text color={stats.failed > 0 ? 'red' : undefined} dimColor={stats.failed === 0}>Failed</Text>
            <Text bold color={stats.failed > 0 ? 'red' : undefined} dimColor={stats.failed === 0}>{stats.failed}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Duration</Text>
            <Text bold>{secs}s</Text>
          </Box>
        </Box>
      </Box>

      {/* Failures list */}
      {failures.length > 0 && (
        <Box
          borderStyle={BOX_BORDER}
          borderColor="red"
          flexDirection="column"
          paddingX={2}
          paddingY={1}
        >
          <Text bold color="red">Failed files ({failures.length})</Text>
          {failures.slice(0, 10).map((f) => (
            <Box key={f.fileId} flexDirection="row" gap={1}>
              <Text color="red">✖</Text>
              <Text>{truncate(basename(f.path), 32)}</Text>
              <Text dimColor>: {truncate(f.error, 40)}</Text>
            </Box>
          ))}
          {failures.length > 10 && (
            <Text dimColor>  … and {failures.length - 10} more</Text>
          )}
        </Box>
      )}

      {/* Excel run report */}
      <Box flexDirection="column" paddingLeft={1}>
        {exporting && <Text dimColor>Creating Excel report…</Text>}
        {exportPath && <Text color="green">📄 Excel report: {exportPath}</Text>}
        {exportError && <Text color="yellow">⚠ Excel report failed: {exportError}</Text>}
      </Box>

      {/* Key hints */}
      <Box flexDirection="row" gap={3} paddingLeft={1}>
        <Text dimColor>[Enter/q] back to home</Text>
        {failures.length > 0 && <Text color="yellow">[r] retry failed</Text>}
        {failures.length > 0 && <Text dimColor>[f] force retry (reset attempt cap)</Text>}
      </Box>
    </Box>
  );
}
